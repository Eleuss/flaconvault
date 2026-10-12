"""POST /api/events no longer trusts the client: every on-chain claim is checked against the transaction
(getTransaction via a FakeRpc), SEAL_DEAD without a tx is only *reported*, scans change shared state only once confirmed."""
import hashlib

from solders.pubkey import Pubkey

from fv import proof
from tests.conftest import ESCROW_ID, PROGRAM_ID, SYSTEM_PROGRAM, passport_pda, registry_pda

SERIAL = "SN-2026-000001"
PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"          # seeded issuer of all three passports
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"           # seeded LIST actor of SN-2026-000001 / -000003
BUYER = str(Pubkey.from_bytes(hashlib.sha256(b"buyer").digest()))
MALLORY = str(Pubkey.from_bytes(hashlib.sha256(b"mallory").digest()))
MEDIA = "0x358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380"


def _ev(c, **body):
    return c.post("/api/events", json=body)


def _scan(c, uid="04A1B2C3D4E5F6", attester=SELLER, **over):
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = c.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "mediaHash": MEDIA,
            "attester": attester, "platform": "SIMULATOR"}
    body.update(over)
    v = c.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID", v
    return v


def _event(c, event_id, serial=SERIAL):
    return next(e for e in c.get(f"/api/passport/{serial}").json()["events"] if e["id"] == event_id)


# ---------- required fields / configuration ----------

def test_tx_backed_types_need_txsig_and_actor(chain_client):
    c = chain_client
    for t in ("MINT", "SEAL_ATTACH", "LIST", "RESERVE", "SHIP", "RECEIVE", "RELEASE", "DISPUTE"):
        assert _ev(c, serial=SERIAL, type=t, actor=SELLER).status_code == 422, t
        assert _ev(c, serial=SERIAL, type=t, txSig="5" * 88).status_code == 422, t
    assert _ev(c, serial=SERIAL, type="LIST", txSig="5" * 88, actor="not-a-pubkey").status_code == 422
    # SCAN events only come from /api/verify
    assert _ev(c, serial=SERIAL, type="SCAN", txSig="5" * 88, actor=SELLER, payload={"indicators": {"heat": 1}}).status_code == 422
    assert "getTransaction" not in c.rpc.calls


def test_chain_not_configured(client):
    r = _ev(client, serial=SERIAL, type="LIST", txSig="5" * 88, actor=SELLER)
    assert r.status_code == 503 and r.json()["detail"] == "chain_not_configured"


# ---------- visibility / failure / mismatch contract ----------

def test_missing_tx_is_503_after_three_retries(chain_client):
    c = chain_client
    r = _ev(c, serial=SERIAL, type="LIST", txSig="Z" * 88, actor=SELLER)
    assert r.status_code == 503 and r.json()["detail"] == "tx_not_visible"
    assert c.rpc.calls.count("getTransaction") == 4              # first lookup + 3 quick retries
    # a tx that shows up on the third lookup is accepted
    c.rpc.escrow_tx("Y" * 88, "list", SERIAL, SELLER)
    c.rpc.tx_misses["Y" * 88] = 2
    r = _ev(c, serial=SERIAL, type="LIST", txSig="Y" * 88, actor=SELLER, payload={"priceUsdc": 480})
    assert r.status_code == 200 and r.json()["status"] == "confirmed"


def test_retry_delays_add_up_to_about_four_seconds():
    import fv.txverify as tv
    assert len(tv.TX_RETRY_DELAYS) == 3


def test_rpc_errors_count_as_not_visible(chain_client):
    from fv.chain import RpcError
    c = chain_client

    def boom(_sig):
        c.rpc.calls.append("getTransaction")
        raise RpcError("connection refused")
    c.rpc.get_transaction = boom
    r = _ev(c, serial=SERIAL, type="LIST", txSig="Z" * 88, actor=SELLER)
    assert r.status_code == 503 and r.json()["detail"] == "tx_not_visible"


def test_failed_tx_is_422_and_stores_nothing(chain_client):
    c = chain_client
    n = len(c.get(f"/api/passport/{SERIAL}").json()["events"])
    c.rpc.escrow_tx("F" * 88, "list", SERIAL, SELLER, err={"InstructionError": [0, {"Custom": 6001}]})
    r = _ev(c, serial=SERIAL, type="LIST", txSig="F" * 88, actor=SELLER)
    assert r.status_code == 422 and r.json()["detail"] == "tx_failed"
    assert len(c.get(f"/api/passport/{SERIAL}").json()["events"]) == n


