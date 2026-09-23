"""Reconcile job with a monkeypatched RPC: confirmed / pending / failed transitions, mismatch recording,
chain → DB refresh; /api/reconcile, /api/registry, /api/sites."""
import json

from solders.pubkey import Pubkey

import fv.reconcile as rc
from fv import proof
from fv.chain import pda_passport, pda_registry, pda_scan, pda_seal
from tests.conftest import PROGRAM_ID
from tests.test_chain import ISSUER, SELLER, passport_bytes, registry_bytes, scan_proof_bytes, seal_bytes

SERIAL = "SN-2026-000001"
MEDIA = "0x358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380"


def _scan(client, uid, **over):
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = client.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "mediaHash": MEDIA,
            "attester": str(SELLER), "platform": "SIMULATOR"}
    body.update(over)
    v = client.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID", v
    return v


def _account_for(v: dict, **over) -> bytes:
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    b = v["bundle"]
    kw = dict(seal=seal, counter=v["counter"], tier=b["attester"]["tier"], role=b["attester"]["role"], tamper=b["tamper"],
              uv=b["indicators"]["uv"], hum=b["indicators"]["humidity"], heat=b["indicators"]["heat"], heat_mask=v["heatMask"],
              fill=b["fill"], media_hash=bytes.fromhex(b["media"][0]["sha256"][2:]) if b["media"] else bytes(32),
              bundle_hash=bytes.fromhex(v["bundleHash"][2:]), attester=Pubkey.from_string(b["attester"]["pubkey"]), ts=v["ts"])
    kw.update(over)
    return scan_proof_bytes(**kw)


def _event(client, event_id):
    return next(e for e in client.get(f"/api/passport/{SERIAL}").json()["events"] if e["id"] == event_id)


def test_reconcile_transitions(chain_client, monkeypatch):
    c, rpc = chain_client, chain_client.app.state.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v1 = _scan(c, tag["uid"])                                  # will get a matching ScanProof
    v2 = _scan(c, tag["uid"], fill=80)                         # ScanProof with a different fill → mismatch
    v3 = _scan(c, tag["uid"], fill=70)                         # no ScanProof → pending, later failed
    assert all(_event(c, v["eventId"])["status"] == "pending" for v in (v1, v2, v3))

    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v1["uidHash"][2:]))
    pda1, pda2 = pda_scan(PROGRAM_ID, seal, v1["counter"]), pda_scan(PROGRAM_ID, seal, v2["counter"])
    rpc.accounts[str(pda1)] = _account_for(v1)
    rpc.accounts[str(pda2)] = _account_for(v2, fill=81)
    rpc.signatures[str(pda1)] = ["5" * 87 + "A"]

    s = c.post("/api/reconcile").json()
    assert s == {"checked": 3, "confirmed": 2, "failed": 0, "pending": 1, "mismatched": 1,
                 "refreshed": {"passports": 0, "seals": 0}, "enabled": True}
    e1, e2, e3 = (_event(c, v["eventId"]) for v in (v1, v2, v3))
    assert e1["status"] == "confirmed" and e1["txSig"] == "5" * 87 + "A" and e1["payload"]["reconcile"]["mismatch"] == []
    assert e1["payload"]["reconcile"]["scanPda"] == str(pda1) and e1["payload"]["server"]["sig"] == v1["serverSig"]
    assert e2["status"] == "confirmed" and e2["txSig"] is None and e2["payload"]["reconcile"]["mismatch"] == ["fill"]
    assert e3["status"] == "pending" and "reconcile" not in e3["payload"]
    assert "getSignaturesForAddress" in rpc.calls and "getAccountInfo" not in rpc.calls

    # an existing tx_sig is left alone when the chain is checked again (nothing pending → no-op)
    c.post("/api/events", json={"eventId": v3["eventId"], "txSig": "7" * 88, "status": "pending"})
    assert c.post("/api/reconcile").json()["pending"] == 1
    assert _event(c, v3["eventId"])["txSig"] == "7" * 88

    # after the timeout without a ScanProof → failed, tx_sig untouched
    real_now = rc.now
    monkeypatch.setattr(rc, "now", lambda: real_now() + 601)
    s = c.post("/api/reconcile").json()
    assert s["checked"] == 1 and s["failed"] == 1 and s["pending"] == 0
    e3 = _event(c, v3["eventId"])
    assert e3["status"] == "failed" and e3["txSig"] == "7" * 88 and "no ScanProof" in e3["payload"]["reconcile"]["reason"]
    # failed events are not counted as scans
    assert c.get(f"/api/passport/{SERIAL}").json()["stats"]["scanCount"] == 14 + 2
    assert c.post("/api/reconcile").json()["checked"] == 0


