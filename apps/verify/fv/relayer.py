"""
Public-record relay (docs/public-record.md §9.4–9.8) — the first code in fv that sends transactions.

The verifier signs a scan as FVSCAN2 (once, when its relay_tx row is created: D13) and the relayer key
(FV_RELAYER_KEY, fee payer only, no program authority) sends

    [SetComputeUnitLimit, SetComputeUnitPrice, Ed25519(scan key, FVSCAN2), record_scan_v2(key_id)]

record_scan_v2 creates no account, so a relay scan costs only the transaction fee. Nothing else is ever signed by the
relayer: every message passes check_relay_shape (the instruction-shape allowlist) before the relayer key signs it. The
Ed25519 instruction carries the scan key that signed the row (relay_tx.server_pubkey), so a key rotation does not
strand the rows signed before it.

Rows (relay_tx) and their states: queued → sending → recorded, or over_cap / failed (terminal), or replaced (a CHECK
of the same tap took its place). Idempotency: at most one live row (queued, sending, recorded) per (seal, counter) —
the partial unique index relay_tx_live_ref — and a row is never re-sent while its previous attempt could still land
(it stays `sending` until getSignatureStatuses knows it or its blockhash has expired; that includes a send whose
primary RPC failed on the transport, whatever the fallback then answers). An attempt is given up only on the word of
the primary RPC, the source with the full history (the fallback, which may keep none, is asked as a second source and
must not know it either; while only the fallback answers, the row waits), and its signature is kept
(relay_tx.earlier_sigs): before a row with earlier attempts ends without being recorded (counter_used above all), they
are looked up, and one that landed records the row with its own signature. Should two attempts ever land, the second
fails on chain with CounterNotIncreasing: nothing is recorded twice. The ts + 570 s deadline is checked against the
clock at the moment a row is claimed for sending, not the start of the relay cycle.

Adoption (§9.4): a scan session that adopts a /t tap may take the counter of that tap's TAP row only while the TAP was
never sent. A row counts as sent once a transaction of it went out: sending, recorded, or queued again with earlier
attempts (given up, yet it may have landed unseen). was_sent is the one rule for it: the adopter is answered REPLAY and
the row is never replaced (replace_tap), so it stays the row that records its own transaction.

Caps: a visitor (actor NONE) gets at most VISITOR_TAPS_PER_SEAL_24H recorded TAPs and VISITOR_CHECKS_PER_SEAL_24H
CHECK per seal per rolling 24 h (owner decision, code constants: D16); a global fee cap per UTC day
(FV_RELAY_DAILY_LAMPORTS, relay_budget); FV_RELAY_ENABLED is the kill switch (false = rows fail `relay_off`, nothing
is sent, the loop does not run). The relayer balance is read at most every BALANCE_CHECK_S; below
FV_RELAY_LOW_BALANCE_LAMPORTS it warns (at most hourly) and GET /health says relay.ok false.

All RPC calls happen outside SQLite write transactions (same pattern as the reconcile job); every write re-checks the
row's status. RPC errors are logged by method and code only: an RPC URL can carry an API key.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from fv import proof
from fv.chain import (DecodeError, RpcError, decode_holder_config, decode_holding, decode_passport, decode_seal,
                      pda_event_authority, pda_holder_config, pda_holding, pda_passport, pda_registry, pda_seal,
                      program_pubkey)
from fv.config import Settings
from fv.db import drop_superseded_sighting, get_event, transaction
from fv.enums import ActorKind, Cluster, EventType, Grade, Purpose, SealKind
from fv.service import ADOPT_WINDOW_S, apply_relayed_scan

log = logging.getLogger("fv.relayer")

VISITOR_TAPS_PER_SEAL_24H = 3
VISITOR_CHECKS_PER_SEAL_24H = 1
CAP_WINDOW_S = 86400
TAP_DUE_DELAY_S = ADOPT_WINDOW_S + 5          # a /t tap is sent once no scan session can adopt it any more (185 s)
MAX_SCAN_TS_SKEW_S = 600                      # record_scan_v2: |msg.ts − cluster clock| ≤ 600 s
DEADLINE_MARGIN_S = 30
SEND_WINDOW_S = MAX_SCAN_TS_SKEW_S - DEADLINE_MARGIN_S   # deadline = ts + 570
RETRY_BACKOFF_S = (2, 4, 8, 16, 30)
SIGNATURE_FEE_LAMPORTS = 5000                 # per signature; the Ed25519 precompile signature is charged like one
BALANCE_CHECK_S = 60
LOW_BALANCE_LOG_S = 3600
HOLDER_CONFIG_RETRY_S = 60
PRIORITY_PERCENTILE = 75

COMPUTE_BUDGET_PROGRAM = Pubkey.from_string("ComputeBudget111111111111111111111111111111")
ED25519_PROGRAM = Pubkey.from_string("Ed25519SigVerify111111111111111111111111111")
SYSVAR_INSTRUCTIONS = Pubkey.from_string("Sysvar1nstructions1111111111111111111111111")
RECORD_SCAN_V2_DISC = hashlib.sha256(b"global:record_scan_v2").digest()[:8]
# record_scan_v2 accounts in IDL order (§7.6); optional accounts are the program id when absent (Anchor's None)
RECORD_SCAN_V2_ACCOUNTS = ("registry", "holder_config", "passport", "seal", "holding", "instructions", "actor_signer", "asset",
                           "event_authority", "program")
RECORD_SCAN_V2_WRITABLE = frozenset({"passport", "seal", "holding"})
ED25519_HEADER_V2 = bytes.fromhex("01003000ffff1000ffff70000001ffff")   # §3.6 for a 256-byte message
ED25519_DATA_LEN_V2 = len(ED25519_HEADER_V2) + 32 + 64 + proof.MSG2_LEN    # 368

LIVE = ("queued", "sending", "recorded")
_LIVE_SQL = "('queued','sending','recorded')"
API_STATE = {"queued": "pending", "sending": "pending", "recorded": "recorded", "over_cap": "over_cap", "failed": "failed"}


def now_ts() -> int:
    return int(time.time())


def scan_ref(seal_uid_hash: str, counter: int) -> str:
    """Idempotency key of a scan row: '<seal uid_hash hex>:<counter>'."""
    return f"{seal_uid_hash.lower()}:{int(counter)}"


def cluster_name(settings: Settings) -> str:
    return settings.cluster.upper()


# ---------- rows ----------

def _row(r) -> dict | None:
    return dict(r) if r is not None else None


def get_row(conn, row_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM relay_tx WHERE id=?", (row_id,)).fetchone())


def live_row(conn, seal_uid_hash: str, counter: int) -> dict | None:
    """The live (queued, sending, recorded) row of a (seal, counter), if any."""
    return _row(conn.execute(f"SELECT * FROM relay_tx WHERE kind='scan' AND ref=? AND status IN {_LIVE_SQL}",
                             (scan_ref(seal_uid_hash, counter),)).fetchone())


def was_sent(row: dict | None) -> bool:
    """
    The one rule for "a transaction of this row went out, so its counter may be used on chain" (§9.4): the row is
    `sending`, `recorded`, or `queued` again with earlier attempts (earlier_sigs: sent at least once, given up and
    requeued — such an attempt may have landed unseen, §9.5). An adoption of such a row's tap answers REPLAY, and the row
    is never replaced (replace_tap). A queued row that was only tried (attempts > 0 after RPC trouble, or a send the node
    refused: nothing left the node, no earlier_sigs) was not sent. False for no row and for a row that is not live.
    """
    if not row:
        return False
    return row["status"] in ("sending", "recorded") or (row["status"] == "queued" and bool(earlier_attempts(row)))


def row_for_tap(conn, seal_uid_hash: str, counter: int) -> dict | None:
    """What a tap's public record is: its live row (the CHECK's once it replaced the TAP), else its newest other row."""
    return live_row(conn, seal_uid_hash, counter) or _row(conn.execute(
        "SELECT * FROM relay_tx WHERE kind='scan' AND ref=? AND status!='replaced' ORDER BY id DESC LIMIT 1",
        (scan_ref(seal_uid_hash, counter),)).fetchone())


def row_for_event(conn, event_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM relay_tx WHERE event_id=? AND status!='replaced' ORDER BY id DESC LIMIT 1",
                             (event_id,)).fetchone())


def record_view(row: dict | None, settings: Settings) -> dict | None:
    """The API record object (§9.9): dueAt only while pending, txSig only when recorded, reason only for over_cap/failed."""
    if row is None or row["status"] == "replaced":
        return None
    state = API_STATE[row["status"]]
    return {"state": state, "purpose": Purpose.name(int(row["purpose"])), "eventId": row["event_id"],
            "dueAt": int(row["due_at"]) if state == "pending" else None,
            "txSig": row["sig"] if state == "recorded" else None,
            "reason": row["reason"] if state in ("over_cap", "failed") else None,
            "cluster": cluster_name(settings)}


def visitor_cap_full(conn, seal_uid_hash: str, purpose: int, now: int) -> bool:
    """Visitor cap (actor NONE): live rows of this seal and purpose created in the last CAP_WINDOW_S."""
    limit = {Purpose.TAP: VISITOR_TAPS_PER_SEAL_24H, Purpose.CHECK: VISITOR_CHECKS_PER_SEAL_24H}.get(int(purpose))
    if limit is None:
        return False
    n = conn.execute(f"""SELECT COUNT(*) FROM relay_tx WHERE kind='scan' AND seal_uid_hash=? AND purpose=? AND actor_kind=?
                           AND status IN {_LIVE_SQL} AND created_at > ?""",
                     (seal_uid_hash.lower(), int(purpose), ActorKind.NONE, int(now) - CAP_WINDOW_S)).fetchone()[0]
    return int(n) >= limit


def relayable(conn, seal: dict) -> bool:
    """No row for a passport the verifier knows is void, a dead seal, an unregistered tag or a seal kind v2 cannot name."""
    if not seal or seal.get("dead") or int(seal.get("kind", -1)) not in (SealKind.BOX, SealKind.NECK):
        return False
    p = conn.execute("SELECT grade, void FROM passports WHERE serial=?", (seal["serial"],)).fetchone()
    return bool(p) and not p["void"] and int(p["grade"]) != Grade.VOID


# ---------- signing (D13: once, when the row is created) ----------

@dataclass
class SignedScan:
    bundle: dict
    bundle_hash: bytes
    msg: bytes
    sig: bytes
    key_id: int
    pubkey: bytes                                 # the scan key that signed msg (Ed25519 public key, 32 bytes)


def sign_scan(settings: Settings, *, seal: dict, counter: int, purpose: int, actor_kind: int, ts: int, fields: dict,
              actor: bytes = proof.ZERO32) -> SignedScan:
    """
    FVSCAN2 + v2 bundle for `seal` / `counter`, bound to settings.v2_program_id and FV_CLUSTER. `fields`: tier, role,
    site_id, tamper, heat, hum, uv, heat_levels (mask), fill, country, media_hash_b, nonce_b, issued_at (optional
    loop_intact). Raises proof.ScanFieldError for anything record_scan_v2 would reject.
    """
    program_id = bytes(Pubkey.from_string(settings.v2_program_id))
    bundle, b_hash, msg, sig = proof.build_scan_v2(
        seed=settings.server_seed, key_id=settings.server_key_id, program_id=program_id, cluster_tag=settings.cluster_tag,
        serial=seal["serial"], uid_hash_b=bytes.fromhex(seal["uid_hash"]), seal_kind=int(seal["kind"]), counter=int(counter),
        purpose=int(purpose), actor_kind=int(actor_kind), actor=actor, ts=int(ts), **fields)
    return SignedScan(bundle=bundle, bundle_hash=b_hash, msg=msg, sig=sig, key_id=settings.server_key_id,
                      pubkey=proof.public_key(settings.server_seed))


def queue_scan(conn, settings: Settings, *, event: dict | None, seal: dict, counter: int, purpose: int, actor_kind: int,
               ts: int, due_at: int, bundle_fields: dict | None = None, signed: SignedScan | None = None,
               now: int | None = None) -> dict | None:
    """
    Insert the relay row of a scan inside the caller's write transaction (§9.4) and settle its event if the row is
    terminal right away. The message is signed here unless the caller signed it already (`signed`, e.g. a CHECK whose
    event payload carries it). Status, in this order: FV_RELAY_ENABLED false → failed/relay_off (still built and
    signed); visitor cap → over_cap/seal_daily; otherwise queued. None (no row) for a void passport, a dead seal or an
    unregistered tag.
    """
    if not relayable(conn, seal):
        return None
    now = now_ts() if now is None else int(now)
    if signed is None:
        signed = sign_scan(settings, seal=seal, counter=counter, purpose=purpose, actor_kind=actor_kind, ts=ts,
                           fields=bundle_fields or {})
    if not settings.relay_enabled:
        status, reason = "failed", "relay_off"
    elif int(actor_kind) == ActorKind.NONE and visitor_cap_full(conn, seal["uid_hash"], purpose, now):
        status, reason = "over_cap", "seal_daily"
    else:
        status, reason = "queued", None
    cur = conn.execute(
        """INSERT INTO relay_tx(kind, ref, event_id, seal_uid_hash, counter, purpose, actor_kind, msg_hex, server_sig, key_id,
                                server_pubkey, bundle_json, due_at, deadline_at, status, reason, created_at, updated_at)
           VALUES('scan',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (scan_ref(seal["uid_hash"], counter), event["id"] if event else None, seal["uid_hash"].lower(), int(counter),
         int(purpose), int(actor_kind), signed.msg.hex(), signed.sig.hex(), signed.key_id, signed.pubkey.hex(),
         proof.canonical_json(signed.bundle), int(due_at), int(ts) + SEND_WINDOW_S, status, reason, now, now))
    row = get_row(conn, cur.lastrowid)
    if status != "queued":
        settle_event(conn, row, now)
    return row


