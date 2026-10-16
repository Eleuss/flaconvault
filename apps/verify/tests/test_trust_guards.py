"""Guards that single mutations used to survive (A5), and the chain layouts pinned to the IDLs in packages/proof/src/idl:
an instruction account, argument, event field or Order field that moves in the programs fails here, not in production."""
import hashlib
import json
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from solders.pubkey import Pubkey

import fv.reconcile as rc
import fv.txverify as tv
from tests.conftest import (ESCROW_ID, PROGRAM_ID, REPO, encode_event, fake_key, order_bytes, order_pda, passport_pda,
                            program_logs, registry_pda, scan_proof_account, seal_pda, sig)

IDL_DIR = REPO / "packages" / "proof" / "src" / "idl"
SERIAL = "SN-2026-000001"
SERIAL2 = "SN-2026-000002"
SEEDED_UID = "04A1B2C3D4E5F6"                     # the seeded seal of SN-2026-000001
PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"
BUYER = str(Pubkey.from_bytes(hashlib.sha256(b"buyer").digest()))


# ---------- chain layouts = IDL ----------

def _idl(name: str) -> dict:
    return json.loads((IDL_DIR / f"{name}.json").read_text(encoding="utf-8"))


def _camel(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(w.capitalize() for w in rest)


def _kind(t) -> str:
    if isinstance(t, str):
        return {"u8": "u8", "u16": "u16", "u32": "u32", "u64": "u64", "i64": "i64", "bool": "b", "pubkey": "pk"}[t]
    if isinstance(t, dict) and t.get("array") == ["u8", 32]:
        return "h32"
    raise AssertionError(f"unexpected IDL type {t!r}")


_SIZE = {"u8": 1, "u16": 2, "u32": 4, "u64": 8, "i64": 8, "b": 1, "pk": 32, "h32": 32}

# IX_ACCOUNTS role → IDL account name, per instruction ("signer" is the account the actor must be)
ROLE_NAMES = {
    "mint_passport": {"passport": "passport", "signer": "issuer", "core_asset": "core_asset"},
    "attach_seal": {"passport": "passport", "seal": "seal", "signer": "signer"},
    "mark_seal_dead": {"passport": "passport", "seal": "seal", "signer": "signer"},
    "record_scan": {"passport": "passport", "seal": "seal", "scan": "scan_proof", "signer": "attester"},
    "list": {"passport": "passport", "order": "order", "signer": "seller"},
    "reserve": {"order": "order", "signer": "buyer"},
    "ship": {"order": "order", "signer": "seller"},
    "record_pre_ship_scan": {"order": "order", "signer": "seller", "scan": "scan_proof"},
    "record_receipt_scan": {"order": "order", "signer": "buyer", "scan": "scan_proof", "seal": "seal", "seller_scan": "seller_scan"},
    "release": {"order": "order", "buyer": "buyer", "signer": "caller"},
    "release_after_timeout": {"order": "order", "buyer": "buyer", "signer": "caller"},
    "dispute": {"order": "order", "buyer": "buyer", "seller": "seller", "signer": "signer", "seal": "seal"},
    "resolve": {"order": "order", "buyer": "buyer", "seller": "seller", "signer": "admin"},
}


def _instructions() -> dict[str, dict]:
    out = {}
    for prog in ("flacon", "escrow"):
        for ix in _idl(prog)["instructions"]:
            out[ix["name"]] = ix
    return out


def _types() -> dict[str, dict]:
    out = {}
    for prog in ("flacon", "escrow"):
        for t in _idl(prog)["types"]:
            out.setdefault(t["name"], t)
    return out


def test_instruction_account_positions_match_the_idl():
    ixs = _instructions()
    assert set(tv.IX_ACCOUNTS) == set(ROLE_NAMES)
    for name, roles in tv.IX_ACCOUNTS.items():
        accounts = [a["name"] for a in ixs[name]["accounts"]]
        assert set(roles) == set(ROLE_NAMES[name]), name
        for role, pos in roles.items():
            assert accounts[pos] == ROLE_NAMES[name][role], (name, role, pos, accounts)
        signer = ixs[name]["accounts"][roles["signer"]]
        assert signer.get("signer") is True, (name, signer)
    # every instruction accepted as evidence has its positions
    for names in (*tv.FLACON_IX.values(), *tv.ESCROW_IX.values()):
        for n in names:
            assert n in tv.IX_ACCOUNTS and n in ixs, n


def test_instruction_args_match_the_idl():
    ixs, types = _instructions(), _types()
    for name, layout in tv._ARG_LAYOUTS.items():
        args = ixs[name]["args"]
        if len(args) == 1 and isinstance(args[0]["type"], dict) and "defined" in args[0]["type"]:   # record_scan(args)
            args = types[args[0]["type"]["defined"]["name"]]["type"]["fields"]
        assert [(_camel(a["name"]), _kind(a["type"])) for a in args] == layout, name
    # the discriminators are Anchor's for these names
    for name in tv._ARG_LAYOUTS:
        assert list(tv.anchor_discriminator(name)) == ixs[name]["discriminator"], name


def test_event_layouts_match_the_idl():
    types = {t["name"]: t for t in _idl("escrow")["types"]}
    events = {e["name"]: e for e in _idl("escrow")["events"]}
    for name, layout in tv._EVENT_LAYOUTS.items():
        fields = types[name]["type"]["fields"]
        assert [(_camel(f["name"]), _kind(f["type"])) for f in fields] == layout, name
        assert list(tv.event_discriminator(name)) == events[name]["discriminator"], name


def test_order_layout_matches_the_idl():
    order = {t["name"]: t for t in _idl("escrow")["types"]}["Order"]["type"]["fields"]
    kinds = [_kind(f["type"]) for f in order]
    assert 8 + sum(_SIZE[k] for k in kinds) == tv.ORDER_LEN == 244
    decoded = tv.decode_order(order_bytes(serial=SERIAL, seller=SELLER, buyer=BUYER, price=123, state=4))
    assert list(decoded) == [_camel(f["name"]) for f in order]
    assert decoded["passport"] == passport_pda(SERIAL) and decoded["buyer"] == BUYER and decoded["price"] == 123
    assert list(tv.ORDER_DISC) == {a["name"]: a for a in _idl("escrow")["accounts"]}["Order"]["discriminator"]


def test_scan_proof_layout_matches_the_idl():
    from fv.chain import decode_scan_proof
    fields = {t["name"]: t for t in _idl("flacon")["types"]}["ScanProof"]["type"]["fields"]
    names = [_camel(f["name"]).replace("heatLevels", "heatLevelsMask") for f in fields]
    sp = decode_scan_proof(scan_proof_account(seal=seal_pda(SEEDED_UID), counter=7))
    assert list(sp) == names and sp["counter"] == 7
    assert list(tv.SCAN_PROOF_DISC) == {a["name"]: a for a in _idl("flacon")["accounts"]}["ScanProof"]["discriminator"]


# ---------- helpers ----------

def _ev(c, **body):
    return c.post("/api/events", json=body)


def _tag(c, serial=SERIAL):
    return c.post("/api/dev/tag", json={"serial": serial, "kind": 1}).json()["uid"]


def _body(tap, nonce, **over):
    b = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 1,
         "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "attester": SELLER,
         "platform": "SIMULATOR"}
    b.update(over)
    return b


