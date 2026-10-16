"""Reconcile robustness: poisoned ScanProof PDAs (M10), status gaps (S8), on-chain signer/tier (reconcile.py:111),
registry partners and escrow counters from chain (S10), the confirm race (E9) and counter seeding."""
import hashlib

from solders.pubkey import Pubkey

import fv.reconcile as rc
from fv.chain import pda_order, pda_registry, pda_scan, pda_seal
from tests.conftest import ADMIN, ESCROW_ID, PROGRAM_ID, passport_pda, seal_pda
from tests.test_chain import order_bytes, passport_bytes, registry_bytes
from tests.test_reconcile import _account_for, _scan

SERIAL = "SN-2026-000001"
SEED_PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"


def _pk(tag: str) -> Pubkey:
    return Pubkey.from_bytes(hashlib.sha256(tag.encode()).digest())


def _event(c, event_id, serial=SERIAL):
    return next(e for e in c.get(f"/api/passport/{serial}").json()["events"] if e["id"] == event_id)


def _scan_pda(v, counter=None):
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    return str(pda_scan(PROGRAM_ID, seal, v["counter"] if counter is None else counter))


def _reconcile(c):
    r = c.post("/api/reconcile", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def test_sol_transfer_to_a_scan_pda_never_breaks_the_cycle(chain_client, monkeypatch):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    poisoned, good, foreign, other = (_scan(c, tag["uid"]) for _ in range(4))
    rpc.accounts[_scan_pda(poisoned)] = b""                                   # system-owned, no data (plain SOL transfer)
    rpc.accounts[_scan_pda(good)] = _account_for(good)
    rpc.accounts[_scan_pda(foreign)] = passport_bytes()                       # another account type
    rpc.accounts[_scan_pda(other)] = _account_for(other, counter=other["counter"] + 7)   # proof of another counter
    s = _reconcile(c)
    assert s["confirmed"] == 1 and s["pending"] == 3 and s["ignoredAccounts"] == 3
    assert _event(c, good["eventId"])["status"] == "confirmed"
    for v in (poisoned, foreign, other):
        e = _event(c, v["eventId"])
        assert e["status"] == "pending" and e["payload"]["reconcile"]["ignoredAccount"]
    # the poisoned scans still time out normally
    real_now = rc.now
    monkeypatch.setattr(rc, "now", lambda: real_now() + 601)
    s = _reconcile(c)
    assert s["failed"] == 3 and all(_event(c, v["eventId"])["status"] == "failed" for v in (poisoned, foreign, other))


def test_garbage_passport_and_seal_accounts_are_ignored(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.accounts[passport_pda(SERIAL)] = b"\x00" * 3
    rpc.accounts[seal_pda("04A1B2C3D4E5F6")] = b""
    rpc.accounts[str(pda_registry(PROGRAM_ID))] = b"\x01\x02"
    s = _reconcile(c)
    assert s["refreshed"] == {"passports": 0, "seals": 0} and s["registry"] is None and s["ignoredAccounts"] >= 2


def test_failed_scan_anchored_later_is_recovered_with_the_creating_signature(chain_client, monkeypatch):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"])
    attester = c.get(f"/api/attester/{v['bundle']['attester']['pubkey']}").json()["scanCount"]
    real_now = rc.now
    monkeypatch.setattr(rc, "now", lambda: real_now() + 601)
    assert _reconcile(c)["failed"] == 1 and _event(c, v["eventId"])["status"] == "failed"
    # anchored after the timeout; the confirm POST was lost. Newest first: an escrow tx touching the proof, then record_scan
    rpc.accounts[_scan_pda(v)] = _account_for(v)
    rpc.signatures[_scan_pda(v)] = ["E" * 88, "R" * 88]
    s = _reconcile(c)
    assert s["confirmed"] == 1 and s["recovered"] == 1
    e = _event(c, v["eventId"])
    assert e["status"] == "confirmed" and e["txSig"] == "R" * 88 and e["payload"]["reconcile"]["recoveredFrom"] == "failed"
    assert c.get(f"/api/attester/{v['bundle']['attester']['pubkey']}").json()["scanCount"] == attester + 1
    assert c.get(f"/api/passport/{SERIAL}").json()["stats"]["onChainScanCount"] == 1


def test_failed_scan_with_the_clients_failed_tx_gets_the_real_signature(chain_client):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"])
    with c.app.state.db.connect() as conn:                                   # what _confirm_event does on tx_failed
        conn.execute("UPDATE events SET status='failed', tx_sig=? WHERE id=?", ("F" * 88, v["eventId"]))
    rpc.accounts[_scan_pda(v)] = _account_for(v)
    rpc.signatures[_scan_pda(v)] = ["G" * 88]
    assert _reconcile(c)["recovered"] == 1
    assert _event(c, v["eventId"])["txSig"] == "G" * 88


def test_confirmation_takes_signer_label_tier_and_role_from_the_scan_proof(chain_client):
    c, rpc = chain_client, chain_client.rpc
    mallory = _pk("mallory")
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    before = c.get(f"/api/passport/{SERIAL}").json()["stats"]
    # the client claims the labelled seed partner as attester; Mallory anchors the signature herself as tier 1 / OWNER
    v = _scan(c, tag["uid"], attester=SEED_PARTNER, tier=2, role=1)
    rpc.accounts[_scan_pda(v)] = _account_for(v, attester=mallory, tier=1, role=0, site_id=3)
    assert _reconcile(c)["mismatched"] == 1
    e = _event(c, v["eventId"])
    assert e["actor"] == str(mallory) and e["actorLabel"] is None                       # never 'Parfümerie X'
    assert set(e["payload"]["reconcile"]["mismatch"]) >= {"attester", "tier", "role"}
    assert e["payload"]["chain"] == {"attester": str(mallory), "tier": 1, "role": 0, "siteId": 3, "counter": v["counter"],
                                     "scanPda": _scan_pda(v)}
    assert e["payload"]["attester"]["pubkey"] == SEED_PARTNER                           # the signed bundle itself is unchanged
    a = c.get(f"/api/attester/{mallory}").json()
    assert a["scanCount"] == 1 and a["certifiedCount"] == 0
    after = c.get(f"/api/passport/{SERIAL}").json()["stats"]
    assert after["certifiedCount"] == before["certifiedCount"] and after["scanCount"] == before["scanCount"] + 1


def test_confirm_race_applies_effects_once(chain_client, settings):
    """POST /api/events confirms the scan while reconcile is between its RPC read and the apply step (E9)."""
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"])
    who = v["bundle"]["attester"]["pubkey"]
    rpc.accounts[_scan_pda(v)] = _account_for(v)
    rpc.scan_tx("Z" * 88, v, who)
    before = c.get(f"/api/attester/{who}").json()["scanCount"]
    real = rpc.get_multiple_accounts
    state = {"fired": False}

    def racing(pubkeys):
        out = real(pubkeys)
        if not state["fired"]:
            state["fired"] = True
            r = c.post("/api/events", json={"eventId": v["eventId"], "txSig": "Z" * 88, "actor": who})
            assert r.status_code == 200 and r.json()["status"] == "confirmed", r.text
        return out
    rpc.get_multiple_accounts = racing
    s = rc.reconcile_once(c.app.state.db, settings, rpc)
    assert state["fired"] and s["confirmed"] == 0
    assert c.get(f"/api/attester/{who}").json()["scanCount"] == before + 1


def test_registry_partners_replace_the_seed_flags(chain_client):
    c, rpc = chain_client, chain_client.rpc
    assert c.get(f"/api/attester/{SEED_PARTNER}").json()["isPartner"] is True        # seed flag before any chain read
    real_partner = _pk("real-partner")
    rpc.accounts[str(pda_registry(PROGRAM_ID))] = registry_bytes(partners=[real_partner], sites=[(1, "Shop One")])
    s = _reconcile(c)
    assert s["registry"] == {"partners": 1, "sites": 1, "changed": 3}                 # 2 seed partners lose it, 1 gains it
    assert c.get(f"/api/attester/{SEED_PARTNER}").json()["isPartner"] is False
    assert c.get(f"/api/attester/{real_partner}").json()["isPartner"] is True
    assert c.get("/api/registry").json()["partners"] == [str(real_partner)]
    with c.app.state.db.connect() as conn:
        from fv.db import get_chain_state
        cached = get_chain_state(conn, "registry")
    assert cached["value"]["partners"] == [str(real_partner)] and cached["value"]["sites"] == [{"siteId": 1, "label": "Shop One"}]
    assert _reconcile(c)["registry"]["changed"] == 0                                 # idempotent


def test_escrow_counters_come_from_on_chain_orders(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller, buyer1, buyer2 = _pk("seller"), _pk("buyer1"), _pk("buyer2")
    passport = Pubkey.from_string(passport_pda(SERIAL))
    o1 = str(pda_order(ESCROW_ID, passport, seller))
    o2 = str(pda_order(ESCROW_ID, Pubkey.from_string(passport_pda("SN-2026-000002")), seller))
    rpc.program_accounts = {
        o1: order_bytes(passport=passport, seller=seller, buyer=buyer1, state=5, listed_at=1790000000),   # RELEASED
        o2: order_bytes(seller=seller, buyer=buyer2, state=7, listed_at=1790000500),                      # DISPUTE
        "Junk111111111111111111111111111111111111111": b"\x00" * 244,                                     # not an Order
    }
    s = _reconcile(c)
    assert s["escrow"]["orders"] == 2
    view = lambda pk: c.get(f"/api/attester/{pk}").json()  # noqa: E731
    assert (view(seller)["escrowsOk"], view(seller)["escrowsDisputed"]) == (1, 1)
    assert (view(buyer1)["escrowsOk"], view(buyer1)["escrowsDisputed"]) == (1, 0)
    assert (view(buyer2)["escrowsOk"], view(buyer2)["escrowsDisputed"]) == (0, 1)
    assert view("7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2")["escrowsOk"] == 0       # seeded fake counters are gone
    # close_order + re-list on the same Order PDA: the finished sale keeps counting
    rpc.program_accounts = {o1: order_bytes(passport=passport, seller=seller, state=0, listed_at=1790009999)}
    _reconcile(c)
    assert (view(seller)["escrowsOk"], view(seller)["escrowsDisputed"]) == (1, 1) and view(buyer1)["escrowsOk"] == 1


def test_counter_seeding_ignores_invalid_taps(client):
    """An INVALID tap must never burn the counter of a chip that is attached later (db.last_counter_unregistered)."""
    uid = "04ABCDEF012345"
    r = client.get(f"/t?uid={uid}&ctr=FFFFFF&cmac=0000000000000000", headers={"Accept": "application/json"}).json()
    assert r["verdict"] == "INVALID"
    client.post("/api/dev/tag", json={"uid": uid})
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    assert client.get(tap["url"] + "&format=json").json()["verdict"] == "UNREGISTERED"   # not REPLAY
    t = client.post("/api/dev/tag", json={"uid": uid, "serial": "SN-2026-000002"}).json()
    assert t["sealLastCounter"] == tap["ctr"] < 0xFFFFFF
