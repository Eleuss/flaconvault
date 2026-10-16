"""POST /api/admin/purge-seed — removes what the demo seed put into a database, keeps everything with on-chain evidence (M1)."""
import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from solders.pubkey import Pubkey

from fv import proof
from fv.chain import RpcError, pda_registry, pda_scan, pda_seal
from fv.main import create_app
from tests.conftest import ADMIN, PROGRAM_ID, FakeRpc, passport_pda, seal_pda
from tests.test_chain import passport_bytes, registry_bytes, scan_proof_bytes, seal_bytes
from tests.test_reconcile import _scan

SEED_MINT_TX = "3jBaYVCd9Tyrruz6nqYPScHFHPoqD6P4Bx1vQDty1V2arYnRHczsfWo9QYfqU9vkUwraRAw56FYPwJKfCbthqAuo"   # SN-2026-000001 MINT
SEED_PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"
REAL_ISSUER = Pubkey.from_bytes(hashlib.sha256(b"real-issuer").digest())
REAL_ATTESTER = str(Pubkey.from_bytes(hashlib.sha256(b"real-attester").digest()))


def _uid_hash(uid: str) -> bytes:
    return proof.uid_hash(bytes.fromhex(uid))


def _chain_like_production(c):
    """Devnet as seed-passports.ts left it: SN-000001/2 exist on chain, SN-000003 does not; one seed tx is real."""
    rpc = c.rpc
    rpc.accounts[passport_pda("SN-2026-000001")] = passport_bytes(serial_hash=proof.serial_hash("SN-2026-000001"), grade=1,
                                                                  scan_count=27, issuer=REAL_ISSUER)
    rpc.accounts[seal_pda("04A1B2C3D4E5F6")] = seal_bytes(uid_hash=_uid_hash("04A1B2C3D4E5F6"), last_counter=27)
    rpc.accounts[passport_pda("SN-2026-000002")] = passport_bytes(serial_hash=proof.serial_hash("SN-2026-000002"), grade=0,
                                                                  scan_count=0, issuer=REAL_ISSUER)
    rpc.accounts[seal_pda("04DE5F1EACC040")] = seal_bytes(uid_hash=_uid_hash("04DE5F1EACC040"), last_counter=1)
    # somebody anchored the published seed signature of SN-2026-000002 counter 1
    seal = pda_seal(PROGRAM_ID, _uid_hash("04DE5F1EACC040"))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, 1))] = scan_proof_bytes(seal=seal, counter=1)
    rpc.accounts[str(pda_registry(PROGRAM_ID))] = registry_bytes(partners=[REAL_ISSUER])
    rpc.mint_tx(SEED_MINT_TX, "SN-2026-000001", SEED_PARTNER)          # this one seed signature exists on chain


def _real_scan(c):
    tag = c.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    v = _scan(c, tag["uid"], attester=REAL_ATTESTER)
    c.rpc.scan_tx("r" * 88, v, REAL_ATTESTER)
    e = c.post("/api/events", json={"eventId": v["eventId"], "txSig": "r" * 88, "actor": REAL_ATTESTER}).json()
    assert e["status"] == "confirmed"
    return v, tag


def _counts(c):
    with c.app.state.db.connect() as conn:
        return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("passports", "seals", "events", "attesters", "sim_tags")}


def test_purge_requires_the_admin_token(chain_client):
    assert chain_client.post("/api/admin/purge-seed").status_code == 403
    assert chain_client.post("/api/admin/purge-seed", headers={"x-admin-token": "nope"}).status_code == 403
    assert chain_client.rpc.calls == []


def test_purge_refuses_without_a_chain(client):
    r = client.post("/api/admin/purge-seed", headers=ADMIN)                       # never deletes blind
    assert r.status_code == 503 and r.json()["detail"] == "chain_not_configured"


def test_dry_run_is_the_default_and_changes_nothing(chain_client):
    c = chain_client
    _chain_like_production(c)
    v, _ = _real_scan(c)
    before = _counts(c)
    r = c.post("/api/admin/purge-seed", headers=ADMIN)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["dryRun"] is True and "applied" not in rep and _counts(c) == before
    deleted = {d["id"]: d for d in rep["events"]["delete"]}
    kept = {d["txSig"]: d for d in rep["events"]["keep"]}
    assert set(kept) == {SEED_MINT_TX} and kept[SEED_MINT_TX]["reason"] == "transaction exists on chain"
    assert v["eventId"] not in deleted                                              # a real, anchored scan is never touched
    reasons = {d["reason"] for d in deleted.values()}
    assert reasons == {"seed-signed scan", "seed transaction does not exist on chain", "seed event without a transaction"}
    assert rep["replayedOnChain"] and rep["replayedOnChain"][0]["serial"] == "SN-2026-000002" and rep["replayedOnChain"][0]["counter"] == 1
    assert rep["chainAccounts"]["passports"] == ["SN-2026-000001", "SN-2026-000002"]
    assert "getSignatureStatuses" in c.rpc.calls


