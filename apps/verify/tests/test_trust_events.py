"""POST /api/events trusts only the chain: replayed MINT / SEAL_ATTACH txs change nothing, payload facts come from the
decoded instruction, its accounts and the program's Anchor events, escrow events bind through the Order account, and
accounts only count at their IDL positions."""
import hashlib

from solders.pubkey import Pubkey

from fv import proof
from tests.conftest import (ESCROW_ID, PROGRAM_ID, SYSTEM_PROGRAM, encode_event, fake_key, order_bytes, order_pda, passport_pda,
                            program_logs, registry_pda, scan_proof_account, seal_pda, sig)

SERIAL = "SN-2026-000001"
SERIAL2 = "SN-2026-000002"                                       # seeded, no LIST event
PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"
BUYER = str(Pubkey.from_bytes(hashlib.sha256(b"buyer").digest()))
MALLORY = str(Pubkey.from_bytes(hashlib.sha256(b"mallory").digest()))


def _ev(c, **body):
    return c.post("/api/events", json=body)


def _p(c, serial=SERIAL):
    return c.get(f"/api/passport/{serial}").json()


# ---------- MINT / SEAL_ATTACH replays ----------

def test_replaying_the_issuers_mint_tx_changes_nothing(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.mint_tx(sig("m1"), "SN-2026-000301", PARTNER)
    first = _ev(c, serial="SN-2026-000301", type="MINT", txSig=sig("m1"), actor=PARTNER,
                payload={"brand": "Roja", "name": "Elysium", "batch": "R1"}).json()
    assert first["status"] == "confirmed"
    before = _p(c, "SN-2026-000301")
    # anyone can replay the public tx with the issuer as actor: the stored event comes back, nothing is renamed
    r = _ev(c, serial="SN-2026-000301", type="MINT", txSig=sig("m1"), actor=PARTNER, actorLabel="Known scammer",
            payload={"brand": "FAKE", "name": "COUNTERFEIT - do not buy", "asset": MALLORY, "issuerLabel": "Creed boutique"})
    assert r.status_code == 200 and r.json() == first
    after = _p(c, "SN-2026-000301")
    assert after == before and after["brand"] == "Roja" and after["issuerLabel"] == "Parfümerie X, Düsseldorf"
    assert c.get(f"/api/attester/{PARTNER}").json()["label"] == "Parfümerie X, Düsseldorf"
    # the seeded passports work the same way
    assert _ev(c, serial=SERIAL, type="MINT", txSig=sig("m1"), actor=PARTNER, payload={"brand": "X", "name": "Y"}).status_code == 200
    assert _p(c)["brand"] == "Roja Parfums"


def test_mint_fields_come_from_the_instruction(chain_client):
    c, rpc = chain_client, chain_client.rpc
    asset = fake_key("core-asset")
    rpc.mint_tx(sig("m2"), "SN-2026-000302", MALLORY, asset=asset, binding=b"\x42" * 32)
    e = _ev(c, serial="SN-2026-000302", type="MINT", txSig=sig("m2"), actor=MALLORY, actorLabel="FlaconVault Vault",
            payload={"brand": "B", "name": "N", "asset": PARTNER, "issuerLabel": "Parfümerie X, Düsseldorf", "bindingHash": "0x00"}).json()
    assert e["payload"]["asset"] == asset and e["payload"]["bindingHash"] == "0x" + "42" * 32
    assert "issuerLabel" not in e["payload"] and e["actorLabel"] is None
    p = _p(c, "SN-2026-000302")
    assert p["asset"] == asset and p["issuerLabel"] is None
    assert c.get(f"/api/attester/{MALLORY}").json()["label"] is None             # the client's label was never stored
    # a mint_passport whose serial_hash argument is another serial does not back this MINT
    rpc.mint_tx(sig("m3"), "SN-2026-000303", MALLORY, serial_for_args="SN-2026-000999")
    assert _ev(c, serial="SN-2026-000303", type="MINT", txSig=sig("m3"), actor=MALLORY,
               payload={"brand": "B", "name": "N"}).json()["detail"] == "tx_mismatch"


def test_replaying_seal_attach_never_rewrites_the_seal(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.mint_tx(sig("a0"), "SN-2026-000310", PARTNER)
    _ev(c, serial="SN-2026-000310", type="MINT", txSig=sig("a0"), actor=PARTNER, payload={"brand": "B", "name": "N"})
    rpc.attach_tx(sig("a1"), "SN-2026-000310", "04313131313131", PARTNER, kind=1)
    e = _ev(c, serial="SN-2026-000310", type="SEAL_ATTACH", txSig=sig("a1"), actor=PARTNER,
            payload={"uid": "04313131313131", "kind": 1}).json()
    n_calls = rpc.calls.count("getTransaction")
    again = _ev(c, serial="SN-2026-000310", type="SEAL_ATTACH", txSig=sig("a1"), actor=PARTNER,
                payload={"uid": "04313131313131", "kind": 2})
    assert again.status_code == 200 and again.json() == e and rpc.calls.count("getTransaction") == n_calls
    assert _p(c, "SN-2026-000310")["seals"][0]["kind"] == 1
    # answered from the DB before any chain lookup (even a signature the RPC has never seen)
    assert _ev(c, serial="SN-2026-000310", type="SEAL_ATTACH", txSig=sig("never-sent"), actor=PARTNER,
               payload={"uid": "04313131313131"}).json() == e
    assert _ev(c, serial="SN-2026-000310", type="MINT", txSig=sig("never-sent"), actor=PARTNER,
               payload={"brand": "X", "name": "Y"}).json()["type"] == 0
    assert rpc.calls.count("getTransaction") == n_calls


def test_attach_seal_args_must_match_the_claimed_uid(chain_client):
    c, rpc = chain_client, chain_client.rpc
    # the seal PDA is the claimed uid's, but the uid_hash argument is another chip's (cannot happen on chain)
    args = proof.uid_hash(bytes.fromhex("04999999999999")) + b"\x01"
    rpc.add_tx(sig("a2"), signers=[PARTNER], instructions=[
        (PROGRAM_ID, "attach_seal", [registry_pda(), passport_pda(SERIAL), seal_pda("04888888888888"), PARTNER, SYSTEM_PROGRAM], args)])
    assert _ev(c, serial=SERIAL, type="SEAL_ATTACH", txSig=sig("a2"), actor=PARTNER,
               payload={"uid": "04888888888888"}).json()["detail"] == "tx_mismatch"


# ---------- positional binding ----------

def test_accounts_only_count_at_their_idl_positions(chain_client):
    """Anchor ignores extra accounts: naming a passport PDA anywhere in an instruction proves nothing."""
    c, rpc = chain_client, chain_client.rpc
    # Mallory mints her own passport and appends the PDA of a serial nobody has minted yet
    victim = "SN-2026-000320"
    rpc.add_tx(sig("p1"), signers=[MALLORY], instructions=[
        (PROGRAM_ID, "mint_passport", [registry_pda(), passport_pda("SN-2026-000321"), MALLORY, SYSTEM_PROGRAM, passport_pda(victim)],
         proof.serial_hash("SN-2026-000321") + bytes(32) + bytes(32))])
    assert _ev(c, serial=victim, type="MINT", txSig=sig("p1"), actor=MALLORY,
               payload={"brand": "B", "name": "N"}).json()["detail"] == "tx_mismatch"
    assert c.get(f"/api/passport/{victim}").status_code == 404
    # ship() of her own order with the victim's Order PDA appended
    rpc.add_tx(sig("p2"), signers=[MALLORY], instructions=[
        (ESCROW_ID, "ship", [order_pda(SERIAL2, MALLORY), MALLORY, order_pda(SERIAL, SELLER)], b"")])
    assert _ev(c, serial=SERIAL, type="SHIP", txSig=sig("p2"), actor=MALLORY).json()["detail"] == "tx_mismatch"
    # mark_seal_dead of another passport's seal with this passport's seal appended
    rpc.add_tx(sig("p3"), signers=[PARTNER], instructions=[
        (PROGRAM_ID, "mark_seal_dead", [registry_pda(), passport_pda(SERIAL2), seal_pda("04DE5F1EACC040"), PARTNER,
                                        passport_pda(SERIAL), seal_pda("04A1B2C3D4E5F6")], b"")])
    assert _ev(c, serial=SERIAL, type="SEAL_DEAD", txSig=sig("p3"), actor=PARTNER).json()["detail"] == "tx_mismatch"
    assert _p(c)["void"] is False


def test_record_pre_ship_scan_does_not_back_a_ship_event(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx(sig("s1"), "record_pre_ship_scan", SERIAL, SELLER)
    assert _ev(c, serial=SERIAL, type="SHIP", txSig=sig("s1"), actor=SELLER).json()["detail"] == "tx_mismatch"


# ---------- signer / signature guards ----------

def test_seller_signed_release_cannot_be_claimed_by_the_buyer(chain_client):
    c, rpc = chain_client, chain_client.rpc
    # release by the seller: the buyer is an account of the instruction, but did not sign
    rpc.escrow_tx(sig("r1"), "release", SERIAL, SELLER, buyer=BUYER)
    assert _ev(c, serial=SERIAL, type="RELEASE", txSig=sig("r1"), actor=BUYER).json()["detail"] == "tx_mismatch"
    assert _ev(c, serial=SERIAL, type="RELEASE", txSig=sig("r1"), actor=SELLER).json()["status"] == "confirmed"


def test_the_signature_must_belong_to_the_returned_transaction(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx(sig("t1"), "list", SERIAL, SELLER)
    rpc.txs[sig("t2")] = rpc.txs[sig("t1")]                     # an RPC answering with another tx
    assert _ev(c, serial=SERIAL, type="LIST", txSig=sig("t2"), actor=SELLER).json()["detail"] == "tx_mismatch"


def test_a_transaction_without_status_is_not_visible(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx(sig("t3"), "list", SERIAL, SELLER)
    rpc.txs[sig("t3")]["meta"] = None
    r = _ev(c, serial=SERIAL, type="LIST", txSig=sig("t3"), actor=SELLER)
    assert r.status_code == 503 and r.json()["detail"] == "tx_not_visible"


def test_tx_signature_format(chain_client):
    c = chain_client
    for bad in ("not-even-base58-!!", "5" * 20, "1" * 88, "Z" * 88):
        r = _ev(c, serial=SERIAL, type="LIST", txSig=bad, actor=SELLER)
        assert r.status_code == 422 and "txSig" in r.json()["detail"], bad
    assert _ev(c, eventId=1, txSig="Z" * 88).status_code == 422
    assert "getTransaction" not in c.rpc.calls


# ---------- escrow: Order-account binding and chain-derived payloads ----------

def _order(c, serial, seller, **kw):
    c.rpc.accounts[order_pda(serial, seller)] = order_bytes(serial=serial, seller=seller, **kw)


def test_escrow_events_bind_through_the_order_account_without_a_list_event(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller = fake_key("devnet-seller")                               # listed outside the web app: no LIST event
    _order(c, SERIAL2, seller, buyer=BUYER, price=390_000_000, state=1)
    rpc.escrow_tx(sig("o1"), "reserve", SERIAL2, BUYER, seller=seller)
    e = _ev(c, serial=SERIAL2, type="RESERVE", txSig=sig("o1"), actor=BUYER, payload={"priceUsdc": 1}).json()
    assert e["status"] == "confirmed" and e["payload"] == {"order": order_pda(SERIAL2, seller), "currency": "USDC",
                                                            "price": 390_000_000, "priceUsdc": 390, "buyer": BUYER}
    # an Order of another passport (correct PDA for that passport) does not bind to this one
    _order(c, SERIAL, MALLORY)
    rpc.add_tx(sig("o2"), signers=[BUYER], instructions=[
        (ESCROW_ID, "reserve", [fake_key("config"), order_pda(SERIAL, MALLORY), BUYER, fake_key("t"), fake_key("m"), fake_key("v"),
                                fake_key("tp"), SYSTEM_PROGRAM], b"")])
    assert _ev(c, serial=SERIAL2, type="RESERVE", txSig=sig("o2"), actor=BUYER).json()["detail"] == "tx_mismatch"
    # an account at this passport's Order PDA whose data names another passport is not this passport's order
    rpc.accounts[order_pda(SERIAL2, MALLORY)] = order_bytes(serial=SERIAL, seller=MALLORY)
    rpc.add_tx(sig("o4"), signers=[BUYER], instructions=[
        (ESCROW_ID, "reserve", [fake_key("config"), order_pda(SERIAL2, MALLORY), BUYER, fake_key("t"), fake_key("m"), fake_key("v"),
                                fake_key("tp"), SYSTEM_PROGRAM], b"")])
    assert _ev(c, serial=SERIAL2, type="RESERVE", txSig=sig("o4"), actor=BUYER).json()["detail"] == "tx_mismatch"
    # Order data at an address that is not its PDA is ignored
    fake_addr = fake_key("not-a-pda")
    rpc.accounts[fake_addr] = order_bytes(serial=SERIAL2, seller=seller)
    rpc.add_tx(sig("o3"), signers=[BUYER], instructions=[
        (ESCROW_ID, "reserve", [fake_key("config"), fake_addr, BUYER, fake_key("t"), fake_key("m"), fake_key("v"), fake_key("tp"),
                                SYSTEM_PROGRAM], b"")])
    assert _ev(c, serial=SERIAL2, type="RESERVE", txSig=sig("o3"), actor=BUYER).json()["detail"] == "tx_mismatch"


def test_list_price_comes_from_the_instruction(chain_client):
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx(sig("l1"), "list", SERIAL2, MALLORY, price=480_500_000)
    e = _ev(c, serial=SERIAL2, type="LIST", txSig=sig("l1"), actor=MALLORY, actorLabel="FlaconVault Vault",
            payload={"priceUsdc": 0.01, "market": "evil", "currency": "EUR"}).json()
    assert e["payload"] == {"order": order_pda(SERIAL2, MALLORY), "currency": "USDC", "price": 480_500_000, "priceUsdc": 480.5,
                            "seller": MALLORY}
    assert e["actorLabel"] is None
    # the OrderListed event, when logged by the escrow program, is used as well
    ev = encode_event("OrderListed", order=order_pda(SERIAL2, SELLER), passport=passport_pda(SERIAL2), seller=SELLER, price=500_000_000)
    rpc.escrow_tx(sig("l2"), "list", SERIAL2, SELLER, price=500_000_000, logs=program_logs(ESCROW_ID, ev))
    assert _ev(c, serial=SERIAL2, type="LIST", txSig=sig("l2"), actor=SELLER).json()["payload"]["priceUsdc"] == 500


def test_receipt_match_and_counters_come_from_the_chain(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller_scan, buyer_scan = fake_key("seller-scan"), fake_key("buyer-scan")
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=6, seller_scan=seller_scan, buyer_scan=buyer_scan)
    # 1. from the ReceiptScanRecorded event (the client claims a match the chain does not show)
    ev = encode_event("ReceiptScanRecorded", order=order_pda(SERIAL2, SELLER), scanProof=buyer_scan, counter=9, matched=False,
                      sellerFill=92, buyerFill=80)
    rpc.escrow_tx(sig("v1"), "record_receipt_scan", SERIAL2, BUYER, seller=SELLER, scan_proof=buyer_scan, seller_scan=seller_scan,
                  logs=program_logs(ESCROW_ID, ev))
    rpc.accounts[seller_scan] = scan_proof_account(seal=seal_pda("04DE5F1EACC040"), counter=8, fill=92)
    e = _ev(c, serial=SERIAL2, type="RECEIVE", txSig=sig("v1"), actor=BUYER,
            payload={"match": True, "fillDelta": 0, "receiptScanCounter": 1}).json()
    assert e["payload"] == {"order": order_pda(SERIAL2, SELLER), "preShipScanCounter": 8, "receiptScanCounter": 9, "match": False,
                            "fillDelta": 12}
    # 2. without logs (truncated): the program's rule over the two ScanProofs
    rpc.accounts[buyer_scan] = scan_proof_account(seal=seal_pda("04DE5F1EACC040"), counter=10, fill=90)
    rpc.escrow_tx(sig("v2"), "record_receipt_scan", SERIAL2, BUYER, seller=SELLER, scan_proof=buyer_scan, seller_scan=seller_scan)
    e = _ev(c, serial=SERIAL2, type="RECEIVE", txSig=sig("v2"), actor=BUYER, payload={"match": False}).json()
    assert e["payload"]["match"] is True and e["payload"]["fillDelta"] == 2 and e["payload"]["receiptScanCounter"] == 10
    # an event logged by another program (spoofed "Program data") is not the escrow's
    spoof = encode_event("ReceiptScanRecorded", order=order_pda(SERIAL2, SELLER), counter=99, matched=True)
    rpc.escrow_tx(sig("v3"), "record_receipt_scan", SERIAL2, BUYER, seller=SELLER, scan_proof=buyer_scan, seller_scan=seller_scan,
                  logs=program_logs(SYSTEM_PROGRAM, spoof))
    assert _ev(c, serial=SERIAL2, type="RECEIVE", txSig=sig("v3"), actor=BUYER).json()["payload"]["receiptScanCounter"] == 10


def test_ship_release_and_dispute_payloads(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller_scan = fake_key("pre-ship")
    rpc.accounts[seller_scan] = scan_proof_account(seal=seal_pda("04DE5F1EACC040"), counter=13)
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=3, seller_scan=seller_scan, price=480_000_000)
    rpc.escrow_tx(sig("h1"), "ship", SERIAL2, SELLER)
    e = _ev(c, serial=SERIAL2, type="SHIP", txSig=sig("h1"), actor=SELLER,
            payload={"carrier": "dhl ", "preShipScanCounter": 99, "insured": True}).json()
    assert e["payload"] == {"order": order_pda(SERIAL2, SELLER), "carrier": "DHL", "preShipScanCounter": 13}

    def counts(pk):
        a = c.get(f"/api/attester/{pk}").json()
        return a["escrowsOk"], a["escrowsDisputed"]

    rel = encode_event("OrderReleased", order=order_pda(SERIAL2, SELLER), seller=SELLER, buyer=BUYER, amount=480_000_000,
                       assetTransferred=False)
    rpc.escrow_tx(sig("h2"), "release", SERIAL2, BUYER, seller=SELLER, buyer=BUYER, logs=program_logs(ESCROW_ID, rel))
    e = _ev(c, serial=SERIAL2, type="RELEASE", txSig=sig("h2"), actor=BUYER,
            payload={"priceUsdc": 1, "to": MALLORY, "passportTo": BUYER}).json()
    assert e["payload"] == {"order": order_pda(SERIAL2, SELLER), "currency": "USDC", "price": 480_000_000, "priceUsdc": 480, "to": SELLER}
    # the counters follow the order's final state (seeded fake counters do not survive): seller and buyer
    assert counts(SELLER) == (1, 0) and counts(BUYER) == (1, 0)
    # repeating the same tx is idempotent: no second count
    _ev(c, serial=SERIAL2, type="RELEASE", txSig=sig("h2"), actor=BUYER)
    assert counts(SELLER) == (1, 0)

    # the seller closes the order and lists the bottle again (new listing on the same PDA); that one ends in a dispute
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=7, listed_at=1790000100)
    dis = encode_event("OrderDisputed", order=order_pda(SERIAL2, SELLER), by=BUYER, reason=2, refunded=480_000_000)
    rpc.escrow_tx(sig("h3"), "dispute", SERIAL2, BUYER, seller=SELLER, buyer=BUYER, logs=program_logs(ESCROW_ID, dis),
                  block_time=1790000200)
    e = _ev(c, serial=SERIAL2, type="DISPUTE", txSig=sig("h3"), actor=BUYER, payload={"reason": "seller is a scammer"}).json()
    assert e["payload"]["reason"] == "Seal not responding" and e["payload"]["reasonCode"] == 2 and e["payload"]["refundedUsdc"] == 480
    assert counts(SELLER) == (1, 1) and counts(BUYER) == (1, 1)


def test_first_poster_cannot_choose_the_payload_or_label(chain_client):
    c, rpc = chain_client, chain_client.rpc
    ev = encode_event("ReceiptScanRecorded", order=order_pda(SERIAL2, SELLER), counter=9, matched=False, sellerFill=90, buyerFill=60)
    rpc.escrow_tx(sig("f1"), "record_receipt_scan", SERIAL2, BUYER, seller=SELLER, logs=program_logs(ESCROW_ID, ev))
    _order(c, SERIAL2, SELLER, buyer=BUYER, state=6)
    forged = _ev(c, serial=SERIAL2, type="RECEIVE", txSig=sig("f1"), actor=BUYER, actorLabel="Known scammer",
                 payload={"match": True, "blob": "x" * 15000}).json()
    genuine = _ev(c, serial=SERIAL2, type="RECEIVE", txSig=sig("f1"), actor=BUYER, payload={"match": False}).json()
    assert forged == genuine and genuine["payload"]["match"] is False and "blob" not in genuine["payload"]
    assert c.get(f"/api/attester/{BUYER}").json()["label"] is None


def test_lookups_are_cached_and_bounded(chain_client, monkeypatch):
    import fv.txverify as tv
    c, rpc = chain_client, chain_client.rpc
    rpc.escrow_tx(sig("c1"), "list", SERIAL2, MALLORY)
    assert _ev(c, serial=SERIAL2, type="LIST", txSig=sig("c1"), actor=MALLORY).status_code == 200
    n = rpc.calls.count("getTransaction")
    tv.verify_transaction(rpc, sig("c1"), MALLORY, tv.Expectation(program=ESCROW_ID, instructions=("list",),
                                                                   passport=passport_pda(SERIAL2), escrow=True))
    assert rpc.calls.count("getTransaction") == n                        # a confirmed tx is fetched once
    # a signature that was just not found is answered from the miss cache for a moment
    monkeypatch.setattr(tv, "MISS_CACHE_TTL_S", 60.0)
    assert _ev(c, serial=SERIAL2, type="LIST", txSig=sig("missing"), actor=MALLORY).status_code == 503
    n = rpc.calls.count("getTransaction")
    assert _ev(c, serial=SERIAL2, type="LIST", txSig=sig("missing"), actor=MALLORY).json()["detail"] == "tx_not_visible"
    assert rpc.calls.count("getTransaction") == n
    # no free RPC slot (all in flight): a global condition → 503 busy with Retry-After, without any RPC call
    n_rpc = len(rpc.calls)
    held = 0
    while tv._SLOTS.acquire(blocking=False):
        held += 1
    try:
        r = _ev(c, serial=SERIAL2, type="LIST", txSig=sig("busy"), actor=MALLORY)
        assert r.status_code == 503 and r.json()["detail"] == "busy" and int(r.headers["retry-after"]) >= 1
        assert len(rpc.calls) == n_rpc
    finally:
        for _ in range(held):
            tv._SLOTS.release()
    assert held == tv.MAX_CONCURRENT_LOOKUPS


def test_program_events_follow_the_invoke_stack():
    import base64
    from fv.txverify import program_events
    a, b = b"\x01" * 9, b"\x02" * 9
    logs = [f"Program {ESCROW_ID} invoke [1]", f"Program {SYSTEM_PROGRAM} invoke [2]",
            f"Program data: {base64.b64encode(b).decode()}", f"Program {SYSTEM_PROGRAM} success",
            f"Program data: {base64.b64encode(a).decode()}", f"Program log: Program data: {base64.b64encode(b).decode()}",
            f"Program {ESCROW_ID} success", f"Program data: {base64.b64encode(b).decode()}"]
    assert program_events(logs, ESCROW_ID) == [a]
    assert program_events(logs, SYSTEM_PROGRAM) == [b]
