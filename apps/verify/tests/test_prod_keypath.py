"""
A2 — the production key path end to end: FV_KEY_MODE=sdmbackend, FV_SDM_DERIVE=legacy, a non-zero master key and the
simulator off. A sticker tap is built exactly as an NTAG 424 DNA written by the NFC Developer App produces it (encrypted
PICCData under the SDMMetaReadKey, SDMMAC under the per-UID SDMFileReadKey) and travels /t → adoption → /api/verify →
POST /api/events. Null-key (factory / AN12196) taps must be INVALID on this configuration.
"""
import pytest
from Crypto.Cipher import AES
from fastapi.testclient import TestClient

from fv import proof, sdm
from fv.config import Settings
from fv.main import create_app
from libsdm.sdm import ParamMode, calculate_sdmmac
from tests.conftest import ADMIN_TOKEN, PROGRAM_ID, TEST_SEED_HEX, FakeRpc, sig

MASTER = "00112233445566778899aabbccddeeff"        # obviously fake test master key, non-zero
UID = "04C24EDA926980"                             # fake chip uid
SERIAL = "SN-2026-000777"
ISSUER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"
OWNER = "5VgGgiSB6Gq5ubpbVHMv2dKaKdoEq1wieuX4okHwtUeU"
AN12196 = {"picc": "EF963FF7828658A599F3041510671E88", "cmac": "94EED9EE65337086"}   # null-key vector (uid 04DE5F1EACC040)


def encrypted_sun(master_hex: str, uid_hex: str, ctr: int, *, mac_key: bytes | None = None) -> tuple[str, str]:
    """(picc_data, cmac) as the tag mirrors them: AES-CBC(meta key, 0xC7 ‖ UID ‖ ctr LE ‖ padding), SDMMAC(file key)."""
    master, uid = bytes.fromhex(master_hex), bytes.fromhex(uid_hex)
    meta = sdm.meta_read_key("sdmbackend", master, "legacy")
    file_key = sdm.key_for_uid("sdmbackend", master, uid, "legacy") if mac_key is None else mac_key
    ctr_le = ctr.to_bytes(3, "little")
    picc = AES.new(meta, AES.MODE_CBC, iv=bytes(16)).encrypt(bytes([0xC7]) + uid + ctr_le + b"\x5a" * 5)
    mac = calculate_sdmmac(ParamMode.SEPARATED, file_key, uid + ctr_le)
    return picc.hex().upper(), mac.hex().upper()


@pytest.fixture()
def prod(tmp_path):
    s = Settings(server_seed_hex=TEST_SEED_HEX, key_mode="sdmbackend", sdm_derive="legacy", master_key_hex=MASTER,
                 dev_simulator=False, program_id=PROGRAM_ID, db_path=tmp_path / "prod.db", media_dir=tmp_path / "media",
                 web_url="http://web.test", admin_token=ADMIN_TOKEN, reconcile_interval_s=0)
    s.check_startup()                                   # a valid production configuration
    app = create_app(s)
    app.state.rpc = FakeRpc()
    with TestClient(app) as c:
        c.rpc = app.state.rpc
        yield c


def test_keys_are_really_derived():
    master, uid = bytes.fromhex(MASTER), bytes.fromhex(UID)
    assert sdm.meta_read_key("sdmbackend", master, "legacy") not in (bytes(16), sdm.meta_read_key("sdmbackend", master, "standard"))
    assert sdm.key_for_uid("sdmbackend", master, uid, "legacy") != bytes(16)
    picc, mac = encrypted_sun(MASTER, UID, 5)
    assert sdm.decrypt_tap("sdmbackend", master, bytes.fromhex(picc), bytes.fromhex(mac), None, "legacy") == (uid, 5)
    # null keys or the other derivation never decrypt a production tap
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex(picc), bytes.fromhex(mac), None) is None
    assert sdm.decrypt_tap("sdmbackend", master, bytes.fromhex(picc), bytes.fromhex(mac), None, "standard") is None