def _scan(c, uid, **over):
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = c.post("/api/session", json={}).json()["nonce"]
    return c.post("/api/verify", json=_body(tap, nonce, **over)).json()


def _event(c, eid, serial=SERIAL):
    return next(e for e in c.get(f"/api/passport/{serial}").json()["events"] if e["id"] == eid)


# ---------- (1) one tx, several escrow instructions: each event reads its own order ----------

def test_each_list_of_a_two_order_tx_gets_its_own_price(chain_client):
    c, rpc = chain_client, chain_client.rpc
    ev1 = encode_event("OrderListed", order=order_pda(SERIAL, SELLER), passport=passport_pda(SERIAL), seller=SELLER, price=100_000_000)
    ev2 = encode_event("OrderListed", order=order_pda(SERIAL2, SELLER), passport=passport_pda(SERIAL2), seller=SELLER, price=250_000_000)
    f = fake_key
    rpc.add_tx(sig("two-lists"), signers=[SELLER], logs=program_logs(ESCROW_ID, ev1) + program_logs(ESCROW_ID, ev2), instructions=[
        (ESCROW_ID, "list", [f("config"), passport_pda(SERIAL), order_pda(SERIAL, SELLER), SELLER, f("sys")], (100_000_000).to_bytes(8, "little")),
        (ESCROW_ID, "list", [f("config"), passport_pda(SERIAL2), order_pda(SERIAL2, SELLER), SELLER, f("sys")], (250_000_000).to_bytes(8, "little")),
    ])
    a = _ev(c, serial=SERIAL, type="LIST", txSig=sig("two-lists"), actor=SELLER).json()
    b = _ev(c, serial=SERIAL2, type="LIST", txSig=sig("two-lists"), actor=SELLER).json()
    assert (a["payload"]["price"], a["payload"]["order"]) == (100_000_000, order_pda(SERIAL, SELLER))
    assert (b["payload"]["price"], b["payload"]["order"]) == (250_000_000, order_pda(SERIAL2, SELLER))


