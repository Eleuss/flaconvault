"""Integration of the verifier with the hardened programs and the web client: the new escrow instructions
(release_after_timeout, resolve), the Core-asset account of mint_passport, a VOID grade on chain, /health, the request
body limit, rate limits on the simulator routes, the settings behind the limits and the schema columns."""
import hashlib

import pytest
from fastapi.testclient import TestClient
from solders.pubkey import Pubkey

import fv.reconcile as rc
from fv.config import Settings, settings_from_env
from fv.main import create_app
from tests.conftest import (ADMIN, ESCROW_ID, TEST_SEED_HEX, encode_event, fake_key, order_bytes, order_pda, passport_pda,
                            program_logs, sig)
from tests.test_chain import passport_bytes

SERIAL = "SN-2026-000001"
SERIAL2 = "SN-2026-000002"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"
BUYER = str(Pubkey.from_bytes(hashlib.sha256(b"buyer").digest()))
ADMIN_WALLET = str(Pubkey.from_bytes(hashlib.sha256(b"escrow-admin").digest()))


def _ev(c, **body):
    return c.post("/api/events", json=body)


def _order(c, serial, seller, **kw):
    c.rpc.accounts[order_pda(serial, seller)] = order_bytes(serial=serial, seller=seller, **kw)


# ---------- escrow instructions added by the hardened program ----------

def test_release_after_timeout_backs_a_release(chain_client):
    c, rpc = chain_client, chain_client.rpc
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=5)
    caller = fake_key("anyone")
    rel = encode_event("OrderReleased", order=order_pda(SERIAL2, SELLER), seller=SELLER, buyer=BUYER, amount=480_000_000)
    rpc.escrow_tx(sig("rt1"), "release_after_timeout", SERIAL2, caller, seller=SELLER, buyer=BUYER, logs=program_logs(ESCROW_ID, rel))
    e = _ev(c, serial=SERIAL2, type="RELEASE", txSig=sig("rt1"), actor=caller).json()
    assert e["status"] == "confirmed"
    assert e["payload"] == {"order": order_pda(SERIAL2, SELLER), "currency": "USDC", "price": 480_000_000, "priceUsdc": 480,
                            "to": SELLER, "reason": "no receipt scan within the deadline"}


def test_resolve_to_seller_is_a_release_and_to_buyer_a_dispute(chain_client):
    c, rpc = chain_client, chain_client.rpc
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=6, price=300_000_000)
    before = c.get(f"/api/attester/{SELLER}").json()
    res = encode_event("OrderResolved", order=order_pda(SERIAL2, SELLER), admin=ADMIN_WALLET, toSeller=True, amount=300_000_000,
                       assetTransferred=True)
    rpc.escrow_tx(sig("rs1"), "resolve", SERIAL2, ADMIN_WALLET, seller=SELLER, buyer=BUYER, to_seller=True,
                  logs=program_logs(ESCROW_ID, res))
    # a resolve(to_seller=true) never backs a DISPUTE
    assert _ev(c, serial=SERIAL2, type="DISPUTE", txSig=sig("rs1"), actor=ADMIN_WALLET).json()["detail"] == "tx_mismatch"
    e = _ev(c, serial=SERIAL2, type="RELEASE", txSig=sig("rs1"), actor=ADMIN_WALLET, payload={"to": BUYER}).json()
    assert e["status"] == "confirmed"
    assert e["payload"] == {"order": order_pda(SERIAL2, SELLER), "currency": "USDC", "price": 300_000_000, "priceUsdc": 300,
                            "to": SELLER, "reason": "scans disagree · resolved by the escrow admin", "passportTo": BUYER}
    assert c.get(f"/api/attester/{SELLER}").json()["escrowsOk"] == before["escrowsOk"] + 1

    seller2 = fake_key("seller-2")
    _order(c, SERIAL2, seller2, buyer=BUYER, state=7, price=200_000_000)
    res = encode_event("OrderResolved", order=order_pda(SERIAL2, seller2), admin=ADMIN_WALLET, toSeller=False, amount=200_000_000)
    rpc.escrow_tx(sig("rs2"), "resolve", SERIAL2, ADMIN_WALLET, seller=seller2, buyer=BUYER, to_seller=False,
                  logs=program_logs(ESCROW_ID, res))
    assert _ev(c, serial=SERIAL2, type="RELEASE", txSig=sig("rs2"), actor=ADMIN_WALLET).json()["detail"] == "tx_mismatch"
    e = _ev(c, serial=SERIAL2, type="DISPUTE", txSig=sig("rs2"), actor=ADMIN_WALLET).json()
    assert e["payload"] == {"order": order_pda(SERIAL2, seller2), "currency": "USDC",
                            "reason": "scans disagree · refunded by the escrow admin", "reasonCode": 3,
                            "refunded": 200_000_000, "refundedUsdc": 200}
    assert c.get(f"/api/attester/{seller2}").json()["escrowsDisputed"] == 1


