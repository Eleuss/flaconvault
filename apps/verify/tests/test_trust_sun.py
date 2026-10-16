"""SUN/SDM crypto core under production keys (sdmbackend, legacy and standard derivation, non-zero master), input
bounds, the LRP gate, crypto outside the write lock, dead seals on /t, tap storage and the adoption guards."""
import os
import sqlite3
from urllib.parse import parse_qs, urlparse

import pytest
from Crypto.Cipher import AES

from fv import proof, sdm
from fv.config import Settings
from fv.db import upsert_passport, upsert_seal, transaction
from fv.service import authenticate_tap
from libsdm.sdm import ParamMode, calculate_sdmmac
from tests.conftest import TEST_SEED_HEX

MASTER = "00112233445566778899aabbccddeeff"          # an obviously fake test master key (never a real tag's key)
SERIAL = "SN-2026-000500"
UID = "04AABBCCDDEE11"


def prod_settings(tmp_path, derive="legacy", **over) -> Settings:
    kw = dict(server_seed_hex=TEST_SEED_HEX, db_path=tmp_path / "prod.db", media_dir=tmp_path / "media",
              dev_simulator=False, key_mode="sdmbackend", sdm_derive=derive, master_key_hex=MASTER,
              seed_path=tmp_path / "no-seed.json", web_url="http://web.test", verifier_host="http://verify.test",
              reconcile_interval_s=0)
    kw.update(over)
    return Settings(**kw)


def encrypted_tap(settings: Settings, uid_hex: str, ctr: int, enc: bytes | None = None) -> tuple[str, str]:
    """What an NTAG 424 DNA programmed by the NFC Developer App mirrors: picc_data = AES-CBC(meta key, 0xC7‖UID‖ctrLE‖rand)."""
    uid = bytes.fromhex(uid_hex)
    meta = sdm.meta_read_key(settings.key_mode, settings.master_key, settings.sdm_derive)
    file_key = sdm.key_for_uid(settings.key_mode, settings.master_key, uid, settings.sdm_derive)
    ctr_le = ctr.to_bytes(3, "little")
    picc = AES.new(meta, AES.MODE_CBC, IV=bytes(16)).encrypt(b"\xc7" + uid + ctr_le + os.urandom(5))
    mac = calculate_sdmmac(ParamMode.SEPARATED, file_key, uid + ctr_le, enc)
    return picc.hex().upper(), mac.hex().upper()


def plain_tap(settings: Settings, uid_hex: str, ctr: int) -> dict:
    uid = bytes.fromhex(uid_hex)
    key = sdm.key_for_uid(settings.key_mode, settings.master_key, uid, settings.sdm_derive)
    return {"uid": uid_hex, "ctr": sdm.ctr_hex(ctr), "cmac": sdm.sdm_cmac(uid, ctr, key).hex().upper()}


@pytest.fixture(params=["legacy", "standard"])
def prod(request, tmp_path):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    st = prod_settings(tmp_path, request.param)
    app = create_app(st)
    with TestClient(app) as c:
        with app.state.db.connect() as conn, transaction(conn):
            upsert_passport(conn, serial=SERIAL, serial_hash=proof.serial_hash(SERIAL).hex(), brand="B", name="N", batch=None,
                            asset=None, issuer=None, issuer_label=None, grade=0, void=False, created_at=1)
            upsert_seal(conn, uid_hash=proof.uid_hash(bytes.fromhex(UID)).hex(), uid_hex=UID, serial=SERIAL, kind=1, attached_at=1)
        c.st = st
        yield c


def _verify(c, **tap):
    nonce = c.post("/api/session", json={}).json()["nonce"]
    return c.post("/api/verify", json={**tap, "nonce": nonce, "role": 0, "tier": 1, "indicators": {"heat": 3, "humidity": 3, "uv": 3},
                                       "heatLevels": [0] * 6, "fill": 90}).json()


