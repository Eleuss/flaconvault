"""Second-round verifier trust repairs: a stranger's failed tx never ends a pending scan, first posters write no free text
into the timeline, tx lookups are fair per client, escrow counters have one source, legacy claimed tiers, registry
negative cache / single flight, and IPv6 clients keyed by /64."""
import hashlib
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from solders.pubkey import Pubkey

import fv.routes_chain as rch
import fv.txverify as tv
from tests.conftest import (ADMIN, ESCROW_ID, PROGRAM_ID, encode_event, fake_key, order_bytes, order_pda, program_logs,
                            registry_pda, sig)
from tests.test_chain import registry_bytes

SERIAL = "SN-2026-000001"
SERIAL2 = "SN-2026-000002"
PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"
BUYER = str(Pubkey.from_bytes(hashlib.sha256(b"buyer").digest()))
MALLORY = str(Pubkey.from_bytes(hashlib.sha256(b"mallory").digest()))
HOSTILE_CITY = "COUNTERFEIT ‮ reported to police"


def _ev(c, **body):
    return c.post("/api/events", json=body)


def _tag(c, serial=SERIAL):
    return c.post("/api/dev/tag", json={"serial": serial, "kind": 1}).json()["uid"]


def _scan(c, uid, **over):
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = c.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 0, "tier": 1,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "platform": "IOS_WEB"}
    body.update(over)
    v = c.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID", v
    return v


def _event(c, eid, serial=SERIAL):
    return next(e for e in c.get(f"/api/passport/{serial}").json()["events"] if e["id"] == eid)


def _failing_scan_tx(c, s: str, v: dict, signer: str) -> str:
    """A failing record_scan naming the scan's public passport / seal / ScanProof PDAs (garbage args, skipPreflight)."""
    return c.rpc.add_tx(s, signers=[signer], err={"InstructionError": [1, {"Custom": 6000}]}, instructions=[
        (PROGRAM_ID, "record_scan", c.rpc.record_scan_accounts(v, signer), b"\x00" * 8)])


# ---------- M3 / C1: a stranger's failed tx never ends a pending scan ----------

def test_a_strangers_failed_tx_leaves_an_attester_less_scan_pending(chain_client):
    c = chain_client
    v = _scan(c, _tag(c), attester=None)                    # iPhone Safari: no wallet connected, resume link later
    _failing_scan_tx(c, sig("st1"), v, MALLORY)
    r = _ev(c, eventId=v["eventId"], txSig=sig("st1"), actor=MALLORY)
    assert r.status_code == 422 and r.json()["detail"] == "tx_failed"
    assert _event(c, v["eventId"])["status"] == "pending" and _event(c, v["eventId"])["txSig"] is None
    # the resume link still works in the wallet browser, and the scanner's own tx confirms the scan
    assert c.get(f"/api/verify/{v['eventId']}", params={"token": v["resumeToken"]}).status_code == 200
    c.rpc.scan_tx(sig("st2"), v, SELLER)
    assert _ev(c, eventId=v["eventId"], txSig=sig("st2"), actor=SELLER).json()["status"] == "confirmed"


def test_the_claimed_attesters_own_failed_tx_marks_the_scan_failed(chain_client):
    c = chain_client
    v = _scan(c, _tag(c), attester=SELLER)
    _failing_scan_tx(c, sig("sf1"), v, SELLER)
    assert _ev(c, eventId=v["eventId"], txSig=sig("sf1")).json()["detail"] == "tx_failed"
    e = _event(c, v["eventId"])
    assert e["status"] == "failed" and e["txSig"] == sig("sf1")
    r = c.get(f"/api/verify/{v['eventId']}", params={"token": v["resumeToken"]})
    assert r.status_code == 404 and r.json()["detail"] == "resume_not_found"


# ---------- M2: first posters write no free text ----------