def test_chain_refresh_of_passport_and_seal(chain_client):
    c, rpc = chain_client, chain_client.app.state.rpc
    p_pda = pda_passport(PROGRAM_ID, proof.serial_hash(SERIAL))
    s_pda = pda_seal(PROGRAM_ID, proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")))
    assert str(p_pda) == "5ewvSxUE88xsHkJvdx385KbjcJDs5FrArSptgnSnTwAT" and str(s_pda) == "Hnhdd1ppPTq1Ek22VhSErfz8urfLu9w43ANovzytCxCY"
    rpc.accounts[str(p_pda)] = passport_bytes(serial_hash=proof.serial_hash(SERIAL), grade=2, void=False, scan_count=14)
    rpc.accounts[str(s_pda)] = seal_bytes(uid_hash=proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")), last_counter=10, dead=True)

    before = c.get(f"/api/passport/{SERIAL}").json()
    assert before["grade"] == 0 and before["seals"][0]["lastCounter"] == 14 and before["seals"][0]["dead"] is False
    s = c.post("/api/reconcile").json()
    assert s["refreshed"] == {"passports": 1, "seals": 1}
    after = c.get(f"/api/passport/{SERIAL}").json()
    assert after["grade"] == 2 and after["void"] is False                       # chain wins
    assert after["seals"][0]["lastCounter"] == 14 and after["seals"][0]["dead"] is True   # counter never lowered, dead from chain
    assert after["sealStatus"] == "NO_RESPONSE"
    assert c.post("/api/reconcile").json()["refreshed"] == {"passports": 0, "seals": 0}   # idempotent

    # a raised seal counter pulls the simulator tag along (no REPLAY storm), and the dead flag is kept
    rpc.accounts[str(s_pda)] = seal_bytes(uid_hash=proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")), last_counter=16, dead=False)
    assert c.post("/api/reconcile").json()["refreshed"]["seals"] == 1
    after = c.get(f"/api/passport/{SERIAL}").json()
    assert after["seals"][0]["lastCounter"] == 16 and after["seals"][0]["dead"] is True
    tag = next(t for t in c.get("/api/dev/tags").json() if t["uid"] == "04A1B2C3D4E5F6")
    assert tag["counter"] == 16 and c.post("/api/dev/tap", json={"uid": "04A1B2C3D4E5F6"}).json()["ctr"] == 17

    # a passport PDA with no on-chain scan (mint default grade A, not void) does not override the DB
    p2 = pda_passport(PROGRAM_ID, proof.serial_hash("SN-2026-000002"))
    rpc.accounts[str(p2)] = passport_bytes(serial_hash=proof.serial_hash("SN-2026-000002"), grade=0, scan_count=0, void=False)
    assert c.post("/api/reconcile").json()["refreshed"]["passports"] == 0
    assert c.get("/api/passport/SN-2026-000002").json()["grade"] == 2
    rpc.accounts[str(p2)] = passport_bytes(serial_hash=proof.serial_hash("SN-2026-000002"), grade=4, scan_count=0, void=True)
    assert c.post("/api/reconcile").json()["refreshed"]["passports"] == 1
    assert c.get("/api/passport/SN-2026-000002").json()["void"] is True

    # a passport with something pending is not refreshed from chain
    rpc.accounts[str(p_pda)] = passport_bytes(serial_hash=proof.serial_hash(SERIAL), grade=1)
    c.post("/api/events", json={"serial": SERIAL, "type": "LIST", "payload": {"priceUsdc": 480}})   # pending (no txSig)
    assert c.post("/api/reconcile").json()["refreshed"]["passports"] == 0
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 2


def test_reconcile_disabled_without_program_id(client):
    s = client.post("/api/reconcile").json()
    assert s["enabled"] is False and s["checked"] == 0
    assert client.get("/api/registry").json()["source"] == "fallback"


def test_registry_and_sites(chain_client):
    c, rpc = chain_client, chain_client.app.state.rpc
    # fallback: PDA missing
    r = c.get("/api/registry").json()
    assert r["source"] == "fallback" and r["programId"] == PROGRAM_ID and r["authority"] is None and r["serverKeys"] == []
    assert str(ISSUER) in r["partners"]
    assert c.get("/api/sites").json() == [{"siteId": 1, "label": "Parfümerie X, Düsseldorf"}, {"siteId": 2, "label": "FlaconVault Vault, Wickede"}]
    # chain
    key = {"keyId": 1, "pubkeyHex": "8ddafff75fe35b174d24fca867f796bc253e32363a456f3486214f01c457ee01", "validFrom": 0, "validTo": 4102444800}
    rpc.accounts[str(pda_registry(PROGRAM_ID))] = registry_bytes(authority=ISSUER, keys=[key], partners=[ISSUER],
                                                                 sites=[(1, "Parfümerie X, Düsseldorf"), (7, "Lager Nord")])
    r = c.get("/api/registry").json()
    assert r == {"programId": PROGRAM_ID, "authority": str(ISSUER), "serverKeys": [key], "partners": [str(ISSUER)],
                 "sites": [{"siteId": 1, "label": "Parfümerie X, Düsseldorf"}, {"siteId": 7, "label": "Lager Nord"}], "source": "chain"}
    assert c.get("/api/sites").json() == r["sites"]

    # RPC failure → fallback, not a 500
    def boom(_pk):
        from fv.chain import RpcError
        raise RpcError("connection refused")
    rpc.get_account_info = boom
    assert c.get("/api/sites").json()[0]["siteId"] == 1 and c.get("/api/registry").json()["source"] == "fallback"


def test_rpc_client_parsing(monkeypatch):
    """Rpc.call parsing with a stubbed httpx.post — no network."""
    import base64
    import httpx
    from fv.chain import Rpc, RpcError

    class Resp:
        def __init__(self, body): self._b = body
        def raise_for_status(self): pass
        def json(self): return self._b

    sent = {}
    def fake_post(url, json=None, timeout=None):
        sent["req"] = json
        m = json["method"]
        if m == "getAccountInfo":
            return Resp({"jsonrpc": "2.0", "result": {"value": {"data": [base64.b64encode(b"abc").decode(), "base64"]}}, "id": 1})
        if m == "getMultipleAccounts":
            return Resp({"jsonrpc": "2.0", "result": {"value": [None, {"data": [base64.b64encode(b"xyz").decode(), "base64"]}]}, "id": 1})
        if m == "getSignaturesForAddress":
            return Resp({"jsonrpc": "2.0", "result": [{"signature": "sigA", "err": None}, {"signature": "bad", "err": {"x": 1}}], "id": 1})
        return Resp({"jsonrpc": "2.0", "error": {"code": -32601, "message": "nope"}, "id": 1})
    monkeypatch.setattr(httpx, "post", fake_post)
    rpc = Rpc("http://127.0.0.1:8899")
    assert rpc.get_account_info("11111111111111111111111111111111") == b"abc"
    assert sent["req"]["params"][1]["encoding"] == "base64"
    assert rpc.get_multiple_accounts(["1" * 32, "1" * 32]) == [None, b"xyz"]
    assert rpc.get_signatures_for_address("1" * 32) == ["sigA"]
    try:
        rpc.call("whatever", [])
    except RpcError as exc:
        assert "nope" in str(exc)
    else:
        raise AssertionError("RpcError expected")