def replace_tap(conn, row: dict, now: int) -> bool:
    """
    A queued TAP row that was never sent gives way to the CHECK (or the wallet's v1 scan) that adopted its tap (inside the
    caller's write transaction). A row that counts as sent (was_sent, read again here: a queued row with earlier attempts
    too) is never replaced — one of its transactions may be on chain, and the row is what records it (§9.5). False when
    nothing was written (sent, or moved meanwhile).
    """
    fresh = get_row(conn, row["id"])
    if not fresh or was_sent(fresh):
        return False
    # the write holds only for the state just judged: still queued, with the same (empty) earlier_sigs
    cur = conn.execute("""UPDATE relay_tx SET status='replaced', updated_at=?
                          WHERE id=? AND status='queued' AND earlier_sigs IS ?""", (int(now), fresh["id"], fresh["earlier_sigs"]))
    return cur.rowcount == 1


# ---------- events (§9.8) ----------

def settle_event(conn, row: dict, now: int) -> None:
    """
    The SCAN event of a row that just became terminal (inside the caller's write transaction):
      * TAP: the /t sighting stays as it is; once recorded it gains tx_sig and the FVSCAN2 detail (anchor, purpose,
        actorKind, msgHex, bundleHash, bundleV2), so it counts in onChainScanCount like the chain's scan_count;
      * CHECK (its own pending event): confirmed — with tx_sig when recorded, without when over_cap / failed (a genuine
        off-chain scan, never `failed`) — then service.apply_relayed_scan (no grade change for a visitor). The /t
        sighting of the same tap is dropped unless a TAP row of that counter can still record it (queued, sending,
        recorded): one physical tap shows once, as on the v1 path;
      * a TAP that ends without being recorded while a confirmed relay CHECK of the same tap exists (the CHECK was over
        cap and kept the TAP) drops its sighting the same way.
    """
    if not row.get("event_id"):
        return
    ev = get_event(conn, row["event_id"])
    if not ev:
        return
    payload = json.loads(ev["payload_json"] or "{}")
    recorded = row["status"] == "recorded"
    if int(row["purpose"]) == Purpose.TAP:
        if recorded:
            payload.update(_relay_detail(row))
            conn.execute("UPDATE events SET tx_sig=?, payload_json=? WHERE id=?",
                         (row["sig"], json.dumps(payload, ensure_ascii=False, sort_keys=True), ev["id"]))
        elif ev.get("seal_uid_hash"):
            check = conn.execute("""SELECT id FROM events WHERE serial=? AND type=? AND status='confirmed' AND id!=?
                                      AND seal_uid_hash=? AND json_extract(payload_json, '$.anchor')='relay'
                                      AND json_extract(payload_json, '$.indicators') IS NOT NULL
                                      AND json_extract(payload_json, '$.counter')=? ORDER BY id LIMIT 1""",
                                 (ev["serial"], EventType.SCAN, ev["id"], ev["seal_uid_hash"], int(row["counter"]))).fetchone()
            if check is not None:
                drop_superseded_sighting(conn, ev["serial"], ev["seal_uid_hash"], int(row["counter"]), int(check["id"]))
        return
    if ev["status"] != "pending":
        return
    conn.execute("UPDATE events SET status='confirmed', tx_sig=? WHERE id=? AND status='pending'",
                 (row["sig"] if recorded else None, ev["id"]))
    apply_relayed_scan(conn, get_event(conn, ev["id"]), int(now), drop_sighting=not tap_live(conn, row["ref"]))