def test_replayed_txs_with_hostile_location_and_carrier_change_nothing_visible(chain_client):
    c, rpc = chain_client, chain_client.rpc
    c.rpc.accounts[order_pda(SERIAL2, SELLER)] = order_bytes(serial=SERIAL2, seller=SELLER, buyer=BUYER, state=3)
    hostile = {"country": "XX", "city": HOSTILE_CITY}
    rpc.escrow_tx(sig("hl1"), "reserve", SERIAL2, BUYER, seller=SELLER)
    rpc.escrow_tx(sig("hl2"), "ship", SERIAL2, SELLER)
    rpc.mint_tx(sig("hl3"), "SN-2026-000501", PARTNER)
    first = [_ev(c, serial=SERIAL2, type="RESERVE", txSig=sig("hl1"), actor=BUYER, location=hostile).json(),
             _ev(c, serial=SERIAL2, type="SHIP", txSig=sig("hl2"), actor=SELLER, location=hostile,
                 payload={"carrier": "Counterfeit Express ‮"}).json(),
             _ev(c, serial="SN-2026-000501", type="MINT", txSig=sig("hl3"), actor=PARTNER, location=hostile,
                 payload={"brand": "B", "name": "N"}).json()]
    for e in first:
        assert e["status"] == "confirmed" and e["location"] == {"country": None, "city": None}, e
    assert first[1]["payload"]["carrier"] is None
    # the genuine posts get the same events back; nothing hostile was stored or is shown
    assert _ev(c, serial=SERIAL2, type="SHIP", txSig=sig("hl2"), actor=SELLER, payload={"carrier": "DHL"}).json() == first[1]
    text = c.get(f"/api/passport/{SERIAL2}").text + c.get("/api/passport/SN-2026-000501").text
    assert "COUNTERFEIT" not in text and "Counterfeit" not in text and "\\u202e" not in text
    with c.app.state.db.connect() as conn:
        rows = conn.execute(f"SELECT country, city FROM events WHERE tx_sig IN ({','.join('?' * 3)})",
                            (sig("hl1"), sig("hl2"), sig("hl3"))).fetchall()
    assert [tuple(r) for r in rows] == [(None, None)] * 3


def test_reports_never_store_a_location(chain_client):
    c = chain_client
    nonce = c.post("/api/session", json={}).json()["nonce"]
    e = _ev(c, serial=SERIAL, type="SEAL_DEAD", nonce=nonce, location={"country": "DE", "city": "Fake news"}).json()
    assert e["status"] == "reported" and e["location"] == {"country": None, "city": None}
    with c.app.state.db.connect() as conn:
        assert tuple(conn.execute("SELECT country, city FROM events WHERE id=?", (e["id"],)).fetchone()) == (None, None)


def test_older_rows_show_a_location_only_on_scans_and_only_printable(chain_client):
    c = chain_client
    with c.app.state.db.connect() as conn:
        for t in (3, 2):
            conn.execute("INSERT INTO events(serial, type, ts, status, payload_json, country, city) VALUES(?,?,?,?,?,?,?)",
                         (SERIAL, t, 1790000001, "confirmed", "{}", "de", HOSTILE_CITY if t == 3 else "  Düsseldorf ‮ "))
    rows = [e for e in c.get(f"/api/passport/{SERIAL}").json()["events"] if e["ts"] == 1790000001]
    assert {e["type"]: e["location"] for e in rows} == {3: {"country": None, "city": None},
                                                        2: {"country": "DE", "city": None}}


def test_scan_location_is_normalised_at_verify(chain_client):
    c = chain_client
    v = _scan(c, _tag(c), location={"country": "de", "city": "  Wickede   (Ruhr) "})
    assert v["bundle"]["location"] == {"country": "DE", "city": "Wickede (Ruhr)"}
    assert _event(c, v["eventId"])["location"] == {"country": "DE", "city": "Wickede (Ruhr)"}
    v = _scan(c, _tag(c), location={"country": "1!", "city": HOSTILE_CITY})
    assert v["bundle"]["location"] == {"country": None, "city": None}