def test_each_receipt_of_a_two_order_tx_gets_its_own_match(chain_client):
    c, rpc = chain_client, chain_client.rpc
    for serial, state in ((SERIAL, 6), (SERIAL2, 4)):
        rpc.accounts[order_pda(serial, SELLER)] = order_bytes(serial=serial, seller=SELLER, buyer=BUYER, state=state)
    mismatch = encode_event("ReceiptScanRecorded", order=order_pda(SERIAL, SELLER), counter=5, matched=False, sellerFill=90, buyerFill=40)
    match = encode_event("ReceiptScanRecorded", order=order_pda(SERIAL2, SELLER), counter=6, matched=True, sellerFill=90, buyerFill=89)
    f = fake_key
    rpc.add_tx(sig("two-receipts"), signers=[BUYER], logs=program_logs(ESCROW_ID, mismatch) + program_logs(ESCROW_ID, match),
               instructions=[(ESCROW_ID, "record_receipt_scan", [order_pda(SERIAL, SELLER), BUYER, f("s1"), f("seal1"), f("ss1")], b""),
                             (ESCROW_ID, "record_receipt_scan", [order_pda(SERIAL2, SELLER), BUYER, f("s2"), f("seal2"), f("ss2")], b"")])
    e = _ev(c, serial=SERIAL2, type="RECEIVE", txSig=sig("two-receipts"), actor=BUYER).json()
    assert e["payload"]["match"] is True and e["payload"]["receiptScanCounter"] == 6 and e["payload"]["fillDelta"] == 1


# ---------- (2) seal positions ----------

def test_mark_seal_dead_without_seal_hash_marks_the_seal_at_its_position(chain_client):
    c, rpc = chain_client, chain_client.rpc
    second = _tag(c)                                                     # SN-2026-000001 now has two seals
    rpc.dead_tx(sig("dead-2nd"), SERIAL, second, PARTNER)
    assert _ev(c, serial=SERIAL, type="SEAL_DEAD", txSig=sig("dead-2nd"), actor=PARTNER).json()["status"] == "confirmed"
    from fv import proof
    seals = {s["uidHash"]: s["dead"] for s in c.get(f"/api/passport/{SERIAL}").json()["seals"]}
    assert seals["0x" + proof.uid_hash(bytes.fromhex(second)).hex()] is True
    assert seals["0x" + proof.uid_hash(bytes.fromhex(SEEDED_UID)).hex()] is False


def test_mark_seal_dead_of_seal_a_with_seal_b_appended_does_not_kill_b(chain_client):
    from fv import proof
    c, rpc = chain_client, chain_client.rpc
    second = _tag(c)
    rpc.add_tx(sig("dead-ab"), signers=[PARTNER], instructions=[
        (PROGRAM_ID, "mark_seal_dead", [registry_pda(), passport_pda(SERIAL), seal_pda(SEEDED_UID), PARTNER, seal_pda(second)], b"")])
    r = _ev(c, serial=SERIAL, type="SEAL_DEAD", txSig=sig("dead-ab"), actor=PARTNER,
            sealUidHash="0x" + proof.uid_hash(bytes.fromhex(second)).hex())
    assert r.status_code == 403 and r.json()["detail"] == "tx_mismatch"
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert not any(s["dead"] for s in p["seals"]) and p["void"] is False


# ---------- (3) record_scan: ScanProof position and counter argument, each on its own ----------

