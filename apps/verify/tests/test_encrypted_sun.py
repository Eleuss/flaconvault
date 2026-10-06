"""Encrypted SUN (NFC Developer App / sdm-backend `/tag`, `/tagtt`): AN12196 null-key vectors through check_tap, /t,
/api/preview, /api/verify; sdmbackend key derivation (icedevml derive.py)."""
import pytest

from fv import sdm
from fv.config import Settings
from fv.service import check_tap
from libsdm.derive import derive_tag_key, derive_undiversified_key
from libsdm.sdm import ParamMode, decrypt_sun_message

# AN12196 p.12 / p.18 (sdm-backend tests test_sun1 / test_sun2), null keys
SUN1 = {"picc": "EF963FF7828658A599F3041510671E88", "cmac": "94EED9EE65337086", "uid": "04DE5F1EACC040", "ctr": 61}
SUN2 = {"picc": "FD91EC264309878BE6345CBE53BADF40", "cmac": "ECC1E7F6C6C73BF6", "enc": "CEE9A53E3E463EF1F459635736738962", "uid": "04958CAA5C5E80", "ctr": 8}
MASTER = bytes.fromhex("47BBB68AFA73F31310BEEFCE5DDA692DBAD671A03FEAD5A9BBDBCF3CD6D4C521")


def test_decrypt_tap_vectors_factory():
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex(SUN1["picc"]), bytes.fromhex(SUN1["cmac"]), None) == (bytes.fromhex(SUN1["uid"]), 61)
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex(SUN2["picc"]), bytes.fromhex(SUN2["cmac"]), bytes.fromhex(SUN2["enc"])) == (bytes.fromhex(SUN2["uid"]), 8)
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex(SUN2["picc"]), bytes.fromhex("3CC1E7F6C6C33B33"), bytes.fromhex(SUN2["enc"])) is None
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex(SUN1["picc"]), bytes.fromhex("0000000000000000"), None) is None
    # sdmbackend with an all-zero master key derives null keys (derive.py) → same vectors decrypt
    assert sdm.decrypt_tap("sdmbackend", bytes(16), bytes.fromhex(SUN1["picc"]), bytes.fromhex(SUN1["cmac"]), None) == (bytes.fromhex(SUN1["uid"]), 61)
    assert sdm.decrypt_tap("sdmbackend", bytes(16), bytes.fromhex(SUN1["picc"]), bytes.fromhex(SUN1["cmac"]), None, "standard") == (bytes.fromhex(SUN1["uid"]), 61)
    # a real master key: encrypt→decrypt round trip is not available without a tag, but the wrong key must fail cleanly
    assert sdm.decrypt_tap("sdmbackend", MASTER[:16], bytes.fromhex(SUN1["picc"]), bytes.fromhex(SUN1["cmac"]), None) is None


def test_sdmbackend_key_derivation():
    import hashlib
    from libsdm import legacy_derive
    uid, k16 = bytes.fromhex("04c24eda926980"), MASTER[:16]
    # standard (libsdm/derive.py)
    assert sdm.meta_read_key("sdmbackend", k16, "standard") == derive_undiversified_key(k16, 1) != bytes(16)
    assert sdm.key_for_uid("sdmbackend", k16, uid, "standard") == derive_tag_key(k16, uid, 2) != bytes(16)
    # legacy (default; NFC Developer App / sdm-backend DERIVE_MODE="legacy") = pbkdf2-sha512, 5000 rounds, 16 bytes
    assert sdm.key_for_uid("sdmbackend", k16, uid) == legacy_derive.derive_tag_key(k16, uid, 2) == hashlib.pbkdf2_hmac("sha512", k16, b"key" + uid + b"\x02", 5000, 16)
    assert sdm.meta_read_key("sdmbackend", k16) == legacy_derive.derive_undiversified_key(k16, 1) == hashlib.pbkdf2_hmac("sha512", k16, b"key_no_uid\x01", 5000, 16)
    assert sdm.key_for_uid("sdmbackend", k16, uid, "legacy") != sdm.key_for_uid("sdmbackend", k16, uid, "standard")
    assert sdm.key_for_uid("sdmbackend", k16, uid) != sdm.key_for_uid("sdmbackend", k16, bytes.fromhex("04A1B2C3D4E5F6"))
    assert sdm.key_for_uid("sdmbackend", bytes(16), uid) == sdm.key_for_uid("sdmbackend", bytes(16), uid, "standard") == bytes(16)
    assert sdm.meta_read_key("factory", k16) == bytes(16)
    with pytest.raises(ValueError):
        sdm.key_for_uid("sdmbackend", k16, uid, "nope")
    # sdm-backend test_decrypt_with_kdf1 (32-byte master, BULK params) — proves the vendored derive.py is intact
    res = decrypt_sun_message(param_mode=ParamMode.BULK, sdm_meta_read_key=derive_undiversified_key(MASTER, 1),
                              sdm_file_read_key=lambda u: derive_tag_key(MASTER, u, 2),
                              picc_enc_data=bytes.fromhex("8DE9030262807261850FCCF5FE007E21"),
                              enc_file_data=bytes.fromhex("382B4C3D68552C3A5F417F0695A3D857923764E1737AD1F80E834E46387F45DC77FE7468BBCF9DBF43B29CA58E8D6435F908C9C0CD56E9B4B9960FE1279C5DF1"),
                              sdmmac=bytes.fromhex("DF3EF20BE7D91C8E"))
    assert res["uid"] == uid and res["read_ctr"] == 1
    st = Settings(server_seed_hex="11" * 32, key_mode="sdmbackend", master_key_hex="00112233445566778899aabbccddeeff")
    assert st.sdm_derive == "legacy"
    assert Settings(server_seed_hex="11" * 32, key_mode="sdmbackend", sdm_derive="STANDARD").sdm_derive == "standard"
    with pytest.raises(ValueError):
        Settings(server_seed_hex="11" * 32, key_mode="nope")
    with pytest.raises(ValueError):
        Settings(server_seed_hex="11" * 32, sdm_derive="nope")