def test_mint_issuer_label_is_never_a_client_picked_site(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.accounts[registry_pda()] = registry_bytes(partners=[Pubkey.from_string(PARTNER)], sites=[(1, "Parfümerie X, Düsseldorf")])
    c.app.state.registry_cache = None
    for i, serial in enumerate(("SN-2026-000510", "SN-2026-000511")):
        rpc.mint_tx(sig(f"ms{i}"), serial, MALLORY)                     # MALLORY has no label on record
        e = _ev(c, serial=serial, type="MINT", txSig=sig(f"ms{i}"), actor=MALLORY,
                payload={"brand": "B", "name": "N", "siteId": 1, "issuerLabel": "Parfümerie X, Düsseldorf"}).json()
        assert "siteId" not in e["payload"] and "issuerLabel" not in e["payload"]
        assert c.get(f"/api/passport/{serial}").json()["issuerLabel"] is None
        rpc.accounts.pop(registry_pda(), None)                           # second round: no readable registry at all
        c.app.state.registry_cache = None


def test_chain_registry_without_sites_publishes_no_demo_sites(chain_client):
    c = chain_client
    c.rpc.accounts[registry_pda()] = registry_bytes(partners=[Pubkey.from_string(PARTNER)])
    r = c.get("/api/registry").json()
    assert r["source"] == "chain" and r["sites"] == [] and c.get("/api/sites").json() == []
    c.rpc.accounts.pop(registry_pda())
    c.app.state.registry_cache = None
    assert c.get("/api/registry").json()["source"] == "fallback" and c.get("/api/sites").json() == rch.FALLBACK_SITES


# ---------- S1: tx lookups are fair per client ----------

def test_one_client_holding_its_lookups_cannot_fail_another_clients(chain_client):
    from fv.ratelimit import address_key
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx(sig("pc1"), "list", SERIAL2, MALLORY)
    rpc.escrow_tx(sig("pc2"), "list", SERIAL2, SELLER)
    hog = address_key("testclient")
    for _ in range(tv.MAX_LOOKUPS_PER_CLIENT):
        assert tv._CLIENTS.acquire(hog, tv.MAX_LOOKUPS_PER_CLIENT)
    try:
        r = _ev(c, serial=SERIAL2, type="LIST", txSig=sig("pc1"), actor=MALLORY)
        assert r.status_code == 429 and r.json()["detail"] == "rate_limited" and "retry-after" in r.headers
        with TestClient(c.app, client=("198.51.100.77", 1)) as other:
            assert other.post("/api/events", json={"serial": SERIAL2, "type": "LIST", "txSig": sig("pc2"),
                                                   "actor": SELLER}).json()["status"] == "confirmed"
    finally:
        for _ in range(tv.MAX_LOOKUPS_PER_CLIENT):
            tv._CLIENTS.release(hog)
    assert _ev(c, serial=SERIAL2, type="LIST", txSig=sig("pc1"), actor=MALLORY).json()["status"] == "confirmed"
    assert tv._CLIENTS.counts == {}


def test_lookups_hold_no_slot_while_waiting_between_retries(monkeypatch):
    from tests.conftest import FakeRpc
    rpc = FakeRpc()
    rpc.escrow_tx(sig("w1"), "list", SERIAL2, SELLER)
    rpc.tx_misses[sig("w1")] = 2
    seen = []
    monkeypatch.setattr(tv, "TX_RETRY_DELAYS", (0.01, 0.01, 0.01))
    real_sleep = time.sleep

    def sleep(d):
        seen.append(tv._SLOTS._value)                  # free slots while sleeping
        real_sleep(d)
    monkeypatch.setattr(tv.time, "sleep", sleep)
    assert tv.fetch_transaction(rpc, sig("w1"), "k")["meta"] is not None
    assert seen and all(n == tv.MAX_CONCURRENT_LOOKUPS for n in seen)


def test_a_known_tx_is_answered_from_the_db_before_any_rpc(chain_client):
    c, rpc = chain_client, chain_client.rpc
    c.rpc.accounts[order_pda(SERIAL2, SELLER)] = order_bytes(serial=SERIAL2, seller=SELLER, state=3)
    rpc.escrow_tx(sig("db1"), "ship", SERIAL2, SELLER)
    first = _ev(c, serial=SERIAL2, type="SHIP", txSig=sig("db1"), actor=SELLER).json()
    n = len(rpc.calls)
    assert _ev(c, serial=SERIAL2, type="SHIP", txSig=sig("db1"), actor=MALLORY).json() == first
    assert len(rpc.calls) == n                          # no getTransaction, getMultipleAccounts or getAccountInfo


# ---------- S10: one source for the escrow counters ----------

def _counts(c, pk):
    a = c.get(f"/api/attester/{pk}").json()
    return a["escrowsOk"], a["escrowsDisputed"]


def _release(c, s, serial=SERIAL2, seller=SELLER, buyer=BUYER, **kw):
    rel = encode_event("OrderReleased", order=order_pda(serial, seller), seller=seller, buyer=buyer, amount=480_000_000)
    c.rpc.escrow_tx(s, "release", serial, buyer, seller=seller, buyer=buyer, logs=program_logs(ESCROW_ID, rel), **kw)
    e = _ev(c, serial=serial, type="RELEASE", txSig=s, actor=buyer).json()
    assert e["status"] == "confirmed", e
    return e


def _listed(c, seller, s):
    """The seller's LIST event: after close_order a release tx (no seller key) binds through the known seller."""
    c.rpc.escrow_tx(s, "list", SERIAL2, seller)
    assert _ev(c, serial=SERIAL2, type="LIST", txSig=s, actor=seller).json()["status"] == "confirmed"


def test_release_keeps_counting_after_the_order_is_closed(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller = fake_key("closing-seller")
    order = order_pda(SERIAL2, seller)
    _listed(c, seller, sig("cl0"))
    # reconcile saw the order shipped; then release + close_order happen between two cycles
    rpc.program_accounts = {order: order_bytes(serial=SERIAL2, seller=seller, buyer=BUYER, state=3)}
    c.post("/api/reconcile", headers=ADMIN)
    rpc.accounts.pop(order, None)                       # closed: the account is gone when the RELEASE is posted
    rpc.program_accounts = {}
    _release(c, sig("cl1"), seller=seller)
    assert _counts(c, seller) == (1, 0) and _counts(c, BUYER) == (1, 0)
    c.post("/api/reconcile", headers=ADMIN)
    assert _counts(c, seller) == (1, 0) and _counts(c, BUYER) == (1, 0)


def test_release_of_an_order_reconcile_never_saw(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller = fake_key("unseen-seller")
    _listed(c, seller, sig("un0"))
    _release(c, sig("un1"), seller=seller)              # no Order account readable, no escrow_orders row
    assert _counts(c, seller) == (1, 0)
    c.post("/api/reconcile", headers=ADMIN)
    assert _counts(c, seller) == (1, 0)
    # the account was only unreadable at that moment: reconcile reads it now, the placeholder merges into it
    rpc.program_accounts = {order_pda(SERIAL2, seller): order_bytes(serial=SERIAL2, seller=seller, buyer=BUYER, state=5)}
    c.post("/api/reconcile", headers=ADMIN)
    assert _counts(c, seller) == (1, 0) and _counts(c, BUYER) == (1, 0)
    with c.app.state.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM escrow_orders WHERE order_pda=?", (order_pda(SERIAL2, seller),)).fetchone()[0] == 1


def test_a_stale_reconcile_read_never_undoes_a_recorded_release(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller = fake_key("stale-seller")
    order = order_pda(SERIAL2, seller)
    rpc.accounts[order] = order_bytes(serial=SERIAL2, seller=seller, buyer=BUYER, state=5)
    _release(c, sig("sr1"), seller=seller)
    rpc.program_accounts = {order: order_bytes(serial=SERIAL2, seller=seller, buyer=BUYER, state=4)}   # read before the release
    c.post("/api/reconcile", headers=ADMIN)
    assert _counts(c, seller) == (1, 0)


# ---------- M4 residual: legacy confirmed rows ----------

def test_legacy_rows_count_the_claimed_tier_only_for_the_claimed_attester(chain_client):
    c = chain_client
    before = c.get(f"/api/passport/{SERIAL}").json()["stats"]["certifiedCount"]
    claim = {"indicators": {"heat": 0, "humidity": 0}, "attester": {"pubkey": PARTNER, "tier": 4, "role": 4}, "counter": 900}
    with c.app.state.db.connect() as conn:
        for actor in (MALLORY, PARTNER):              # anchored by someone else (M4's case) / by the claimed partner
            conn.execute("INSERT INTO events(serial, type, ts, status, actor_pubkey, payload_json) VALUES(?,?,?,?,?,?)",
                         (SERIAL, 2, 1790000002, "confirmed", actor, json.dumps(claim)))
    assert c.get(f"/api/passport/{SERIAL}").json()["stats"]["certifiedCount"] == before + 1


# ---------- registry: negative cache and single flight ----------

def test_registry_outage_costs_one_rpc_call(chain_client):
    from fv.chain import RpcError
    c, rpc = chain_client, chain_client.rpc
    calls = []

    def down(_pk):
        calls.append(1)
        raise RpcError("429 Too Many Requests")
    rpc.get_account_info = down
    c.app.state.registry_cache = None
    for _ in range(20):
        assert c.get("/api/registry").json()["source"] == "fallback"
    assert len(calls) == 1
    # after REGISTRY_RETRY_S the chain is asked again
    c.app.state.registry_cache.failed_at -= rch.REGISTRY_RETRY_S
    c.get("/api/sites")
    assert len(calls) == 2


def test_registry_refresh_is_single_flight(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.accounts[registry_pda()] = registry_bytes(partners=[Pubkey.from_string(PARTNER)], sites=[(1, "Shop")])
    c.app.state.registry_cache = None
    gate, entered, calls = threading.Event(), threading.Event(), []
    real = rpc.get_account_info

    def slow(pk):
        calls.append(1)
        entered.set()
        gate.wait(5)
        return real(pk)
    rpc.get_account_info = slow
    with c.app.state.db.connect() as conn:
        results = []
        t = threading.Thread(target=lambda: results.append(
            rch.registry_info(conn, c.app.state.settings, rpc, cache_holder=c.app.state)))
        t.start()
        assert entered.wait(5)
        with c.app.state.db.connect() as conn2:
            others = [rch.registry_info(conn2, c.app.state.settings, rpc, cache_holder=c.app.state) for _ in range(5)]
        gate.set()
        t.join(5)
    assert len(calls) == 1 and results[0]["source"] == "chain"
    assert all(o["source"] == "fallback" for o in others)     # nothing cached yet: answered at once, not after the RPC


# ---------- C10 / M16: IPv6 clients keyed by /64 ----------

def test_ipv6_clients_share_a_bucket_per_64(settings, monkeypatch):
    from fv.main import create_app
    from fv.ratelimit import address_key
    assert address_key("2a00:1450:4001:81c::1") == address_key("2a00:1450:4001:81c:ffff:ffff:ffff:ffff") == "2a00:1450:4001:81c::/64"
    assert address_key("2a00:1450:4001:81d::1") != address_key("2a00:1450:4001:81c::1")
    assert address_key("203.0.113.9") == "203.0.113.9" and address_key("::ffff:203.0.113.9") == "203.0.113.9"
    monkeypatch.setenv("FV_RATE_LIMIT_PER_MIN", "2")
    app = create_app(settings)
    with TestClient(app, client=("2a00:1450:4001:81c::1", 1)) as a, \
            TestClient(app, client=("2a00:1450:4001:81c::2", 1)) as b, \
            TestClient(app, client=("2a00:1450:4001:81d::1", 1)) as other:
        assert a.post("/api/session", json={}).status_code == 200
        assert b.post("/api/session", json={}).status_code == 200
        assert a.post("/api/session", json={}).status_code == 429          # same /64: one budget
        assert b.post("/api/session", json={}).status_code == 429
        assert other.post("/api/session", json={}).status_code == 200      # another /64


@pytest.fixture(autouse=True)
def _no_leftover_lookups():
    yield
    assert tv._CLIENTS.counts == {}