def test_purge_keeps_on_chain_evidence_and_removes_the_rest(chain_client):
    c = chain_client
    _chain_like_production(c)
    v, tag = _real_scan(c)
    rep = c.post("/api/admin/purge-seed?dry_run=false", headers=ADMIN).json()
    applied = rep["applied"]
    assert applied["events"] == len(rep["events"]["delete"]) > 20

    # SN-2026-000003: seed only, no on-chain account → gone (with its seal)
    assert c.get("/api/passport/SN-2026-000003").status_code == 404
    assert applied["passports"]["deleted"] == ["SN-2026-000003"] and applied["seals"]["deleted"] == ["041E3C8A2D6B80"]
    with c.app.state.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM seals WHERE serial='SN-2026-000003'").fetchone()[0] == 0
    # SN-2026-000001: the real scan and the seed MINT whose tx exists stay; issuer from chain; stats from real data
    p1 = c.get("/api/passport/SN-2026-000001").json()
    ids = {e["id"] for e in p1["events"]}
    assert v["eventId"] in ids
    assert {e["txSig"] for e in p1["events"] if e["payload"].get("seed")} == {SEED_MINT_TX}
    assert p1["issuer"] == str(REAL_ISSUER)
    assert p1["stats"]["onChainScanCount"] == 1 and p1["stats"]["scanCount"] == 1
    assert p1["grade"] == 1 and p1["void"] is False                                   # chain grade B, real scan A → B
    # SN-2026-000002: kept (on chain), no seed rows left, recomputed state, seal counter never lowered
    p2 = c.get("/api/passport/SN-2026-000002").json()
    assert p2["events"] == [] and p2["grade"] == 0 and p2["void"] is False and p2["seals"][0]["lastCounter"] == 4

    # seed attesters: fake ones without kept events are deleted; the MINT actor is kept but stripped of seed data
    assert c.get("/api/attester/7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2").status_code == 404
    assert c.get("/api/attester/FvAmSPy7AzoArUkh3den2QvkKcox8gqUZg6ePWZZKFA").status_code == 404
    a = c.get(f"/api/attester/{SEED_PARTNER}").json()
    assert a["isPartner"] is False and a["label"] is None and a["scanCount"] == 0 and a["certifiedCount"] == 0
    assert c.get(f"/api/attester/{REAL_ATTESTER}").json()["scanCount"] == 1
    # virtual tags of the seed are gone, the one created in this session stays (simulator on)
    tags = {t["uid"] for t in c.get("/api/dev/tags").json()}
    assert tags == {tag["uid"]}
    # idempotent
    again = c.post("/api/admin/purge-seed?dry_run=false", headers=ADMIN).json()
    assert again["events"]["delete"] == [] and again["applied"]["events"] == 0


def test_purge_on_a_production_database(settings, tmp_path):
    """Simulator off: every virtual tag goes (they hold derived tag keys); seed VOID/dead state is recomputed from chain."""
    settings.program_id = PROGRAM_ID
    settings.dev_simulator, settings.key_mode, settings.master_key_hex = False, "sdmbackend", "00112233445566778899aabbccddeeff"
    settings.seed_demo = True                                                        # what the old production auto-seed did
    with TestClient(create_app(settings)) as c:
        c.app.state.rpc = c.rpc = FakeRpc()
        c.rpc.accounts[passport_pda("SN-2026-000003")] = passport_bytes(serial_hash=proof.serial_hash("SN-2026-000003"), scan_count=0)
        c.rpc.accounts[seal_pda("041E3C8A2D6B80")] = seal_bytes(uid_hash=_uid_hash("041E3C8A2D6B80"), last_counter=0, dead=False)
        with c.app.state.db.connect() as conn:
            conn.execute("INSERT INTO sim_tags(uid_hex, key_hex, counter, alive, created_at) VALUES('04AAAAAAAAAAAA', ?, 0, 1, 0)",
                         ("00" * 16,))
        assert c.get("/api/passport/SN-2026-000003").json()["void"] is True
        rep = c.post("/api/admin/purge-seed?dry_run=false", headers=ADMIN).json()
        assert rep["applied"]["simTags"] == ["04AAAAAAAAAAAA"]
        p3 = c.get("/api/passport/SN-2026-000003").json()
        assert p3["void"] is False and p3["grade"] == 0 and p3["seals"][0]["dead"] is False and p3["sealStatus"] == "INTACT"
        assert sorted(rep["applied"]["passports"]["deleted"]) == ["SN-2026-000001", "SN-2026-000002"]
        assert [p["serial"] for p in c.get("/api/passports").json()] == ["SN-2026-000003"]
        with c.app.state.db.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM attesters").fetchone()[0] == 0


def test_rpc_failure_deletes_nothing(chain_client):
    c = chain_client
    before = _counts(c)

    def down(_sigs):
        raise RpcError("connection refused")
    c.rpc.get_signature_statuses = down
    r = c.post("/api/admin/purge-seed?dry_run=false", headers=ADMIN)
    assert r.status_code == 503 and r.json()["detail"] == "rpc_unavailable" and _counts(c) == before


def test_missing_seed_file(chain_client, settings, tmp_path):
    settings.seed_path = tmp_path / "nope.json"
    assert chain_client.post("/api/admin/purge-seed", headers=ADMIN).status_code == 404


def test_admin_status(chain_client):
    assert chain_client.get("/api/admin/status").status_code == 403
    st = chain_client.get("/api/admin/status", headers=ADMIN).json()
    assert st["keyMode"] == "factory" and st["simulator"] is True and st["arweave"]["enabled"] is False
    assert "lastError" in st["arweave"] and json.dumps(st)


@pytest.mark.parametrize("payload, expected", [({"seed": True, "msgHex": "00"}, True), ({}, False)])
def test_seed_signed_detection(payload, expected):
    from fv.routes_admin import _seed_signed
    assert _seed_signed({"type": 2, "serial": "SN-X"}, payload) is expected
    from fv.seed import seed_nonce
    assert _seed_signed({"type": 2, "serial": "SN-X"}, {"counter": 3, "session": {"nonce": "0x" + seed_nonce("SN-X", 3).hex()}})
    assert not _seed_signed({"type": 2, "serial": "SN-X"}, {"counter": 3, "session": {"nonce": "0x" + "ab" * 32}})