def test_record_scan_must_name_this_counters_scan_proof_at_its_position(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _scan(c, _tag(c))
    # args say counter N, but the ScanProof at position 3 is N+1's; N's PDA only appended
    accounts = rpc.record_scan_accounts(v, SELLER, counter=v["counter"] + 1) + [rpc.record_scan_accounts(v, SELLER)[3]]
    rpc.add_tx(sig("pos"), signers=[SELLER], instructions=[(PROGRAM_ID, "record_scan", accounts, rpc.record_scan_args(v))])
    r = _ev(c, eventId=v["eventId"], txSig=sig("pos"))
    assert r.status_code == 403 and r.json()["detail"] == "tx_mismatch" and _event(c, v["eventId"])["status"] == "pending"


def test_record_scan_counter_argument_must_be_the_scans(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _scan(c, _tag(c))
    # the ScanProof at position 3 is N's, but the counter argument is N+1
    rpc.add_tx(sig("ctr"), signers=[SELLER], instructions=[
        (PROGRAM_ID, "record_scan", rpc.record_scan_accounts(v, SELLER), rpc.record_scan_args(v, counter=v["counter"] + 1))])
    r = _ev(c, eventId=v["eventId"], txSig=sig("ctr"))
    assert r.status_code == 403 and r.json()["detail"] == "tx_mismatch" and _event(c, v["eventId"])["status"] == "pending"


# ---------- (4) resume link only while pending ----------

def test_resume_link_is_spent_after_reconcile_confirms_or_fails_the_scan(chain_client, settings):
    from fv.chain import pda_scan, pda_seal
    from fv.db import now
    from tests.test_reconcile import _account_for
    c, rpc = chain_client, chain_client.rpc
    confirmed, failed = _scan(c, _tag(c)), _scan(c, _tag(c))
    for v in (confirmed, failed):
        assert c.get(f"/api/verify/{v['eventId']}", params={"token": v["resumeToken"]}).status_code == 200
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(confirmed["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, confirmed["counter"]))] = _account_for(confirmed)
    s = rc.reconcile_once(c.app.state.db, settings, rpc, ts=now() + settings.reconcile_timeout_s + 5)
    assert s["confirmed"] == 1 and s["failed"] >= 1
    assert _event(c, confirmed["eventId"])["status"] == "confirmed" and _event(c, failed["eventId"])["status"] == "failed"
    for v in (confirmed, failed):
        r = c.get(f"/api/verify/{v['eventId']}", params={"token": v["resumeToken"]})
        assert r.status_code == 404 and r.json()["detail"] == "resume_not_found"


def test_resume_get_is_rate_limited(settings, monkeypatch):
    from fv.main import create_app
    monkeypatch.setenv("FV_RATE_LIMIT_PER_MIN", "3")
    app = create_app(settings)
    with TestClient(app, client=("203.0.113.60", 1)) as setup:
        app.state.rate_limiters = {}
        tap = setup.post("/api/dev/tap", json={"uid": SEEDED_UID}).json()
        nonce = setup.post("/api/session", json={}).json()["nonce"]
        v = setup.post("/api/verify", json=_body(tap, nonce)).json()
        assert v["verdict"] == "VALID"
    with TestClient(app, client=("203.0.113.61", 1)) as c:
        codes = [c.get(f"/api/verify/{v['eventId']}", params={"token": v["resumeToken"]}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


# ---------- (5) /api/verify input guards ----------

def test_a_non_base58_attester_is_refused(chain_client):
    c = chain_client
    tap = c.post("/api/dev/tap", json={"uid": SEEDED_UID}).json()
    nonce = c.post("/api/session", json={}).json()["nonce"]
    for bad in ("0" * 40, "O" * 44, "l" * 32):
        r = c.post("/api/verify", json=_body(tap, nonce, tier=0, role=0, attester=bad))
        assert r.status_code == 422 and "attester" in r.json()["detail"], bad
    assert c.post("/api/verify", json=_body(tap, nonce, tier=0, role=0)).json()["verdict"] == "VALID"   # tap not consumed


def test_a_dead_seal_never_gets_a_signature_at_verify(chain_client):
    c = chain_client
    uid = _tag(c)
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE seals SET dead=1 WHERE uid_hex=?", (uid,))
    n_events = len(c.get(f"/api/passport/{SERIAL}").json()["events"])
    v = _scan(c, uid)
    assert v["verdict"] == "NO_RESPONSE" and v["serverSig"] is None and v["msgHex"] is None and v["eventId"] is None
    assert "resumeToken" not in v and len(c.get(f"/api/passport/{SERIAL}").json()["events"]) == n_events


def test_an_adopted_tap_whose_seal_died_meanwhile_gets_no_signature(chain_client):
    c = chain_client
    uid = _tag(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    q = parse_qs(urlparse(c.get(tap["url"], follow_redirects=False).headers["location"]).query)
    with c.app.state.db.connect() as conn:                       # a partner's mark_seal_dead lands within the 180 s
        conn.execute("UPDATE seals SET dead=1 WHERE uid_hex=?", (uid,))
    nonce = c.post("/api/session", json={}).json()["nonce"]
    v = c.post("/api/verify", json={**_body({"uid": None, "ctrHex": None, "cmac": None}, nonce), "tapId": int(q["tap"][0]),
                                    "tapToken": q["k"][0]}).json()
    assert v["verdict"] == "NO_RESPONSE" and v["serverSig"] is None and v["eventId"] is None


# ---------- (6) the passport list's lastEventTs ignores pending scans ----------

def test_a_pending_scan_does_not_move_last_event_ts(chain_client):
    c = chain_client
    before = next(p for p in c.get("/api/passports").json() if p["serial"] == SERIAL)
    v = _scan(c, SEEDED_UID)
    assert v["verdict"] == "VALID" and _event(c, v["eventId"])["status"] == "pending"
    after = next(p for p in c.get("/api/passports").json() if p["serial"] == SERIAL)
    assert after["lastEventTs"] == before["lastEventTs"] and after["scanCount"] == before["scanCount"]