def test_check_tap_encrypted_through_db(client, settings):
    db = client.app.state.db
    with db.connect() as conn:
        # 04DE5F1EACC040 is the seeded BOX seal of SN-2026-000002 (last_counter 4) → ctr 61 is fresh → VALID, consumed
        chk = check_tap(conn, settings, None, None, SUN1["cmac"], consume=True, picc_data=SUN1["picc"])
        assert (chk.verdict, chk.uid_hex, chk.counter, chk.serial, chk.encrypted) == ("VALID", "04DE5F1EACC040", 61, "SN-2026-000002", True)
        assert check_tap(conn, settings, None, None, SUN1["cmac"], consume=True, picc_data=SUN1["picc"]).verdict == "REPLAY"
        # SUN2 uid is not registered → UNREGISTERED with the decrypted counter; enc accepted and ignored
        chk = check_tap(conn, settings, None, None, SUN2["cmac"], consume=True, picc_data=SUN2["picc"], enc=SUN2["enc"])
        assert (chk.verdict, chk.uid_hex, chk.counter) == ("UNREGISTERED", "04958CAA5C5E80", 8)
        assert check_tap(conn, settings, None, None, "0000000000000000", consume=True, picc_data=SUN1["picc"]).verdict == "INVALID"
        assert check_tap(conn, settings, None, None, SUN1["cmac"], consume=True, picc_data="zz").verdict == "INVALID"
        assert check_tap(conn, settings, None, None, None, consume=True, picc_data=SUN1["picc"]).verdict == "INVALID"


def test_t_preview_verify_with_picc_data(client, vectors):
    # preview does not consume
    pv = client.post("/api/preview", json={"piccData": SUN1["picc"], "cmac": SUN1["cmac"]}).json()
    assert pv["verdict"] == "VALID" and pv["counter"] == 61 and pv["uid"] == "04DE5F1EACC040" and pv["serial"] == "SN-2026-000002" and pv["sealKind"] == 0
    # /t as the NFC Developer App URL (/tagtt form with enc)
    r = client.get(f"/t?picc_data={SUN2['picc']}&enc={SUN2['enc']}&cmac={SUN2['cmac']}", headers={"Accept": "application/json"}).json()
    assert r["verdict"] == "UNREGISTERED" and r["counter"] == 8 and r["uid"] == "04958CAA5C5E80"
    r = client.get(f"/t?picc_data={SUN1['picc']}&cmac={SUN1['cmac']}", headers={"Accept": "application/json"}).json()
    assert r["verdict"] == "VALID" and r["counter"] == 61 and r["serial"] == "SN-2026-000002" and r["message"] == "Siegel echt · Tap 61"
    r2 = client.get(f"/t?picc_data={SUN1['picc']}&cmac={SUN1['cmac']}&format=json").json()
    assert r2["verdict"] == "REPLAY" and r2["counter"] == 61
    r3 = client.get(f"/t?picc_data={SUN1['picc']}&cmac={SUN1['cmac']}", follow_redirects=False)
    assert r3.status_code == 302 and "/t?tap=" in r3.headers["location"]
    # /api/verify with piccData: the counter is already consumed by /t → REPLAY, unsigned; a bad cmac → INVALID
    nonce = client.post("/api/session", json={}).json()["nonce"]
    body = {"piccData": SUN1["picc"], "cmac": SUN1["cmac"], "nonce": nonce, "role": 1, "tier": 1,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [0, 0, 0, 0, 0, 0], "fill": 75}
    v = client.post("/api/verify", json=body).json()
    assert v["verdict"] == "REPLAY" and v["counter"] == 61 and v["uid"] == "04DE5F1EACC040" and v["serverSig"] is None
    nonce = client.post("/api/session", json={}).json()["nonce"]
    assert client.post("/api/verify", json={**body, "nonce": nonce, "cmac": "0000000000000000"}).json()["verdict"] == "INVALID"


def test_verify_signs_encrypted_tap(settings):
    """Fresh DB where the seeded seal 04DE5F1EACC040 has last_counter 4 → the AN12196 tap (ctr 61) is VALID and signed."""
    from fastapi.testclient import TestClient
    from fv.main import create_app
    from fv import proof
    with TestClient(create_app(settings)) as c:
        nonce = c.post("/api/session", json={}).json()["nonce"]
        v = c.post("/api/verify", json={"piccData": SUN1["picc"], "cmac": SUN1["cmac"], "nonce": nonce, "role": 0, "tier": 1,
                                        "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [0, 0, 0, 0, 0, 0], "fill": 75}).json()
        assert v["verdict"] == "VALID" and v["counter"] == 61 and v["serial"] == "SN-2026-000002" and v["grade"] == 1
        msg = bytes.fromhex(v["msgHex"])
        assert proof.parse_message(msg)["counter"] == 61 and proof.parse_message(msg)["uid_hash"].hex() == v["uidHash"][2:]
        assert proof.verify(bytes.fromhex(v["serverPubkey"]), msg, bytes.fromhex(v["serverSig"][2:]))
        assert c.get("/api/passport/SN-2026-000002").json()["seals"][0]["lastCounter"] == 61