def tap_live(conn, ref: str) -> bool:
    """A TAP row of this tap (seal, counter) that can still record its sighting (queued, sending, recorded)."""
    return conn.execute(f"SELECT 1 FROM relay_tx WHERE kind='scan' AND ref=? AND purpose=? AND status IN {_LIVE_SQL} LIMIT 1",
                        (ref, Purpose.TAP)).fetchone() is not None


def _relay_detail(row: dict) -> dict:
    bundle = json.loads(row["bundle_json"])
    return {"anchor": "relay", "purpose": Purpose.name(int(row["purpose"])), "actorKind": ActorKind.name(int(row["actor_kind"])),
            "msgHex": row["msg_hex"], "bundleHash": proof.hex0x(proof.bundle_hash(row["bundle_json"])), "bundleV2": bundle}


def _finish(conn, row: dict, status: str, reason: str | None, now: int, *, lamports: int | None = None,
            expect: str = "queued", keep_sig: bool = False) -> bool:
    """
    Move a row to a terminal state if it is still in `expect`, and settle its event. False if it moved meanwhile. The
    attempt's signature is kept only for a transaction that landed (`keep_sig`: it failed on chain).
    """
    sets = "status=?, reason=?, updated_at=?" + (", lamports=?" if lamports is not None else "")
    args: list[Any] = [status, reason, int(now)] + ([int(lamports)] if lamports is not None else [])
    if not keep_sig:
        sets += ", sig=NULL, last_valid_height=NULL"
    cur = conn.execute(f"UPDATE relay_tx SET {sets} WHERE id=? AND status=?", (*args, row["id"], expect))
    if cur.rowcount != 1:
        return False
    settle_event(conn, get_row(conn, row["id"]), now)
    return True


def expire_overdue(conn, now: int | None = None, rpc=None, state: RelayState | None = None) -> int:
    """
    Queued rows past their deadline → failed/expired (also run by the reconcile job, relay on or off). A row with
    earlier attempts is expired only after they were looked up (`rpc`, outside the write transaction; one that landed
    records the row instead; once its due_at has come, so a look-up that could not tell backs off): without `rpc` it is
    left queued for a caller that has one.
    """
    now = now_ts() if now is None else int(now)
    if not conn.execute("SELECT 1 FROM relay_tx WHERE status='queued' AND deadline_at < ? LIMIT 1", (now,)).fetchone():
        return 0
    n = 0
    later: list[dict] = []
    with transaction(conn):
        for r in conn.execute("SELECT * FROM relay_tx WHERE status='queued' AND deadline_at < ? ORDER BY id", (now,)).fetchall():
            if not earlier_attempts(dict(r)):
                n += _finish(conn, dict(r), "failed", "expired", now)
            elif int(r["due_at"]) <= now:
                later.append(dict(r))
    if rpc is not None:
        for r in later:
            n += _end(conn, rpc, r, "failed", "expired", now, state) == "ended"
    return n


# ---------- budget ----------

def _day(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(int(now)))


def spent_today(conn, now: float) -> int:
    r = conn.execute("SELECT lamports FROM relay_budget WHERE day=?", (_day(now),)).fetchone()
    return int(r[0]) if r else 0


def _charge(conn, now: float, lamports: int) -> None:
    """relay_budget[today] += lamports (a negative amount refunds an estimate that was never paid; never below 0)."""
    conn.execute("""INSERT INTO relay_budget(day, lamports) VALUES(?, MAX(0, ?))
                    ON CONFLICT(day) DO UPDATE SET lamports=MAX(0, relay_budget.lamports + ?)""",
                 (_day(now), int(lamports), int(lamports)))


def fee_estimate(price_microlamports: int, cu_limit: int) -> int:
    """Two signatures (fee payer + the Ed25519 precompile's) plus the priority fee of the compute unit limit."""
    return SIGNATURE_FEE_LAMPORTS * 2 + math.ceil(int(price_microlamports) * int(cu_limit) / 1_000_000)


def priority_price(fees: list[int], ceiling: int) -> int:
    """75th percentile of getRecentPrioritizationFees, clamped to 0..ceiling."""
    if not fees:
        return 0
    s = sorted(int(f) for f in fees)
    p = s[max(0, math.ceil(len(s) * PRIORITY_PERCENTILE / 100) - 1)]
    return max(0, min(int(ceiling), p))


# ---------- the transaction and its allowlist (§9.7) ----------

class RelayShapeError(ValueError):
    pass