def test_buyer_timeout_dispute_reads_not_shipped(chain_client):
    c, rpc = chain_client, chain_client.rpc
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=7)
    dis = encode_event("OrderDisputed", order=order_pda(SERIAL2, SELLER), by=BUYER, reason=1, refunded=480_000_000)
    rpc.escrow_tx(sig("td1"), "dispute", SERIAL2, BUYER, seller=SELLER, buyer=BUYER, logs=program_logs(ESCROW_ID, dis))
    e = _ev(c, serial=SERIAL2, type="DISPUTE", txSig=sig("td1"), actor=BUYER).json()
    assert e["payload"]["reason"] == "not shipped within the deadline" and e["payload"]["reasonCode"] == 1


def test_reserve_with_expected_price_and_appended_passport(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller = fake_key("price-seller")
    _order(c, SERIAL2, seller, buyer=BUYER, price=390_000_000, state=1)
    rpc.escrow_tx(sig("ep1"), "reserve", SERIAL2, BUYER, seller=seller, expected_price=390_000_000)
    e = _ev(c, serial=SERIAL2, type="RESERVE", txSig=sig("ep1"), actor=BUYER).json()
    assert e["status"] == "confirmed" and e["payload"]["price"] == 390_000_000


# ---------- mint_passport: core_asset at account 4 ----------

def test_mint_core_asset_account_must_be_the_asset_argument(chain_client):
    c, rpc = chain_client, chain_client.rpc
    asset = fake_key("core-asset-ok")
    rpc.mint_tx(sig("ca1"), "SN-2026-000401", SELLER, asset=asset, core_asset=asset)
    e = _ev(c, serial="SN-2026-000401", type="MINT", txSig=sig("ca1"), actor=SELLER, payload={"brand": "B", "name": "N"}).json()
    assert e["status"] == "confirmed" and e["payload"]["asset"] == asset
    rpc.mint_tx(sig("ca2"), "SN-2026-000402", SELLER, asset=asset, core_asset=fake_key("another-asset"))
    r = _ev(c, serial="SN-2026-000402", type="MINT", txSig=sig("ca2"), actor=SELLER, payload={"brand": "B", "name": "N"})
    assert r.status_code == 403 and r.json()["detail"] == "tx_mismatch"


# ---------- reconcile: a VOID grade on chain is void ----------

def test_chain_void_grade_voids_the_passport(chain_client):
    c, rpc = chain_client, chain_client.rpc
    from fv import proof
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE passports SET grade=0, void=0 WHERE serial=?", (SERIAL,))
        conn.execute("UPDATE events SET status='confirmed' WHERE serial=? AND status='pending'", (SERIAL,))
    rpc.accounts[passport_pda(SERIAL)] = passport_bytes(serial_hash=proof.serial_hash(SERIAL), grade=4, void=False, scan_count=20)
    rc.reconcile_once(c.app.state.db, c.app.state.settings, rpc)
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["grade"] == 4 and p["void"] is True


# ---------- /health, body limit, rate limits, settings, schema ----------

def test_health_reports_build_and_arweave(settings):
    settings.build_sha = "abc1234"
    with TestClient(create_app(settings)) as c:
        h = c.get("/health").json()
    assert h["build"] == "abc1234"
    assert h["arweave"]["enabled"] is False and set(h["arweave"]) >= {"ok", "problem", "lastErrorCode", "balanceOk"}


def test_json_body_limit_refuses_large_bodies_but_not_media(client):
    big = {"serial": SERIAL, "type": "SEAL_DEAD", "nonce": "0x" + "00" * 32, "payload": {"note": "x" * 70_000}}
    r = client.post("/api/events", json=big)
    assert r.status_code == 413 and r.json()["detail"] == "request_too_large"
    nonce = client.post("/api/session", json={}).json()["nonce"]
    frame = b"\xff\xd8" + b"f" * 100_000                                # > 64 KB, still accepted by /api/media
    m = client.post("/api/media", data={"nonce": nonce}, files={"file": ("f.jpg", frame, "image/jpeg")})
    assert m.status_code == 200 and m.json()["bytes"] == len(frame)
    assert client.get("/health").status_code == 200


def test_chunked_body_over_the_limit_is_refused(client):
    def gen():
        for _ in range(20):
            yield b"x" * 8192
    r = client.post("/api/events", content=gen(), headers={"content-type": "application/json"})   # no Content-Length
    assert r.status_code == 413 and r.json()["detail"] == "request_too_large"


def test_simulator_posts_are_rate_limited(settings, monkeypatch):
    monkeypatch.setenv("FV_RATE_LIMIT_PER_MIN", "2")
    with TestClient(create_app(settings)) as c:
        codes = [c.post("/api/dev/tag", json={"kind": 1}).status_code for _ in range(3)]
        assert codes[:2] == [200, 200] and codes[2] == 429
        assert c.post("/api/admin/purge-seed", headers=ADMIN).status_code == 429


def test_limits_come_from_settings_when_the_env_is_unset(settings, monkeypatch):
    monkeypatch.delenv("FV_RATE_LIMIT_PER_MIN", raising=False)
    settings.rate_limit_per_min = 1
    with TestClient(create_app(settings)) as c:
        assert c.post("/api/session", json={}).status_code == 200
        assert c.post("/api/session", json={}).status_code == 429


def test_new_settings_from_env(monkeypatch):
    for k, v in {"FV_SERVER_ED25519_SEED": TEST_SEED_HEX, "FV_SDM_LRP": "true", "FV_RATE_LIMIT_PER_MIN": "30",
                 "FV_REPORT_LIMIT_PER_HOUR": "2", "FV_TRUSTED_PROXY_HOPS": "2", "FV_MAX_JSON_BODY": "1000"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("FV_BUILD_SHA", raising=False)
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "f" * 40)
    s = settings_from_env()
    assert (s.sdm_lrp, s.rate_limit_per_min, s.report_limit_per_hour, s.trusted_proxy_hops, s.max_json_body) == (True, 30, 2, 2, 1000)
    assert s.build_sha == "f" * 40
    with pytest.raises(ValueError, match="FV_RATE_LIMIT_PER_MIN"):
        Settings(server_seed_hex=TEST_SEED_HEX, rate_limit_per_min=0)


def test_fresh_schema_has_the_trust_columns(client):
    with client.app.state.db.connect() as conn:
        events = {r["name"] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
        nonces = {r["name"] for r in conn.execute("PRAGMA table_info(nonces)").fetchall()}
    assert "resume_hash" in events and "media_files" in nonces


def test_registry_falls_back_to_the_reconciled_chain_state(chain_client):
    from fv.chain import RpcError
    from fv.db import now, set_chain_state
    from fv.routes_chain import registry_info
    from tests.conftest import PROGRAM_ID
    c, rpc = chain_client, chain_client.rpc
    partner = fake_key("stored-partner")

    def down(_pk):
        raise RpcError("rpc down")
    rpc.get_account_info = down
    with c.app.state.db.connect() as conn:
        assert registry_info(conn, c.app.state.settings, rpc)["source"] == "fallback"
        set_chain_state(conn, "registry", {"programId": PROGRAM_ID, "authority": SELLER, "partners": [partner], "serverKeys": [],
                                           "sites": []}, now())
        reg = registry_info(conn, c.app.state.settings, rpc)
        assert reg["source"] == "chain" and reg["partners"] == [partner] and reg["sites"]
        set_chain_state(conn, "registry", {"programId": PROGRAM_ID, "partners": [partner]}, now() - 3600)   # too old
        assert registry_info(conn, c.app.state.settings, rpc)["source"] == "fallback"