def test_production_key_path_end_to_end(prod):
    """sdmbackend + non-zero master: encrypted and plain taps verify, are signed, and null-key forgeries are refused."""
    c, st = prod, prod.st
    assert sdm.meta_read_key(st.key_mode, st.master_key, st.sdm_derive) != sdm.key_for_uid(st.key_mode, st.master_key, bytes.fromhex(UID), st.sdm_derive)
    picc, mac = encrypted_tap(st, UID, 7)
    t = c.get(f"/t?picc_data={picc}&cmac={mac}&format=json").json()
    assert t["verdict"] == "VALID" and t["counter"] == 7 and t["serial"] == SERIAL and t["tapToken"]
    v = c.post("/api/verify", json={"tapId": t["tapId"], "tapToken": t["tapToken"], "nonce": c.post("/api/session", json={}).json()["nonce"],
                                    "role": 0, "tier": 1, "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6,
                                    "fill": 90}).json()
    assert v["verdict"] == "VALID" and v["counter"] == 7 and v["serverSig"]
    # encrypted with an enc block (/tagtt form): the MAC covers it
    picc, mac = encrypted_tap(st, UID, 8, enc=bytes(range(16)))
    assert _verify(c, piccData=picc, cmac=mac, enc=bytes(range(16)).hex())["verdict"] == "VALID"
    assert _verify(c, piccData=picc, cmac=mac, enc=bytes(16).hex())["verdict"] == "INVALID"      # enc altered
    # plain mirror under the same derivation
    assert _verify(c, **plain_tap(st, UID, 9))["verdict"] == "VALID"
    # the AN12196 null-key vector and a null-key plain forgery are not genuine here
    assert c.get("/t?picc_data=EF963FF7828658A599F3041510671E88&cmac=94EED9EE65337086&format=json").json()["verdict"] == "INVALID"
    forged = {"uid": UID, "ctr": "001388", "cmac": sdm.sdm_cmac(bytes.fromhex(UID), 5000, bytes(16)).hex().upper()}
    assert _verify(c, **forged)["verdict"] == "INVALID"
    assert c.get(f"/api/passport/{SERIAL}").json()["seals"][0]["lastCounter"] == 9          # the forgery did not burn the counter


def test_meta_and_file_keys_are_not_interchangeable(tmp_path):
    """Swapping the meta read key and the per-tag file key must break every real tap (would survive null-key tests)."""
    st = prod_settings(tmp_path)
    picc, mac = encrypted_tap(st, UID, 3)
    good = sdm.decrypt_tap(st.key_mode, st.master_key, bytes.fromhex(picc), bytes.fromhex(mac), None, st.sdm_derive)
    assert good == (bytes.fromhex(UID), 3)
    other = prod_settings(tmp_path, derive="standard")
    assert sdm.decrypt_tap(other.key_mode, other.master_key, bytes.fromhex(picc), bytes.fromhex(mac), None, other.sdm_derive) is None
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex(picc), bytes.fromhex(mac), None) is None


def test_lrp_picc_data_is_refused_unless_enabled(tmp_path):
    st = prod_settings(tmp_path)
    calls = []
    real = sdm.decrypt_tap
    import fv.service as svc
    svc.decrypt_tap, saved = (lambda *a, **k: calls.append(1) or real(*a, **k)), svc.decrypt_tap
    try:
        a = authenticate_tap(st, None, None, "00" * 8, picc_data="AB" * 24)
        assert a.invalid and "LRP" in a.invalid.error and calls == []      # refused before any crypto
        st.sdm_lrp = True                                                   # a deployment that really uses LRP tags
        a = authenticate_tap(st, None, None, "00" * 8, picc_data="AB" * 24)
        assert a.invalid and a.invalid.error == "bad cmac" and calls == [1]
    finally:
        svc.decrypt_tap = saved