def record_scan_v2_accounts(program_id: str | Pubkey, serial_hash: bytes, uid_hash: bytes) -> list[tuple[str, Pubkey]]:
    """(role, pubkey) of record_scan_v2 for a visitor/holder scan, IDL order; absent optional accounts = the program id."""
    pid = program_id if isinstance(program_id, Pubkey) else program_pubkey(program_id)
    passport = pda_passport(pid, serial_hash)
    keys = {"registry": pda_registry(pid), "holder_config": pda_holder_config(pid), "passport": passport,
            "seal": pda_seal(pid, uid_hash), "holding": pda_holding(pid, passport), "instructions": SYSVAR_INSTRUCTIONS,
            "actor_signer": pid, "asset": pid, "event_authority": pda_event_authority(pid), "program": pid}
    return [(role, keys[role]) for role in RECORD_SCAN_V2_ACCOUNTS]


def row_pubkey(settings: Settings, row: dict) -> bytes:
    """The scan key that signed a row: stored with it (a later key rotation changes nothing for it); rows of an earlier
    P1 build without the column fall back to the current key."""
    stored = row.get("server_pubkey")
    return bytes.fromhex(stored) if stored else proof.public_key(settings.server_seed)


def build_relay_tx(settings: Settings, row: dict, blockhash: str, price: int) -> Transaction:
    """
    The relay transaction of a row, allowlisted, then signed (§9.5 step 4): the relayer is fee payer and only signer,
    and its key signs nothing check_relay_shape refuses (RelayShapeError). The Ed25519 instruction carries the key that
    signed the row (row_pubkey) next to its key_id.
    """
    from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
    msg, sig = bytes.fromhex(row["msg_hex"]), bytes.fromhex(row["server_sig"])
    m = proof.parse_message_v2(msg)
    pid = program_pubkey(settings.program_id)
    scan_pubkey = row_pubkey(settings, row)
    metas = [AccountMeta(pk, False, role in RECORD_SCAN_V2_WRITABLE)
             for role, pk in record_scan_v2_accounts(pid, m["serial_hash"], m["uid_hash"])]
    ixs = [set_compute_unit_limit(int(settings.relay_cu_limit)), set_compute_unit_price(int(price)),
           Instruction(ED25519_PROGRAM, proof.ed25519_ix_data(scan_pubkey, sig, msg), []),
           Instruction(pid, RECORD_SCAN_V2_DISC + bytes([int(row["key_id"])]), metas)]
    kp = settings.relayer_keypair
    bh = Hash.from_string(blockhash)
    message = Message.new_with_blockhash(ixs, kp.pubkey(), bh)
    check_relay_shape(message, kp.pubkey(), scan_pubkey, pid, settings.cluster_tag, settings.relay_max_priority_microlamports)
    return Transaction([kp], message, bh)


def _writable(message: Message, i: int) -> bool:
    h, n = message.header, len(message.account_keys)
    if i < h.num_required_signatures:
        return i < h.num_required_signatures - h.num_readonly_signed_accounts
    return i < n - h.num_readonly_unsigned_accounts


def check_relay_shape(message: Message, relayer: str | Pubkey, scan_pubkey: bytes, program_id: str | Pubkey, cluster_tag: int,
                      max_price: int) -> bytes:
    """
    The one transaction shape the relayer may sign (§9.7); raises RelayShapeError for anything else, returns the FVSCAN2:
      1. exactly 4 instructions; account 0 (fee payer) = relayer; exactly one required signature;
      2. ComputeBudget SetComputeUnitLimit (02 ‖ u32), then SetComputeUnitPrice (03 ‖ u64) ≤ max_price, no accounts;
      3. Ed25519, no accounts, exactly the §3.6 data with the scan key and a 256-byte FVSCAN2 for this program and
         cluster (signed by the scan key);
      4. record_scan_v2 of the program: discriminator ‖ u8, accounts exactly §7.6 in order (optional ones = the program
         id), writable only passport, seal, holding, no signer;
      5. the relayer is in no instruction's account list; the writable accounts are exactly {relayer, passport, seal,
         holding}.
    """
    def need(ok: bool, why: str) -> None:
        if not ok:
            raise RelayShapeError(why)

    relayer = relayer if isinstance(relayer, Pubkey) else Pubkey.from_string(str(relayer))
    pid = program_id if isinstance(program_id, Pubkey) else Pubkey.from_string(str(program_id))
    keys = list(message.account_keys)
    ixs = list(message.instructions)
    need(len(ixs) == 4, "exactly 4 instructions")
    need(message.header.num_required_signatures == 1 and len(keys) > 0 and keys[0] == relayer,
         "the relayer is the fee payer and the only signer")
    for ix in ixs:
        need(ix.program_id_index < len(keys) and all(a < len(keys) for a in bytes(ix.accounts)), "account index out of range")
        need(0 not in bytes(ix.accounts), "the relayer appears in an instruction")
    prog = [keys[ix.program_id_index] for ix in ixs]
    data = [bytes(ix.data) for ix in ixs]
    need(prog[0] == COMPUTE_BUDGET_PROGRAM and not bytes(ixs[0].accounts) and len(data[0]) == 5 and data[0][0] == 2,
         "ix 0 must be SetComputeUnitLimit")
    need(prog[1] == COMPUTE_BUDGET_PROGRAM and not bytes(ixs[1].accounts) and len(data[1]) == 9 and data[1][0] == 3,
         "ix 1 must be SetComputeUnitPrice")
    need(int.from_bytes(data[1][1:], "little") <= int(max_price), "priority fee above the ceiling")
    need(prog[2] == ED25519_PROGRAM and not bytes(ixs[2].accounts) and len(data[2]) == ED25519_DATA_LEN_V2
         and data[2][:16] == ED25519_HEADER_V2, "ix 2 must be the §3.6 Ed25519 instruction")
    try:
        ed = proof.parse_ed25519_ix_data(data[2], message_len=proof.MSG2_LEN)
        m = proof.parse_message_v2(ed["msg"])
    except ValueError as exc:
        raise RelayShapeError(f"ix 2: {exc}") from exc
    need(ed["pubkey"] == bytes(scan_pubkey), "ix 2 is not signed by the scan key")
    need(proof.verify(ed["pubkey"], ed["msg"], ed["sig"]), "ix 2 signature does not verify")
    need(m["program_id"] == bytes(pid), "FVSCAN2 is bound to another program")
    need(m["cluster_tag"] == int(cluster_tag), "FVSCAN2 is bound to another cluster")
    need(prog[3] == pid and len(data[3]) == 9 and data[3][:8] == RECORD_SCAN_V2_DISC, "ix 3 must be record_scan_v2")
    expected = record_scan_v2_accounts(pid, m["serial_hash"], m["uid_hash"])
    got = [keys[a] for a in bytes(ixs[3].accounts)]
    need(got == [pk for _, pk in expected], "record_scan_v2 accounts are not §7.6")
    for (role, _pk), a in zip(expected, bytes(ixs[3].accounts)):
        need(_writable(message, a) == (role in RECORD_SCAN_V2_WRITABLE), f"record_scan_v2 account {role}: wrong writability")
        need(not message.is_signer(a), f"record_scan_v2 account {role} must not sign")
    writable = {keys[i] for i in range(len(keys)) if _writable(message, i)}
    roles = dict(expected)
    need(writable == {relayer, roles["passport"], roles["seal"], roles["holding"]}, "writable accounts are not exactly the four")
    return ed["msg"]


# ---------- RPC with a fallback ----------

def _program_error(error: dict | None) -> str | None:
    """The program error of a preflight failure (sendTransaction's data.err InstructionError), else None."""
    err = ((error or {}).get("data") or {}).get("err") if isinstance(error, dict) else None
    if isinstance(err, dict) and "InstructionError" in err:
        ix, what = (err["InstructionError"] + [None, None])[:2]
        code = what.get("Custom") if isinstance(what, dict) else what
        return f"instruction {ix}: {'custom program error ' + str(code) if isinstance(what, dict) else code}"
    return None