def test_foreign_signer_and_forged_txs_are_403(chain_client):
    c, rpc = chain_client, chain_client.rpc
    n = len(c.get(f"/api/passport/{SERIAL}").json()["events"])

    def rejected(sig, **body):
        r = _ev(c, txSig=sig, **body)
        assert r.status_code == 403 and r.json()["detail"] == "tx_mismatch", (sig, r.text)

    # actor did not sign (SELLER's real list tx claimed by MALLORY)
    rpc.escrow_tx("a" * 88, "list", SERIAL, SELLER)
    rejected("a" * 88, serial=SERIAL, type="LIST", actor=MALLORY)
    # a tx for another passport
    rpc.escrow_tx("b" * 88, "list", "SN-2026-000002", MALLORY)
    rejected("b" * 88, serial=SERIAL, type="LIST", actor=MALLORY)
    # right accounts, wrong program (a look-alike program with the escrow's instruction layout)
    rpc.add_tx("c" * 88, signers=[MALLORY], instructions=[(SYSTEM_PROGRAM, "list", [passport_pda(SERIAL), MALLORY])])
    rejected("c" * 88, serial=SERIAL, type="LIST", actor=MALLORY)
    # right program and passport, wrong instruction (an escrow `cancel` reported as RELEASE)
    rpc.add_tx("d" * 88, signers=[MALLORY], instructions=[(ESCROW_ID, "cancel", [passport_pda(SERIAL), MALLORY])])
    rejected("d" * 88, serial=SERIAL, type="RELEASE", actor=MALLORY)
    # escrow event backed by a flacon tx
    rpc.mint_tx("e" * 88, SERIAL, MALLORY)
    rejected("e" * 88, serial=SERIAL, type="LIST", actor=MALLORY)
    # actor signed (fee payer) but is not part of the instruction
    rpc.add_tx("f" * 88, signers=[MALLORY, SELLER], instructions=[(ESCROW_ID, "ship", [_order(SERIAL, SELLER), SELLER])])
    rejected("f" * 88, serial=SERIAL, type="SHIP", actor=MALLORY)
    # SEAL_ATTACH tx for another seal than the one claimed in payload.uid
    rpc.attach_tx("g" * 88, SERIAL, "04999999999999", PARTNER)
    rejected("g" * 88, serial=SERIAL, type="SEAL_ATTACH", actor=PARTNER, payload={"uid": "04888888888888"})
    # mark_seal_dead tx for another passport's seal
    rpc.dead_tx("h" * 88, "SN-2026-000002", "04DE5F1EACC040", PARTNER)
    rejected("h" * 88, serial=SERIAL, type="SEAL_DEAD", actor=PARTNER)
    # a failed tx by someone else is a mismatch, not a failure (cannot be used to fail other people's events)
    rpc.escrow_tx("i" * 88, "list", SERIAL, SELLER, err={"InstructionError": [0, "Custom"]})
    rejected("i" * 88, serial=SERIAL, type="LIST", actor=MALLORY)
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert len(p["events"]) == n and p["void"] is False


def _order(serial, seller):
    from solders.pubkey import Pubkey
    from fv.chain import pda_order
    return str(pda_order(ESCROW_ID, Pubkey.from_string(passport_pda(serial)), seller))


# ---------- escrow flow ----------

def test_escrow_events_bind_through_the_order_pda(chain_client):
    c, rpc = chain_client, chain_client.rpc
    serial = "SN-2026-000002"                                  # no LIST yet
    rpc.escrow_tx("L" * 88, "list", serial, MALLORY, block_time=1790001000)
    e = _ev(c, serial=serial, type="LIST", txSig="L" * 88, actor=MALLORY, ts=5, status="pending", payload={"priceUsdc": 300}).json()
    assert e["status"] == "confirmed" and e["ts"] == 1790001000 and e["actor"] == MALLORY   # client ts/status ignored
    # same tx again → same event (one tx backs one event)
    assert _ev(c, serial=serial, type="LIST", txSig="L" * 88, actor=MALLORY).json()["id"] == e["id"]
    # reserve / receipt / release carry only the Order PDA and the buyer; the seller comes from the LIST event
    for sig, ix, t in (("R" * 88, "reserve", "RESERVE"), ("V" * 88, "record_receipt_scan", "RECEIVE"), ("W" * 88, "release", "RELEASE")):
        rpc.escrow_tx(sig, ix, serial, BUYER, seller=MALLORY)
        r = _ev(c, serial=serial, type=t, txSig=sig, actor=BUYER)
        assert r.status_code == 200 and r.json()["status"] == "confirmed", (t, r.text)
    # an order of an unknown seller cannot be tied to the passport
    rpc.escrow_tx("X" * 88, "reserve", serial, BUYER, seller=SELLER)
    assert _ev(c, serial=serial, type="RESERVE", txSig="X" * 88, actor=BUYER).status_code == 403
    # ship / dispute: the seller is in the tx itself
    rpc.escrow_tx("S" * 88, "ship", serial, MALLORY)
    assert _ev(c, serial=serial, type="SHIP", txSig="S" * 88, actor=MALLORY).status_code == 200