def test_tag_parameters_are_bounded_before_any_work(tmp_path):
    st = prod_settings(tmp_path)
    picc, mac = encrypted_tap(st, UID, 3)
    for kw in ({"picc_data": picc + "00" * 9}, {"picc_data": picc, "enc": "00" * 33}):
        a = authenticate_tap(st, None, None, mac, **kw)
        assert a.invalid and "too long" in a.invalid.error, kw
    assert "multiple of 16" in authenticate_tap(st, None, None, mac, picc_data=picc, enc="00" * 15).invalid.error
    assert authenticate_tap(st, "04" * 40, "000001", "00" * 8).invalid.error == "uid/ctr/cmac too long"
    # libsdm itself refuses oversized SDMENCFileData before any MAC work
    from libsdm.sdm import InvalidMessage, decrypt_sun_message
    with pytest.raises(InvalidMessage, match="too long"):
        decrypt_sun_message(param_mode=ParamMode.SEPARATED, sdm_meta_read_key=bytes(16), sdm_file_read_key=lambda _: bytes(16),
                            picc_enc_data=bytes(16), sdmmac=bytes(8), enc_file_data=bytes(16 * 9))


def test_api_bodies_bound_picc_and_enc(client):
    nonce = client.post("/api/session", json={}).json()["nonce"]
    body = {"cmac": "00" * 8, "nonce": nonce, "role": 0, "tier": 1, "indicators": {"heat": 3, "humidity": 3, "uv": 3},
            "heatLevels": [0] * 6, "fill": 90}
    assert client.post("/api/verify", json={**body, "piccData": "AB" * 64}).status_code == 422
    assert client.post("/api/verify", json={**body, "piccData": "AB" * 16, "enc": "00" * 1024}).status_code == 422
    assert client.post("/api/preview", json={"cmac": "00" * 8, "piccData": "AB" * 16, "enc": "00" * 4096}).status_code == 422
    assert client.post("/api/preview", json={"cmac": "00" * 8, "uid": "04A1B2C3D4E5F6", "ctr": "0" * 40}).status_code == 422


def test_crypto_runs_outside_the_write_transaction(prod, monkeypatch):
    """Key derivation / decryption for /t and /api/verify happen while the SQLite write lock is free."""
    import fv.service as svc
    c, st = prod, prod.st
    probes = []
    real = svc.decrypt_tap

    def probing(*a, **k):
        probe = sqlite3.connect(st.db_path, timeout=0, isolation_level=None)
        try:
            probe.execute("BEGIN IMMEDIATE")
            probe.execute("ROLLBACK")
            probes.append(True)
        except sqlite3.OperationalError:
            probes.append(False)
        finally:
            probe.close()
        return real(*a, **k)
    monkeypatch.setattr(svc, "decrypt_tap", probing)
    picc, mac = encrypted_tap(st, UID, 21)
    assert c.get(f"/t?picc_data={picc}&cmac={mac}&format=json").json()["verdict"] == "VALID"
    picc, mac = encrypted_tap(st, UID, 22)
    assert _verify(c, piccData=picc, cmac=mac)["verdict"] == "VALID"
    assert probes == [True, True]


# ---------- /t ----------

def test_t_dead_seal_answers_no_response(client):
    tag = client.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    with client.app.state.db.connect() as conn:
        conn.execute("UPDATE seals SET dead=1 WHERE uid_hex=?", (tag["uid"],))
    before = client.get("/api/passport/SN-2026-000001").json()
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    j = client.get(tap["url"] + "&format=json").json()
    assert j["verdict"] == "NO_RESPONSE" and j["message"] == "Seal not responding" and j["sealDead"] is True
    assert "tapToken" not in j
    assert client.get(f"/api/tap/{j['tapId']}").json()["verdict"] == "NO_RESPONSE"
    after = client.get("/api/passport/SN-2026-000001").json()
    assert len(after["events"]) == len(before["events"]) and after["stats"] == before["stats"]   # no sighting
    # the redirect carries no adoption token either
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    r = client.get(tap["url"], follow_redirects=False)
    assert "k" not in parse_qs(urlparse(r.headers["location"]).query)