def _already_processed(error: dict | None) -> bool:
    err = ((error or {}).get("data") or {}).get("err") if isinstance(error, dict) else None
    return err == "AlreadyProcessed" or "already been processed" in str((error or {}).get("message", "")).lower()


def _code(exc: RpcError) -> str:
    """A short description of an RPC error without the URL (it can carry an API key)."""
    if exc.error is None:
        return "transport error"
    return f"rpc error {exc.error.get('code')}" + (f" ({_program_error(exc.error)})" if _program_error(exc.error) else "")


class FallbackRpc:
    """
    Every call goes to the primary RPC first and, after a primary failure, to FV_SOLANA_RPC_FALLBACK (if set). A
    preflight program error is final: the fallback would simulate the same program. A sendTransaction whose primary
    failed on the transport may have been forwarded already, so any failure of the fallback then (BlockhashNotFound from
    a node that is behind, "node is behind", even a program error once the first copy landed) is reported as an
    unknown outcome (RpcError without `error`): the row stays `sending` with its signature until confirm_sending knows
    it, instead of going back to `queued` and being sent a second time. The relay's signature status reads
    (confirm_sending, look_up_earlier) do not go through this fallback: they ask each RPC on its own (_status_sources),
    since a fallback without history answers "not found" for a transaction that landed.
    """

    def __init__(self, primary, fallback=None):
        self.primary, self.fallback = primary, fallback

    def __getattr__(self, name: str):
        first = getattr(self.primary, name)
        if self.fallback is None or not callable(first):
            return first
        second = getattr(self.fallback, name)

        def call(*a, **k):
            try:
                return first(*a, **k)
            except RpcError as exc:
                if _program_error(exc.error) or _already_processed(exc.error):
                    raise
                log.warning("relay: %s failed on the primary RPC (%s), trying the fallback", name, _code(exc))
                try:
                    return second(*a, **k)
                except RpcError as exc2:
                    if name == "send_transaction" and exc.error is None and not _already_processed(exc2.error):
                        log.warning("relay: sendTransaction failed on the fallback too (%s) after a primary transport error",
                                    _code(exc2))
                        raise RpcError(f"{name}: outcome unknown after a primary transport error") from exc2
                    raise
        return call


# ---------- loop state ----------