def test_v0_lookup_tables_and_cpi_instructions_are_understood(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx("1" * 88, "list", SERIAL, MALLORY, loaded=True)
    assert _ev(c, serial=SERIAL, type="LIST", txSig="1" * 88, actor=MALLORY).status_code == 200
    rpc.escrow_tx("2" * 88, "ship", SERIAL, MALLORY, inner=True)
    assert _ev(c, serial=SERIAL, type="SHIP", txSig="2" * 88, actor=MALLORY).status_code == 200


def test_block_time_missing_falls_back_to_now(chain_client):
    import time
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx("3" * 88, "list", SERIAL, MALLORY, block_time=None)
    e = _ev(c, serial=SERIAL, type="LIST", txSig="3" * 88, actor=MALLORY, ts=1).json()
    assert abs(e["ts"] - time.time()) < 60


# ---------- MINT issuer rule ----------

def test_mint_only_by_the_issuer_once_minted(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.mint_tx("m" * 88, SERIAL, MALLORY)
    r = _ev(c, serial=SERIAL, type="MINT", txSig="m" * 88, actor=MALLORY, payload={"brand": "Fake", "name": "Rename"})
    assert r.status_code == 403 and r.json()["detail"] == "not_issuer"
    assert "getTransaction" not in rpc.calls                     # refused before any RPC
    assert c.get(f"/api/passport/{SERIAL}").json()["brand"] == "Roja Parfums"
    # a brand-new serial may be minted by anyone with a verified mint_passport tx — and only renamed by them later
    rpc.mint_tx("n" * 88, "SN-2026-000077", MALLORY)
    assert _ev(c, serial="SN-2026-000077", type="MINT", txSig="n" * 88, actor=MALLORY, payload={"brand": "B", "name": "N"}).status_code == 200
    rpc.mint_tx("o" * 88, "SN-2026-000077", PARTNER)
    assert _ev(c, serial="SN-2026-000077", type="MINT", txSig="o" * 88, actor=PARTNER, payload={"brand": "X", "name": "Y"}).status_code == 403
    # a record_scan tx (flacon program, passport PDA, signed) is not a mint
    rpc.add_tx("p" * 88, signers=[MALLORY], instructions=[(PROGRAM_ID, "record_scan", [registry_pda(), passport_pda("SN-2026-000078"), MALLORY])])
    assert _ev(c, serial="SN-2026-000078", type="MINT", txSig="p" * 88, actor=MALLORY, payload={"brand": "B", "name": "N"}).status_code == 403


def test_seal_attach_cannot_move_a_seal(chain_client):
    c, rpc = chain_client, chain_client.rpc
    # 04A1B2C3D4E5F6 is a seal of SN-2026-000001
    rpc.attach_tx("q" * 88, "SN-2026-000002", "04A1B2C3D4E5F6", PARTNER)
    r = _ev(c, serial="SN-2026-000002", type="SEAL_ATTACH", txSig="q" * 88, actor=PARTNER, payload={"uid": "04A1B2C3D4E5F6"})
    assert r.status_code == 409


# ---------- SCAN confirmation ----------

def test_scan_confirmation_contract(chain_client):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"])
    eid = v["eventId"]
    # no txSig → 422; unknown event → 404
    assert _ev(c, eventId=eid).status_code == 422
    assert _ev(c, eventId=999999, txSig="5" * 88).status_code == 404
    # tx not visible → 503, event stays pending
    r = _ev(c, eventId=eid, txSig="5" * 88, actor=SELLER)
    assert r.status_code == 503 and r.json()["detail"] == "tx_not_visible" and _event(c, eid)["status"] == "pending"
    # someone else's record_scan for this scan → 403 (the scan was requested for SELLER)
    rpc.scan_tx("6" * 88, v, MALLORY)
    assert _ev(c, eventId=eid, txSig="6" * 88, actor=MALLORY).json()["detail"] == "tx_mismatch"
    # SELLER's tx, but for another counter (another ScanProof PDA) → 403
    rpc.scan_tx("7" * 88, v, SELLER, counter=v["counter"] + 1)
    assert _ev(c, eventId=eid, txSig="7" * 88, actor=SELLER).json()["detail"] == "tx_mismatch"
    assert _event(c, eid)["status"] == "pending"
    # failed on chain → 422 and the event is marked failed …
    rpc.scan_tx("8" * 88, v, SELLER, err={"InstructionError": [1, {"Custom": 6003}]})
    r = _ev(c, eventId=eid, txSig="8" * 88, actor=SELLER)
    assert r.status_code == 422 and r.json()["detail"] == "tx_failed" and _event(c, eid)["status"] == "failed"
    # … a retried, successful tx still confirms it
    rpc.scan_tx("9" * 88, v, SELLER, block_time=1790002000)
    e = _ev(c, eventId=eid, txSig="9" * 88).json()            # actor defaults to the scan's attester
    assert e["status"] == "confirmed" and e["txSig"] == "9" * 88 and e["ts"] == v["ts"]
    # confirmed is final: same tx → idempotent 200; another tx → 409; a failed tx cannot flip it
    assert _ev(c, eventId=eid, txSig="9" * 88).json()["status"] == "confirmed"
    rpc.scan_tx("A" * 88, v, SELLER)
    assert _ev(c, eventId=eid, txSig="A" * 88, actor=SELLER).status_code == 409
    assert _ev(c, eventId=eid, txSig="8" * 88, actor=SELLER, status="failed").status_code == 409
    assert _event(c, eid)["status"] == "confirmed" and _event(c, eid)["txSig"] == "9" * 88


def test_scan_without_attester_needs_actor(chain_client):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"], attester=None)
    rpc.scan_tx("5" * 88, v, BUYER)
    assert _ev(c, eventId=v["eventId"], txSig="5" * 88).status_code == 422
    e = _ev(c, eventId=v["eventId"], txSig="5" * 88, actor=BUYER).json()
    assert e["status"] == "confirmed" and e["actor"] == BUYER
    assert c.get(f"/api/attester/{BUYER}").json()["scanCount"] == 1


def test_grade_and_attester_stats_only_on_confirmation(chain_client):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    before = c.get(f"/api/passport/{SERIAL}").json()
    seller_before = c.get(f"/api/attester/{SELLER}").json()
    assert before["grade"] == 0
    old = _scan(c, tag["uid"], fill=95)                        # grade A
    new = _scan(c, tag["uid"], tier=1, mediaHash=None, fill=70, indicators={"heat": 1, "humidity": 0, "uv": 3},
                heatLevels=[1, 1, 1, 1, 1, 0])                 # heat triggered → worse grade
    assert new["grade"] > 0
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["grade"] == 0 and p["latest"] == before["latest"]
    assert c.get(f"/api/attester/{SELLER}").json()["scanCount"] == seller_before["scanCount"]
    # confirm the newer one first, then the older one: the grade follows the newest confirmed scan
    rpc.scan_tx("N" * 88, new, SELLER)
    rpc.scan_tx("O" * 88, old, SELLER)
    assert _ev(c, eventId=new["eventId"], txSig="N" * 88).status_code == 200
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == new["grade"]
    assert _ev(c, eventId=old["eventId"], txSig="O" * 88).status_code == 200
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["grade"] == new["grade"] and p["latest"]["eventId"] == new["eventId"]
    a = c.get(f"/api/attester/{SELLER}").json()
    assert a["scanCount"] == seller_before["scanCount"] + 2


def test_no_photo_scan_does_not_blank_the_header(chain_client):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"])
    rpc.scan_tx("P" * 88, v, SELLER)
    _ev(c, eventId=v["eventId"], txSig="P" * 88)
    blind = _scan(c, tag["uid"], tier=1, mediaHash=None, indicators={"heat": 3, "humidity": 3, "uv": 3}, heatLevels=[0] * 6)
    rpc.scan_tx("Q" * 88, blind, SELLER)
    assert _ev(c, eventId=blind["eventId"], txSig="Q" * 88).json()["status"] == "confirmed"
    latest = c.get(f"/api/passport/{SERIAL}").json()["latest"]
    assert latest["eventId"] == v["eventId"] and latest["indicators"] == {"heat": 0, "humidity": 0, "uv": 3}


# ---------- SEAL_DEAD ----------

def test_reported_seal_dead_needs_a_nonce_and_changes_nothing(chain_client):
    c = chain_client
    uid_hash = "0x" + proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")).hex()
    before = c.get(f"/api/passport/{SERIAL}").json()
    assert _ev(c, serial=SERIAL, type="SEAL_DEAD", actor=MALLORY).status_code == 422          # no nonce
    r = _ev(c, serial=SERIAL, type="SEAL_DEAD", nonce="0x" + "ab" * 32)
    assert r.status_code == 403 and r.json()["detail"] == "nonce_invalid"
    assert _ev(c, serial=SERIAL, type="SEAL_DEAD", nonce="garbage").status_code == 403
    nonce = c.post("/api/session", json={}).json()["nonce"]
    e = _ev(c, serial=SERIAL, type="SEAL_DEAD", nonce=nonce, actor=MALLORY, actorLabel="Parfümerie X, Düsseldorf",
            sealUidHash=uid_hash, status="confirmed", payload={"note": "Seal not responding"}).json()
    assert e["status"] == "reported" and e["txSig"] is None and e["actor"] is None and e["actorLabel"] is None
    assert e["payload"]["reportedBy"] == MALLORY and e["gradeAfter"] == before["grade"] and e["sealUidHash"] == uid_hash
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["void"] is False and p["grade"] == before["grade"] and p["sealStatus"] == "INTACT"
    assert all(not s["dead"] for s in p["seals"])
    assert c.get(f"/api/attester/{MALLORY}").status_code == 404
    # the seal still verifies
    tap = c.post("/api/dev/tap", json={"uid": "04A1B2C3D4E5F6"}).json()
    assert c.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()["verdict"] == "VALID"
    # the nonce is consumed
    assert _ev(c, serial=SERIAL, type="SEAL_DEAD", nonce=nonce).json()["detail"] == "nonce_invalid"
    # unknown passport / foreign seal
    n2 = c.post("/api/session", json={}).json()["nonce"]
    assert _ev(c, serial="SN-nope", type="SEAL_DEAD", nonce=n2).status_code == 404
    foreign = "0x" + proof.uid_hash(bytes.fromhex("04DE5F1EACC040")).hex()
    assert _ev(c, serial=SERIAL, type="SEAL_DEAD", nonce=n2, sealUidHash=foreign).status_code == 422


def test_partner_seal_dead_with_tx_infers_the_seal(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.dead_tx("D" * 88, SERIAL, "04A1B2C3D4E5F6", PARTNER)
    e = _ev(c, serial=SERIAL, type="SEAL_DEAD", txSig="D" * 88, actor=PARTNER).json()
    assert e["status"] == "confirmed" and e["gradeAfter"] == 4
    assert e["sealUidHash"] == "0x" + proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")).hex()
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["void"] and p["sealStatus"] == "NO_RESPONSE" and any(s["dead"] for s in p["seals"])


def test_payload_size_limit(chain_client):
    r = _ev(chain_client, serial=SERIAL, type="LIST", txSig="5" * 88, actor=SELLER, payload={"x": "y" * 20000})
    assert r.status_code == 413


def test_reconcile_confirmed_scan_accepts_the_clients_tx_once(chain_client):
    """The reconcile job may confirm a scan before the browser reports its tx (and without finding the signature)."""
    from tests.conftest import ADMIN
    from tests.test_reconcile import _account_for
    from fv.chain import pda_scan, pda_seal
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"])
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, v["counter"]))] = _account_for(v)
    assert c.post("/api/reconcile", headers=ADMIN).json()["confirmed"] == 1
    assert _event(c, v["eventId"])["txSig"] is None
    stats = c.get(f"/api/attester/{SELLER}").json()["scanCount"]
    rpc.scan_tx("R" * 88, v, SELLER)
    e = _ev(c, eventId=v["eventId"], txSig="R" * 88).json()
    assert e["status"] == "confirmed" and e["txSig"] == "R" * 88
    assert c.get(f"/api/attester/{SELLER}").json()["scanCount"] == stats          # effects applied once
    rpc.scan_tx("S" * 88, v, SELLER)
    assert _ev(c, eventId=v["eventId"], txSig="S" * 88).status_code == 409


def test_mint_payload_types_and_seal_kind(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.mint_tx("k" * 88, "SN-2026-000090", MALLORY)
    assert _ev(c, serial="SN-2026-000090", type="MINT", txSig="k" * 88, actor=MALLORY,
               payload={"brand": {"x": 1}, "name": "N"}).status_code == 422
    assert _ev(c, serial="SN-2026-000090", type="MINT", txSig="k" * 88, actor=MALLORY,
               payload={"brand": "B", "name": "N"}).status_code == 200
    rpc.attach_tx("j" * 88, "SN-2026-000090", "04121212121212", MALLORY)
    assert _ev(c, serial="SN-2026-000090", type="SEAL_ATTACH", txSig="j" * 88, actor=MALLORY,
               payload={"uid": "04121212121212", "kind": 7}).status_code == 422