def test_production_tap_to_confirmed_scan(prod):
    c, rpc = prod, prod.rpc
    assert c.get("/health").json()["simulator"] is False and c.get("/api/passports").json() == []   # no demo seed
    assert c.post("/api/dev/tap", json={"uid": UID}).status_code == 404

    # passport + seal through the certify console's events, backed by (fake) on-chain txs
    rpc.mint_tx(sig("m"), SERIAL, ISSUER)
    r = c.post("/api/events", json={"serial": SERIAL, "type": "MINT", "txSig": sig("m"), "actor": ISSUER,
                                    "payload": {"brand": "Test Brand", "name": "Test Name", "batch": "B1"}})
    assert r.status_code == 200 and r.json()["status"] == "confirmed", r.text
    rpc.attach_tx(sig("s"), SERIAL, UID, ISSUER)
    r = c.post("/api/events", json={"serial": SERIAL, "type": "SEAL_ATTACH", "txSig": sig("s"), "actor": ISSUER,
                                    "payload": {"uid": UID, "kind": 1}})
    assert r.status_code == 200 and r.json()["status"] == "confirmed", r.text

    # the sticker tap lands on /t (background NFC read) → VALID + one-time adoption token
    picc, mac = encrypted_sun(MASTER, UID, 3)
    t = c.get(f"/t?picc_data={picc}&cmac={mac}", headers={"Accept": "application/json"}).json()
    assert t["verdict"] == "VALID" and t["counter"] == 3 and t["serial"] == SERIAL and t["tapToken"]
    assert c.get(f"/t?picc_data={picc}&cmac={mac}&format=json").json()["verdict"] == "REPLAY"

    # the scan session adopts it → signed by the server key
    nonce = c.post("/api/session", json={}).json()["nonce"]
    body = {"tapId": t["tapId"], "tapToken": t["tapToken"], "nonce": nonce, "role": 0, "tier": 1,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [0, 0, 0, 0, 0, 0], "fill": 95,
            "attester": OWNER, "platform": "ANDROID_WEB"}
    v = c.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID" and v["counter"] == 3 and v["serial"] == SERIAL and v["serverSig"]
    msg = bytes.fromhex(v["msgHex"])
    assert proof.verify(proof.public_key(bytes.fromhex(TEST_SEED_HEX)), msg, bytes.fromhex(v["serverSig"][2:]))
    assert proof.parse_message(msg)["uid_hash"] == proof.uid_hash(bytes.fromhex(UID))

    # anchored with record_scan, confirmed with the tx
    rpc.scan_tx(sig("k"), v, OWNER)
    e = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("k"), "actor": OWNER}).json()
    assert e["status"] == "confirmed" and e["actor"] == OWNER

    # a direct /api/verify with the next encrypted tap works too
    picc, mac = encrypted_sun(MASTER, UID, 4)
    nonce = c.post("/api/session", json={}).json()["nonce"]
    v2 = c.post("/api/verify", json={**{k: body[k] for k in body if k not in ("tapId", "tapToken")}, "nonce": nonce,
                                     "piccData": picc, "cmac": mac}).json()
    assert v2["verdict"] == "VALID" and v2["counter"] == 4
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["stats"]["onChainScanCount"] == 1 and p["seals"][0]["lastCounter"] == 4


def test_null_key_taps_are_invalid_in_production(prod):
    c, rpc = prod, prod.rpc
    rpc.mint_tx(sig("m"), SERIAL, ISSUER)
    c.post("/api/events", json={"serial": SERIAL, "type": "MINT", "txSig": sig("m"), "actor": ISSUER,
                                "payload": {"brand": "Test Brand", "name": "Test Name"}})
    rpc.attach_tx(sig("s"), SERIAL, UID, ISSUER)
    c.post("/api/events", json={"serial": SERIAL, "type": "SEAL_ATTACH", "txSig": sig("s"), "actor": ISSUER, "payload": {"uid": UID}})
    j = {"Accept": "application/json"}
    # AN12196 vector (null keys): INVALID, at /t and at /api/preview
    assert c.get(f"/t?picc_data={AN12196['picc']}&cmac={AN12196['cmac']}", headers=j).json()["verdict"] == "INVALID"
    assert c.post("/api/preview", json={"piccData": AN12196["picc"], "cmac": AN12196["cmac"]}).json()["verdict"] == "INVALID"
    # right encryption, but the MAC under the null key (a factory-key forgery): INVALID, counter untouched
    picc, mac = encrypted_sun(MASTER, UID, 5000, mac_key=bytes(16))
    assert c.get(f"/t?picc_data={picc}&cmac={mac}", headers=j).json()["verdict"] == "INVALID"
    # a plain-mirror URL with a null-key CMAC (what factory mode would accept): INVALID
    forged = sdm.sdm_cmac(bytes.fromhex(UID), 5000, bytes(16)).hex().upper()
    assert c.get(f"/t?uid={UID}&ctr=001388&cmac={forged}", headers=j).json()["verdict"] == "INVALID"
    # the genuine next tap still works: nothing above burned the counter
    picc, mac = encrypted_sun(MASTER, UID, 1)
    assert c.get(f"/t?picc_data={picc}&cmac={mac}", headers=j).json()["verdict"] == "VALID"


def test_factory_guard():
    """The same production settings with factory keys (null keys, master ignored) must refuse to start."""
    s = Settings(server_seed_hex=TEST_SEED_HEX, key_mode="factory", master_key_hex=MASTER, dev_simulator=False)
    with pytest.raises(RuntimeError, match="FV_KEY_MODE=factory"):
        s.check_startup()
    with pytest.raises(RuntimeError, match="FV_DEV_SIMULATOR=true with FV_KEY_MODE=sdmbackend"):
        Settings(server_seed_hex=TEST_SEED_HEX, key_mode="sdmbackend", master_key_hex=MASTER, dev_simulator=True).check_startup()