@dataclass
class RelayState:
    """In-memory relay status shared by the loop, GET /health and the admin status (nothing secret)."""
    holder_config_cluster: int | None = None     # HolderConfig.cluster_tag once read (immutable on chain)
    holder_config_checked_at: float | None = None
    balance: int | None = None
    balance_checked_at: float | None = None
    balance_due: bool = False                    # re-read after a recorded row
    low_balance_logged_at: float | None = None
    last_error: str | None = None                # short code
    _loop: Any = field(default=None, repr=False)
    _event: Any = field(default=None, repr=False)
    _lock: Any = field(default_factory=threading.Lock, repr=False)

    def low_balance(self, settings: Settings) -> bool:
        return self.balance is not None and self.balance < int(settings.relay_low_balance_lamports)

    def cluster_matches(self, settings: Settings) -> bool:
        return self.holder_config_cluster is not None and self.holder_config_cluster == settings.cluster_tag

    def bind(self, loop) -> None:
        with self._lock:
            self._loop, self._event = loop, asyncio.Event()

    def wake(self) -> None:
        """Run the loop now (a CHECK was queued). Safe from any thread; a no-op while no loop runs."""
        with self._lock:
            loop, ev = self._loop, self._event
        if loop is not None and ev is not None:
            try:
                loop.call_soon_threadsafe(ev.set)
            except RuntimeError:          # loop closed (shutdown)
                pass

    async def sleep(self, seconds: float) -> None:
        ev = self._event
        if ev is None:
            await asyncio.sleep(seconds)
            return
        try:
            await asyncio.wait_for(ev.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
        ev.clear()


# ---------- confirming ----------

def _paid_fee(rpc, sig: str) -> int | None:
    try:
        res = rpc.get_transaction(sig)
    except RpcError as exc:
        log.warning("relay: getTransaction %s… failed (%s)", sig[:12], _code(exc))
        return None
    fee = ((res or {}).get("meta") or {}).get("fee")
    return int(fee) if isinstance(fee, int) else None


def _status_sources(rpc) -> tuple[Any, Any | None]:
    """
    (primary, fallback) for status reads. The primary (FV_SOLANA_RPC) is the source with the full transaction history;
    the fallback may keep none, so its "not found" alone never means "lost". A client that is not a FallbackRpc (the
    reconcile job's primary RPC, a test fake) is the primary alone.
    """
    if isinstance(rpc, FallbackRpc):
        return rpc.primary, rpc.fallback
    return rpc, None


def _statuses_from(source, sigs: list[str], which: str) -> list[dict | None] | None:
    """getSignatureStatuses (searchTransactionHistory) of `sigs` from one source; None when it gave no usable answer."""
    try:
        got = list(source.get_signature_statuses(sigs))
    except RpcError as exc:
        log.warning("relay: getSignatureStatuses failed on the %s RPC (%s)", which, _code(exc))
        return None
    return got if len(got) == len(sigs) else None


def _landed(st: dict | None) -> bool:
    return bool(st) and st.get("confirmationStatus") in ("confirmed", "finalized")


def earlier_attempts(row: dict) -> list[dict]:
    """The row's earlier attempts, oldest first: {sig, estimate} of each transaction it sent and then gave up on (unknown
    to the primary RPC once its blockhash had expired). Empty for a row of an earlier P1 build without the column."""
    try:
        got = json.loads(row.get("earlier_sigs") or "[]")
    except ValueError:
        return []
    return [a for a in got if isinstance(a, dict) and isinstance(a.get("sig"), str)] if isinstance(got, list) else []


def look_up_earlier(rpc, row: dict) -> tuple[str | None, int] | None:
    """
    What the row's earlier attempts did (§9.5): getSignatureStatuses on the primary, then on the fallback for what the
    primary does not know. → (sig, paid): `sig` = the attempt that landed with err null (it recorded the scan) or None;
    `paid` = what the attempts that landed paid (meta.fee, else their estimate) — each was refunded when it was given up,
    so the caller charges it once. None = not known yet (the primary did not answer and the fallback does not know them
    all — its "not found" alone proves nothing — or an attempt is processed only): the caller ends nothing.
    """
    attempts = earlier_attempts(row)
    if not attempts:
        return None, 0
    primary, fallback = _status_sources(rpc)
    sigs = [a["sig"] for a in attempts]
    first = _statuses_from(primary, sigs, "primary")
    statuses = list(first) if first is not None else [None] * len(sigs)
    unknown = [i for i, st in enumerate(statuses) if st is None]
    if unknown and fallback is not None:
        for i, st in zip(unknown, _statuses_from(fallback, [sigs[i] for i in unknown], "fallback") or []):
            statuses[i] = st
    if (first is None and None in statuses) or any(st is not None and not _landed(st) for st in statuses):
        return None
    sig, paid = None, 0
    for attempt, st in zip(attempts, statuses):
        if st is None:
            continue
        fee = _paid_fee(rpc, attempt["sig"])
        paid += fee if fee is not None else int(attempt.get("estimate") or 0)
        if st.get("err") is None and sig is None:
            sig = attempt["sig"]
    return sig, paid


def _record(conn, row: dict, sig: str, lamports: int, now: int, expect: str) -> bool:
    """The row → recorded by transaction `sig` (what the row paid: `lamports`) if it is still in `expect`; then §9.8."""
    cur = conn.execute("""UPDATE relay_tx SET status='recorded', reason=NULL, sig=?, lamports=?, updated_at=?
                          WHERE id=? AND status=?""", (sig, int(lamports), int(now), row["id"], expect))
    if cur.rowcount != 1:
        return False
    settle_event(conn, get_row(conn, row["id"]), int(now))
    return True


def confirm_sending(conn, settings: Settings, rpc, state: RelayState | None = None, now: float | None = None) -> dict:
    """
    Settle `sending` rows (§9.5; run by the loop, at its start, and by reconcile_once). No RPC call without such rows.
    Statuses come from the primary RPC; from the fallback only when the primary fails (then only what it finds counts)
    and as a second source before an attempt is given up. The block height is the primary's.
      * confirmed/finalized, err null → recorded (meta.fee stored, the budget corrected by fee − estimate), §9.8;
      * err set → failed/rejected (the paid fee kept in the budget), unless an earlier attempt of the row landed
        (look_up_earlier): then recorded with that one;
      * either way, what earlier attempts of the row that landed paid is charged once with it (they were refunded when
        given up);
      * not found by the primary nor the fallback, and the primary's finalized block height past last_valid_height → it
        can never land: back to queued (re-sent with a new blockhash, the estimate refunded, its signature kept in
        earlier_sigs) or, past the deadline, failed/expired (after the look-up of its earlier attempts).
    Anything else waits (processed only, the blockhash still valid, only the fallback answered, or earlier attempts not
    known yet).
    """
    now = time.time() if now is None else now
    rows = [dict(r) for r in conn.execute("SELECT * FROM relay_tx WHERE status='sending' ORDER BY id").fetchall()]
    out = {"sending": len(rows), "recorded": 0, "rejected": 0, "requeued": 0, "expired": 0}
    if not rows:
        return out
    primary, fallback = _status_sources(rpc)
    statuses = _statuses_from(primary, [r["sig"] for r in rows], "primary")
    history = statuses is not None                # the primary answered: its "not found" can be final
    if statuses is None and fallback is not None:
        statuses = _statuses_from(fallback, [r["sig"] for r in rows], "fallback")
    if statuses is None:
        return out
    height: int | None = None
    landed: list[tuple[dict, dict]] = []
    gone: list[dict] = []
    for row, st in zip(rows, statuses):
        if _landed(st):
            landed.append((row, st))
        elif st is None and history and row["last_valid_height"] is not None:
            if height is None:
                try:
                    height = int(primary.get_block_height())
                except RpcError as exc:
                    log.warning("relay: getBlockHeight failed (%s)", _code(exc))
                    height = -1
            if height > int(row["last_valid_height"]):
                gone.append(row)
    if gone and fallback is not None:             # a second source before an attempt is given up
        second = _statuses_from(fallback, [r["sig"] for r in gone], "fallback")
        if second is not None:
            landed += [(row, st) for row, st in zip(gone, second) if _landed(st)]
            gone = [row for row, st in zip(gone, second) if st is None]
    plan: list[tuple[dict, str, int | None, tuple[str | None, int]]] = []
    for row, st in landed:
        what = "recorded" if st.get("err") is None else "rejected"
        earlier = look_up_earlier(rpc, row)
        if earlier is None:
            if what == "rejected":
                continue                          # wait: an earlier attempt may be the one that recorded the scan
            earlier = (None, 0)                   # recorded by this attempt either way
        elif what == "recorded":
            earlier = (None, earlier[1])          # this attempt recorded it; an earlier one can only have failed (paid)
        plan.append((row, what, _paid_fee(rpc, row["sig"]), earlier))
    for row in gone:
        what = "expired" if now > int(row["deadline_at"]) else "requeue"
        earlier = look_up_earlier(rpc, row) if what == "expired" else (None, 0)
        if earlier is not None:
            plan.append((row, what, None, earlier))
    with transaction(conn):
        for row, what, fee, (earlier_sig, earlier_paid) in plan:
            cur = conn.execute("SELECT status, sig FROM relay_tx WHERE id=?", (row["id"],)).fetchone()
            if not cur or cur["status"] != "sending" or cur["sig"] != row["sig"]:
                continue                                  # settled meanwhile (the other caller of confirm_sending)
            estimate = int(row["lamports"] or 0)
            if what == "requeue":
                # queued again, but with this attempt in earlier_sigs: the row keeps counting as sent (was_sent), so an
                # adoption of its tap still answers REPLAY and never replaces it — the attempt may have landed unseen
                _charge(conn, now, -estimate)
                earlier = json.dumps(earlier_attempts(row) + [{"sig": row["sig"], "estimate": estimate}])
                conn.execute("""UPDATE relay_tx SET status='queued', sig=NULL, last_valid_height=NULL, lamports=0, earlier_sigs=?,
                                due_at=?, updated_at=? WHERE id=?""", (earlier, int(now), int(now), row["id"]))
                out["requeued"] += 1
                continue
            # what this attempt paid (refund of its estimate when it never landed) + what earlier attempts that landed paid
            paid = (fee if fee is not None else estimate) if what in ("recorded", "rejected") else 0
            _charge(conn, now, paid - estimate + earlier_paid)
            if what == "recorded" or earlier_sig:
                _record(conn, row, row["sig"] if what == "recorded" else earlier_sig, paid + earlier_paid, int(now), "sending")
                if what != "recorded":
                    log.warning("relay: row %s (%s) was recorded by its earlier attempt %s…", row["id"], row["ref"],
                                earlier_sig[:12])
                out["recorded"] += 1
            elif what == "rejected":
                _finish(conn, row, "failed", "rejected", int(now), lamports=paid + earlier_paid, expect="sending",
                        keep_sig=True)
                log.warning("relay: row %s (%s) landed with an error", row["id"], row["ref"])
                out["rejected"] += 1
            else:
                _finish(conn, row, "failed", "expired", int(now), lamports=earlier_paid, expect="sending")
                out["expired"] += 1
    if out["recorded"]:
        if state is not None:
            state.balance_due = True
        log.info("relay: %s recorded", out["recorded"])
    return out


# ---------- sending ----------

def due_rows(conn, now: float) -> list[dict]:
    """
    Per seal at most one row in flight: no seal with a `sending` row; among a seal's queued rows the lowest counter is
    due when its due_at has come, or when a higher-counter row of the same seal is due and the lowest row was never
    tried (pull-forward, counters land in order). A lowest row that is backing off after a failed attempt (attempts > 0)
    waits for its own due_at, so a due CHECK behind it does not turn the backoff into a retry every cycle.
    """
    by_seal: dict[str, list[dict]] = {}
    for r in conn.execute("""SELECT * FROM relay_tx WHERE kind='scan' AND status IN ('queued','sending')
                             ORDER BY seal_uid_hash, counter, id""").fetchall():
        by_seal.setdefault(r["seal_uid_hash"], []).append(dict(r))
    out = []
    for rows in by_seal.values():
        if any(r["status"] == "sending" for r in rows):
            continue
        head = rows[0]
        if int(head["due_at"]) <= now or (int(head["attempts"] or 0) == 0 and any(int(r["due_at"]) <= now for r in rows[1:])):
            out.append(head)
    return sorted(out, key=lambda r: (int(r["due_at"]), r["id"]))


def _retry(conn, row: dict, now: float, why: str, state: RelayState | None) -> None:
    """Transport/RPC trouble before anything was sent: stays queued, next try after the backoff."""
    delay = RETRY_BACKOFF_S[min(int(row["attempts"] or 0), len(RETRY_BACKOFF_S) - 1)]
    with transaction(conn):
        conn.execute("UPDATE relay_tx SET attempts=attempts+1, due_at=?, updated_at=? WHERE id=? AND status='queued'",
                     (int(now) + delay, int(now), row["id"]))
    if state is not None:
        state.last_error = why
    log.info("relay: row %s (%s): %s, retry in %ss", row["id"], row["ref"], why, delay)


def _end(conn, rpc, row: dict, status: str, reason: str, now: float, state: RelayState | None) -> str:
    """
    End a queued row without recording it (status/reason) — unless one of its own earlier attempts landed. A row with
    earlier attempts looks them up first (look_up_earlier, outside any write transaction):
      * one landed with err null → the row is recorded with that signature, its fee charged once ("recorded");
      * not known yet → the row stays queued and is tried again after the backoff ("wait");
      * none landed → status/reason as asked, the fees of attempts that landed with an error charged ("ended").
    "moved": the row changed meanwhile and nothing was written.
    """
    earlier = look_up_earlier(rpc, row) if earlier_attempts(row) else (None, 0)
    if earlier is None:
        _retry(conn, row, now, "earlier attempt not known yet", state)
        return "wait"
    sig, paid = earlier
    with transaction(conn):
        if sig:
            done = _record(conn, row, sig, paid, int(now), "queued")
        else:
            done = _finish(conn, row, status, reason, int(now), lamports=paid or None)
        if done and paid:
            _charge(conn, now, paid)
    if not done:
        return "moved"
    if sig:
        if state is not None:
            state.balance_due = True
        log.warning("relay: row %s (%s) was recorded by its earlier attempt %s… (not %s)", row["id"], row["ref"], sig[:12],
                    reason)
        return "recorded"
    if state is not None:
        state.last_error = reason
    log.info("relay: row %s (%s) → %s (%s)", row["id"], row["ref"], status, reason)
    return "ended"


def _ended(what: str, outcome: str) -> str:
    """process_row's outcome after _end: the caller's name for an ended row, else _end's ("recorded", "wait", "moved")."""
    return outcome if what == "ended" else what


def _check_accounts(row: dict, datas: list[bytes | None], passport_pda: Pubkey) -> str | None:
    """The reason the program would refuse this scan, from the accounts it reads (None = send it)."""
    p_data, s_data, h_data = datas
    if p_data is None or s_data is None:
        return "not_on_chain"
    if h_data is None:
        return "no_holding"
    try:
        passport, seal = decode_passport(p_data), decode_seal(s_data)
        decode_holding(h_data)
    except DecodeError:
        return "not_on_chain"
    if int(seal["lastCounter"]) >= int(row["counter"]):
        return "counter_used"
    if seal["dead"] or passport["void"] or int(passport["grade"]) == Grade.VOID or seal["passport"] != str(passport_pda):
        return "rejected"
    return None


def process_row(conn, settings: Settings, rpc, state: RelayState | None, row: dict, now: float,
                clock: Callable[[], float] | None = None) -> str:
    """
    One due row: checks, fee, accounts, build + allowlist + sign, claim (→ sending, budget charged), send. Returns the
    outcome. `clock` is read again right before the claim (after the RPC calls, each of which may wait out its timeout):
    a row past its deadline at that moment ends failed/expired and is never sent (D13); default: `now` throughout.
    Every way of ending the row unrecorded goes through _end, so a row whose counter its own earlier attempt used
    (counter_used, or CounterNotIncreasing at the preflight) is recorded with that attempt instead.
    """
    clock = clock or (lambda: now)
    if now > int(row["deadline_at"]):
        return _ended(_end(conn, rpc, row, "failed", "expired", now, state), "expired")
    pid = program_pubkey(settings.program_id)
    m = proof.parse_message_v2(bytes.fromhex(row["msg_hex"]))
    passport = pda_passport(pid, m["serial_hash"])
    seal = pda_seal(pid, m["uid_hash"])
    holding = pda_holding(pid, passport)
    try:
        price = priority_price(rpc.get_recent_prioritization_fees([passport, seal, holding]),
                               settings.relay_max_priority_microlamports)
    except RpcError as exc:
        log.info("relay: getRecentPrioritizationFees failed (%s), price 0", _code(exc))
        price = 0
    fee = fee_estimate(price, settings.relay_cu_limit)
    if spent_today(conn, now) + fee > int(settings.relay_daily_lamports):
        return _ended(_end(conn, rpc, row, "over_cap", "budget", now, state), "over_cap")
    try:
        datas = rpc.get_multiple_accounts([passport, seal, holding])
    except RpcError as exc:
        _retry(conn, row, now, f"getMultipleAccounts: {_code(exc)}", state)
        return "retry"
    why = _check_accounts(row, datas, passport)
    if why:
        return _ended(_end(conn, rpc, row, "failed", why, now, state), why)
    try:
        blockhash, last_valid = rpc.get_latest_blockhash()
    except RpcError as exc:
        _retry(conn, row, now, f"getLatestBlockhash: {_code(exc)}", state)
        return "retry"
    try:
        tx = build_relay_tx(settings, row, blockhash, price)          # refused by the allowlist → never signed
    except (RelayShapeError, ValueError) as exc:
        log.error("relay: row %s (%s) refused by the shape allowlist: %s", row["id"], row["ref"], exc)
        return _ended(_end(conn, rpc, row, "failed", "rejected", now, state), "rejected")
    sig = str(tx.signatures[0])
    now = clock()                                       # the send time, not the cycle start
    # claim before sending: from here the row is `sending`, so an adoption of its tap answers REPLAY (was_sent) and
    # nothing re-sends it until confirm_sending knows its fate. Only while the deadline (ts + 570) has not passed at this
    # moment.
    with transaction(conn):
        if spent_today(conn, now) + fee > int(settings.relay_daily_lamports):
            ended = ("over_cap", "budget")
        else:
            cur = conn.execute("""UPDATE relay_tx SET status='sending', sig=?, last_valid_height=?, lamports=?,
                                  attempts=attempts+1, updated_at=? WHERE id=? AND status='queued' AND deadline_at >= ?""",
                               (sig, int(last_valid), fee, int(now), row["id"], now))
            if cur.rowcount == 1:
                _charge(conn, now, fee)
                ended = None
            elif int(row["deadline_at"]) < now:
                # past its deadline by now (the RPC calls above took their time): expired, never sent
                ended = ("failed", "expired")
            else:
                return "moved"                          # replaced or settled meanwhile: nothing was sent either
    if ended:
        status, reason = ended
        what = _end(conn, rpc, row, status, reason, now, state)
        if what == "ended" and reason == "expired":
            log.info("relay: row %s (%s) → failed (expired) at the claim", row["id"], row["ref"])
        return _ended(what, status if reason == "budget" else reason)
    try:
        rpc.send_transaction(bytes(tx))
    except RpcError as exc:
        if exc.error is None or _already_processed(exc.error):
            # the node may have taken it: it stays `sending` until confirm_sending sees it or its blockhash expires
            if state is not None:
                state.last_error = "send_unknown"
            log.warning("relay: row %s (%s) send outcome unknown (%s); waiting for its status", row["id"], row["ref"], _code(exc))
            return "unknown"
        program = _program_error(exc.error)
        # a program error of a row with earlier attempts may be CounterNotIncreasing because one of them landed: the row
        # goes back to queued (this copy never left the node) and _end looks them up before it is rejected
        settle_later = bool(program) and bool(earlier_attempts(row))
        with transaction(conn):
            _charge(conn, now, -fee)
            if program and not settle_later:
                _finish(conn, row, "failed", "rejected", int(now), lamports=0, expect="sending")
            else:
                # the node answered with an error: this copy never left it, so no earlier attempt is added (a row without
                # one was not sent: an adoption of its tap may still replace it)
                delay = 0 if settle_later else RETRY_BACKOFF_S[min(int(row["attempts"] or 0), len(RETRY_BACKOFF_S) - 1)]
                conn.execute("""UPDATE relay_tx SET status='queued', sig=NULL, last_valid_height=NULL, lamports=0, due_at=?,
                                updated_at=? WHERE id=? AND status='sending'""", (int(now) + delay, int(now), row["id"]))
        log.warning("relay: row %s (%s) not sent: %s", row["id"], row["ref"], program or _code(exc))
        if settle_later:
            fresh = get_row(conn, row["id"])
            if not fresh or fresh["status"] != "queued":
                return "moved"
            return _ended(_end(conn, rpc, fresh, "failed", "rejected", now, state), "rejected")
        if state is not None:
            state.last_error = "rejected" if program else "rpc"
        return "rejected" if program else "retry"
    log.info("relay: row %s (%s) sent %s… fee ≈ %s lamports", row["id"], row["ref"], sig[:12], fee)
    return "sent"


def _holder_config_ready(settings: Settings, rpc, state: RelayState, now: float) -> bool:
    """HolderConfig is read once (then every HOLDER_CONFIG_RETRY_S until it succeeds); nothing is sent before."""
    if state.holder_config_cluster is not None:
        return True
    if state.holder_config_checked_at is not None and now - state.holder_config_checked_at < HOLDER_CONFIG_RETRY_S:
        return False
    state.holder_config_checked_at = now
    try:
        cfg = decode_holder_config(rpc.get_account_info(pda_holder_config(settings.program_id)))
    except (RpcError, DecodeError) as exc:
        state.last_error = "holder_config_unread"
        log.warning("relay: HolderConfig not readable (%s); nothing is sent until it is",
                    _code(exc) if isinstance(exc, RpcError) else exc)
        return False
    state.holder_config_cluster = int(cfg["clusterTag"])
    if not state.cluster_matches(settings):
        log.error("relay: HolderConfig.cluster_tag %s != FV_CLUSTER %s (%s): sending stopped", cfg["clusterTag"],
                  settings.cluster, settings.cluster_tag)
    return True


def check_balance(settings: Settings, rpc, state: RelayState, now: float) -> None:
    """getBalance(relayer) at most every BALANCE_CHECK_S (and after a recorded row); low balance → warning, hourly."""
    if not state.balance_due and state.balance_checked_at is not None and now - state.balance_checked_at < BALANCE_CHECK_S:
        return
    state.balance_checked_at, state.balance_due = now, False
    try:
        state.balance = int(rpc.get_balance(settings.relayer_pubkey))
    except RpcError as exc:
        log.warning("relay: getBalance failed (%s)", _code(exc))
        return
    if state.low_balance(settings) and (state.low_balance_logged_at is None or now - state.low_balance_logged_at >= LOW_BALANCE_LOG_S):
        state.low_balance_logged_at = now
        log.warning("relay: relayer %s balance %s lamports is below FV_RELAY_LOW_BALANCE_LAMPORTS (%s) — fund it",
                    settings.relayer_pubkey, state.balance, settings.relay_low_balance_lamports)


def relay_once(db, settings: Settings, rpc, state: RelayState, now: float | None = None,
               clock: Callable[[], float] | None = None) -> dict:
    """
    One relay cycle (the loop runs it in a thread every FV_RELAY_INTERVAL_S, or right after a CHECK was queued). Each
    row is processed at the clock's current time (`clock`, default the wall clock; a caller that fixes `now` gets that
    time throughout unless it passes a clock too).
    """
    if clock is None:
        clock = time.time if now is None else (lambda: now)
    now = clock() if now is None else now
    out: dict[str, Any] = {"enabled": bool(settings.relay_enabled and settings.program_id and settings.relayer_keypair)}
    if not out["enabled"]:
        return out
    with db.connect() as conn:
        out["expired"] = expire_overdue(conn, int(now), rpc, state)
        out["confirm"] = confirm_sending(conn, settings, rpc, state, now)
        if not _holder_config_ready(settings, rpc, state, now):
            out["waiting"] = "holder_config"
            return out
        due = due_rows(conn, now)
        if not state.cluster_matches(settings):
            state.last_error = "cluster_mismatch"
            for row in due:
                _end(conn, rpc, row, "failed", "cluster_mismatch", now, state)
            out["clusterMismatch"] = len(due)
            return out
        check_balance(settings, rpc, state, now)
        out["sent"] = {}
        for row in due:
            what = process_row(conn, settings, rpc, state, row, clock(), clock)
            out["sent"][what] = out["sent"].get(what, 0) + 1
    return out


# ---------- status ----------

def relay_health(conn, settings: Settings, state: RelayState | None, now: float | None = None) -> dict:
    """GET /health `relay`: ok = enabled, HolderConfig cluster matches, balance not low, budget left. No balances, no keys."""
    now = time.time() if now is None else now
    enabled = bool(settings.relay_enabled)
    ok = (enabled and state is not None and state.cluster_matches(settings) and not state.low_balance(settings)
          and spent_today(conn, now) < int(settings.relay_daily_lamports))
    return {"enabled": enabled, "ok": bool(ok)}


def relay_status(conn, settings: Settings, state: RelayState | None, now: float | None = None) -> dict:
    """GET /api/admin/status `relay` (public keys only, never a secret)."""
    now = time.time() if now is None else now
    since = int(now) - CAP_WINDOW_S
    counts = {r["status"]: (int(r["n"]), int(r["recent"] or 0)) for r in conn.execute(
        "SELECT status, COUNT(*) AS n, SUM(CASE WHEN updated_at > ? THEN 1 ELSE 0 END) AS recent FROM relay_tx GROUP BY status",
        (since,)).fetchall()}
    cfg = state.holder_config_cluster if state else None
    return {"enabled": bool(settings.relay_enabled), "cluster": cluster_name(settings),
            "holderConfigCluster": Cluster.name(cfg) if cfg in Cluster.values() else cfg,
            "relayer": settings.relayer_pubkey, "holderKey": settings.holder_pubkey, "issuerKey": settings.issuer_pubkey,
            "balanceLamports": state.balance if state else None, "lowBalance": bool(state and state.low_balance(settings)),
            "spentTodayLamports": spent_today(conn, now), "dailyCapLamports": int(settings.relay_daily_lamports),
            "queued": counts.get("queued", (0, 0))[0], "sending": counts.get("sending", (0, 0))[0],
            "recorded24h": counts.get("recorded", (0, 0))[1], "overCap24h": counts.get("over_cap", (0, 0))[1],
            "failed24h": counts.get("failed", (0, 0))[1], "lastError": state.last_error if state else None}