def test_t_without_a_chip_uid_is_not_stored(client):
    with client.app.state.db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM taps").fetchone()[0]
    for q in ("", "?uid=zz&ctr=1&cmac=2", "?picc_data=zz&cmac=00", "?picc_data=" + "AB" * 16):
        assert client.get(f"/t{q}", headers={"Accept": "application/json"}).json()["tapId"] is None, q
    r = client.get("/t", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "http://web.test/t"
    with client.app.state.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM taps").fetchone()[0] == n
    # a bad CMAC for a real-looking UID is stored (the web shows "not confirmed"), with a random id
    j = client.get("/t?uid=04A1B2C3D4E5F6&ctr=0000FF&cmac=0000000000000000&format=json").json()
    assert j["verdict"] == "INVALID" and j["tapId"] >= 1 << 32


def test_tap_ids_are_random_and_bounded(client):
    tag = client.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    ids = []
    for _ in range(3):
        tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
        ids.append(client.get(tap["url"] + "&format=json").json()["tapId"])
    assert all((1 << 32) <= i < (1 << 53) for i in ids) and sorted(ids) != [ids[0], ids[0] + 1, ids[0] + 2]
    assert client.get(f"/api/tap/{ids[0] + 1}").status_code == 404
    assert client.get("/api/tap/99999999999999999999").status_code == 422      # beyond SQLite INTEGER: no 500
    assert client.get("/api/tap/0").status_code == 422


def test_invalid_taps_are_purged_after_a_day(client):
    import fv.routes_tag as rt
    j = client.get("/t?uid=04A1B2C3D4E5F6&ctr=0000FF&cmac=0000000000000000&format=json").json()
    with client.app.state.db.connect() as conn:
        conn.execute("UPDATE taps SET ts=ts-? WHERE id=?", (rt.INVALID_TAP_RETENTION_S + 10, j["tapId"]))
    rt._last_purge[0] = float("-inf")
    client.get("/t?uid=04A1B2C3D4E5F6&ctr=0000FE&cmac=0000000000000000&format=json")
    assert client.get(f"/api/tap/{j['tapId']}").status_code == 404


# ---------- adoption and counter-seeding guards (mutations of these must fail a test) ----------

def _t_tap(client, uid):
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    j = client.get(tap["url"] + "&format=json").json()
    return j["tapId"], j.get("tapToken")


def _adopt(client, tap_id, token):
    nonce = client.post("/api/session", json={}).json()["nonce"]
    return client.post("/api/verify", json={"tapId": tap_id, "tapToken": token, "nonce": nonce, "role": 0, "tier": 1,
                                            "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6,
                                            "fill": 92}).json()


def test_adopt_tokens_are_unique_and_bound_to_their_tap(client):
    tag = client.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    id1, tok1 = _t_tap(client, tag["uid"])
    id2, tok2 = _t_tap(client, tag["uid"])
    assert tok1 and tok2 and tok1 != tok2
    assert _adopt(client, id2, tok1)["verdict"] == "INVALID"           # token 1 does not open tap 2
    assert _adopt(client, id1, tok2)["verdict"] == "INVALID"
    assert _adopt(client, id2, tok2)["verdict"] == "VALID"


def test_a_tap_written_by_verify_cannot_be_adopted(client):
    tag = client.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    nonce = client.post("/api/session", json={}).json()["nonce"]
    v = client.post("/api/verify", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 0,
                                         "tier": 1, "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6,
                                         "fill": 92}).json()
    assert v["verdict"] == "VALID"
    with client.app.state.db.connect() as conn:
        row = conn.execute("SELECT id FROM taps WHERE source='verify' AND verdict='VALID' ORDER BY ts DESC LIMIT 1").fetchone()
    for token in (None, "", "x" * 22):
        assert _adopt(client, row["id"], token)["verdict"] == "INVALID"


def test_counter_seeding_ignores_taps_with_a_bad_cmac(client):
    """An INVALID tap with an attacker-chosen ctr must neither block the chip nor seed the attached seal's counter."""
    uid = "04ABCDEF012345"
    client.post("/api/dev/tag", json={"uid": uid})
    assert client.get(f"/t?uid={uid}&ctr=FFFFFF&cmac=0000000000000000&format=json").json()["verdict"] == "INVALID"
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    assert client.get(tap["url"] + "&format=json").json()["verdict"] == "UNREGISTERED"
    t = client.post("/api/dev/tag", json={"uid": uid, "serial": "SN-2026-000002"}).json()
    assert t["sealLastCounter"] == tap["ctr"] != 0xFFFFFF
