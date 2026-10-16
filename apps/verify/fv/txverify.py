"""
On-chain backing for client-reported events (POST /api/events).

An event that claims an on-chain action is accepted only with the signature of a confirmed transaction that
  * the claimed `actor` signed,
  * ran an instruction of the expected program (flacon for MINT / SEAL_ATTACH / SCAN / SEAL_DEAD, escrow for
    LIST…DISPUTE) whose Anchor discriminator matches the event type, whose account list references the actor, and
    whose accounts *at their IDL positions* are the passport PDA of the event's serial (escrow: the Order account at
    its position belongs to that passport — either a known Order PDA of the passport, or an Order account read from
    chain whose `passport` field is the passport PDA), plus, where it applies, the seal PDA and the ScanProof PDA,
  * succeeded (`meta.err` is null) — checked after the binding, so a foreign failed tx can never fail an event.

Positional checks matter: Anchor ignores extra ("remaining") accounts, so an account that merely appears somewhere in
the instruction proves nothing about what the instruction acted on.

The verified instruction is handed back (accounts, data, the program's Anchor events from the log, and for escrow
the Order account), so the caller derives tx-backed facts (asset, seal kind, price, counters, match, reason) from
chain data instead of trusting the client's payload.

Failures map to the HTTP contract the web client relies on:
  503 tx_not_visible (not found after the quick retries — client retries) · 422 tx_failed · 403 tx_mismatch ·
  429 rate_limited (too many lookups in flight).

getTransaction results are cached per RPC client (a confirmed transaction does not change), recent misses briefly,
and at most MAX_CONCURRENT_LOOKUPS lookups run at a time, so junk signatures cannot multiply RPC traffic or occupy
the worker threads.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import re
import struct
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from solders.pubkey import Pubkey

from fv.chain import RpcError, decode_scan_proof, pda_order
from fv.enums import EventType

log = logging.getLogger("fv.txverify")

# getTransaction is retried after each delay: 4 lookups spread over ≈ 4 s, then 503 tx_not_visible.
TX_RETRY_DELAYS: tuple[float, ...] = (1.0, 1.5, 1.5)
MAX_CONCURRENT_LOOKUPS = 8
TX_CACHE_SIZE = 512
TX_CACHE_TTL_S = 600.0
MISS_CACHE_TTL_S = 2.0

# Anchor instruction names (programs/*/src/lib.rs) accepted as evidence for each event type.
FLACON_IX: dict[int, tuple[str, ...]] = {
    EventType.MINT: ("mint_passport",),
    EventType.SEAL_ATTACH: ("attach_seal",),
    EventType.SCAN: ("record_scan",),
    EventType.SEAL_DEAD: ("mark_seal_dead",),
}
ESCROW_IX: dict[int, tuple[str, ...]] = {
    EventType.LIST: ("list",),
    EventType.RESERVE: ("reserve",),
    EventType.SHIP: ("ship",),
    EventType.RECEIVE: ("record_receipt_scan",),
    EventType.RELEASE: ("release",),
    EventType.DISPUTE: ("dispute",),
}
# Event types that can only be created with a verified transaction (SEAL_DEAD may also be *reported* without one).
TX_REQUIRED: frozenset[int] = frozenset({EventType.MINT, EventType.SEAL_ATTACH, *ESCROW_IX})

# Account positions in the instructions (packages/proof/src/idl/*.json). New accounts must be appended, never inserted.
IX_ACCOUNTS: dict[str, dict[str, int]] = {
    "mint_passport": {"passport": 1, "signer": 2},
    "attach_seal": {"passport": 1, "seal": 2, "signer": 3},
    "mark_seal_dead": {"passport": 1, "seal": 2, "signer": 3},
    "record_scan": {"passport": 1, "seal": 2, "scan": 3, "signer": 4},
    "list": {"passport": 1, "order": 2, "signer": 3},
    "reserve": {"order": 1, "signer": 2},
    "ship": {"order": 0, "signer": 1},
    "record_pre_ship_scan": {"order": 0, "signer": 1, "scan": 2},
    "record_receipt_scan": {"order": 0, "signer": 1, "scan": 2, "seal": 3, "seller_scan": 4},
    "release": {"order": 1, "buyer": 4, "signer": 5},
    "dispute": {"order": 1, "buyer": 4, "seller": 5, "signer": 6, "seal": 7},
}


def anchor_discriminator(name: str) -> bytes:
    """Anchor ≥ 0.30 default: sha256("global:<snake_case name>")[:8]."""
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]


def account_discriminator(name: str) -> bytes:
    """sha256("account:<TypeName>")[:8]."""
    return hashlib.sha256(f"account:{name}".encode()).digest()[:8]


def event_discriminator(name: str) -> bytes:
    """sha256("event:<EventName>")[:8] — first 8 bytes of every `emit!` payload."""
    return hashlib.sha256(f"event:{name}".encode()).digest()[:8]


ORDER_DISC = account_discriminator("Order")
SCAN_PROOF_DISC = account_discriminator("ScanProof")
ORDER_LEN = 244


class TxRejected(Exception):
    """A reported transaction does not back the event. `detail` is the client-facing code, `reason` is for logs."""

    def __init__(self, status: int, detail: str, reason: str = ""):
        super().__init__(f"{detail}: {reason}" if reason else detail)
        self.status, self.detail, self.reason = status, detail, reason


def _mismatch(reason: str) -> TxRejected:
    return TxRejected(403, "tx_mismatch", reason)


# ---------- base58 (no extra dependency) ----------

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58)}


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        try:
            n = n * 58 + _B58_INDEX[c]
        except KeyError as exc:
            raise ValueError(f"invalid base58 character {c!r}") from exc
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + body


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + out


def is_pubkey(s: str | None) -> bool:
    if not s or len(s) > 44:
        return False
    try:
        Pubkey.from_string(s)
        return True
    except Exception:  # noqa: BLE001
        return False


def is_signature(s: str | None) -> bool:
    """A transaction signature: base58 of exactly 64 bytes (87–88 characters)."""
    if not s or not 64 <= len(s) <= 88:
        return False
    try:
        return len(b58decode(s)) == 64
    except ValueError:
        return False


# ---------- parsing ----------

@dataclass
class Instruction:
    program: str | None
    accounts: list[str]
    data: bytes


@dataclass
class ParsedTx:
    signatures: list[str]
    signers: list[str]
    keys: list[str]                   # static account keys + v0 loaded addresses (index space of the instructions)
    instructions: list[Instruction]   # top-level and inner (CPI) instructions
    err: Any
    block_time: int | None
    logs: list[str] = field(default_factory=list)


def parse_transaction(res: dict) -> ParsedTx:
    """getTransaction result, "json" encoding (legacy or v0)."""
    tx = res.get("transaction")
    if not isinstance(tx, dict):
        raise _mismatch("transaction not in json encoding")
    msg = tx.get("message") or {}
    meta = res.get("meta") or {}
    static = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    loaded = meta.get("loadedAddresses") or {}
    keys = static + list(loaded.get("writable") or []) + list(loaded.get("readonly") or [])
    n_sig = int((msg.get("header") or {}).get("numRequiredSignatures") or 0)

    def ix(raw: dict) -> Instruction:
        pi = raw.get("programIdIndex")
        program = keys[pi] if isinstance(pi, int) and 0 <= pi < len(keys) else None
        accounts = [keys[i] for i in (raw.get("accounts") or []) if isinstance(i, int) and 0 <= i < len(keys)]
        try:
            data = b58decode(raw.get("data") or "")
        except ValueError:
            data = b""
        return Instruction(program, accounts, data)

    instructions = [ix(r) for r in (msg.get("instructions") or [])]
    for inner in meta.get("innerInstructions") or []:
        instructions.extend(ix(r) for r in (inner.get("instructions") or []))
    bt = res.get("blockTime")
    logs = [x for x in (meta.get("logMessages") or []) if isinstance(x, str)]
    return ParsedTx(signatures=list(tx.get("signatures") or []), signers=static[:n_sig], keys=keys,
                    instructions=instructions, err=meta.get("err"), block_time=int(bt) if isinstance(bt, (int, float)) else None,
                    logs=logs)


_INVOKE = re.compile(r"^Program (\S+) invoke \[\d+\]$")
_EXIT = re.compile(r"^Program (\S+) (success|failed)")
_DATA = "Program data: "


def program_events(logs: list[str], program: str) -> list[bytes]:
    """
    Anchor `emit!` payloads (`Program data: <base64>`) that `program` itself logged. The runtime frames every
    invocation with "Program <id> invoke [n]" … "Program <id> success|failed"; programs cannot write those lines
    (their own logs are prefixed "Program log:"), so the invoke stack attributes each data line to its emitter.
    """
    stack: list[str] = []
    out: list[bytes] = []
    for line in logs:
        m = _INVOKE.match(line)
        if m:
            stack.append(m.group(1))
            continue
        m = _EXIT.match(line)
        if m:
            if stack:
                stack.pop()
            continue
        if line.startswith(_DATA) and stack and stack[-1] == program:
            for part in line[len(_DATA):].split():
                try:
                    out.append(base64.b64decode(part, validate=True))
                except ValueError:
                    pass
    return out


# ---------- Borsh decoding of instruction args, events and accounts ----------

class _R:
    def __init__(self, data: bytes):
        self.d, self.o = data, 0

    def take(self, n: int) -> bytes:
        if self.o + n > len(self.d):
            raise ValueError("truncated")
        b = self.d[self.o:self.o + n]
        self.o += n
        return b

    def u8(self) -> int: return self.take(1)[0]
    def u16(self) -> int: return struct.unpack("<H", self.take(2))[0]
    def u32(self) -> int: return struct.unpack("<I", self.take(4))[0]
    def u64(self) -> int: return struct.unpack("<Q", self.take(8))[0]
    def i64(self) -> int: return struct.unpack("<q", self.take(8))[0]
    def b(self) -> bool: return self.take(1)[0] != 0
    def pk(self) -> str: return str(Pubkey.from_bytes(self.take(32)))
    def h32(self) -> str: return self.take(32).hex()


_ARG_LAYOUTS: dict[str, list[tuple[str, str]]] = {
    "mint_passport": [("serialHash", "h32"), ("bindingHash", "h32"), ("asset", "pk")],
    "attach_seal": [("uidHash", "h32"), ("kind", "u8")],
    "record_scan": [("counter", "u32"), ("tier", "u8"), ("role", "u8"), ("tamper", "u8"), ("uv", "u8"), ("hum", "u8"),
                    ("heat", "u8"), ("heatLevels", "u8"), ("fill", "u8"), ("siteId", "u16"), ("mediaHash", "h32"),
                    ("bundleHash", "h32"), ("nonce", "h32"), ("ts", "i64"), ("serverKeyId", "u8")],
    "list": [("price", "u64")],
    "reserve": [("expectedPrice", "u64")],        # reserve(expected_price) once the escrow program takes it
}

_EVENT_LAYOUTS: dict[str, list[tuple[str, str]]] = {
    "OrderListed": [("order", "pk"), ("passport", "pk"), ("seller", "pk"), ("asset", "pk"), ("price", "u64"),
                    ("disputeAfterS", "i64"), ("ts", "i64")],
    "OrderReserved": [("order", "pk"), ("buyer", "pk"), ("price", "u64"), ("vault", "pk"), ("ts", "i64")],
    "PreShipScanRecorded": [("order", "pk"), ("scanProof", "pk"), ("counter", "u32"), ("ts", "i64")],
    "OrderShipped": [("order", "pk"), ("ts", "i64")],
    "ReceiptScanRecorded": [("order", "pk"), ("scanProof", "pk"), ("counter", "u32"), ("matched", "b"),
                            ("sellerFill", "u8"), ("buyerFill", "u8"), ("sellerHeat", "u8"), ("buyerHeat", "u8"),
                            ("sellerHum", "u8"), ("buyerHum", "u8"), ("ts", "i64")],
    "OrderReleased": [("order", "pk"), ("seller", "pk"), ("buyer", "pk"), ("amount", "u64"), ("assetTransferred", "b"),
                      ("ts", "i64")],
    "OrderDisputed": [("order", "pk"), ("by", "pk"), ("reason", "u8"), ("previousState", "u8"), ("refunded", "u64"),
                      ("assetReturned", "b"), ("ts", "i64")],
}
_EVENT_BY_DISC = {event_discriminator(n): n for n in _EVENT_LAYOUTS}


def _decode(layout: list[tuple[str, str]], data: bytes) -> dict[str, Any] | None:
    r = _R(data)
    out: dict[str, Any] = {}
    try:
        for name, kind in layout:
            out[name] = getattr(r, kind)()
    except ValueError:
        return None
    return out


def decode_ix_args(name: str, data: bytes) -> dict[str, Any] | None:
    """Arguments of a verified instruction (after its 8-byte discriminator); None when absent or truncated."""
    layout = _ARG_LAYOUTS.get(name)
    return _decode(layout, data[8:]) if layout else None


def decode_event(data: bytes) -> tuple[str, dict[str, Any]] | None:
    name = _EVENT_BY_DISC.get(data[:8])
    if not name:
        return None
    ev = _decode(_EVENT_LAYOUTS[name], data[8:])
    return (name, ev) if ev is not None else None


def decode_order(data: bytes | None) -> dict[str, Any] | None:
    """escrow Order account (programs/escrow/src/state.rs, 244 bytes); None unless it carries the Order discriminator."""
    if not data or len(data) < ORDER_LEN or data[:8] != ORDER_DISC:
        return None
    r = _R(data[8:])
    return {"passport": r.pk(), "seller": r.pk(), "buyer": r.pk(), "asset": r.pk(), "price": r.u64(), "state": r.u8(),
            "listedAt": r.i64(), "reservedAt": r.i64(), "shippedAt": r.i64(), "sellerScan": r.pk(), "buyerScan": r.pk(),
            "disputeAfterS": r.i64(), "assetDeposited": r.b(), "bump": r.u8(), "vaultBump": r.u8()}


def decode_scan_proof_checked(data: bytes | None) -> dict[str, Any] | None:
    """flacon ScanProof, only with its real Anchor discriminator."""
    if not data or data[:8] != SCAN_PROOF_DISC:
        return None
    try:
        return decode_scan_proof(data)
    except ValueError:
        return None


# ---------- verification ----------

@dataclass
class Expectation:
    program: str                                  # program id that must run the matching instruction
    instructions: tuple[str, ...]                 # accepted Anchor instruction names
    passport: str                                 # passport PDA of the event's serial
    seal: str | None = None                       # seal PDA (SEAL_ATTACH, SEAL_DEAD with a known seal, SCAN)
    scan: str | None = None                       # ScanProof PDA (SCAN)
    escrow: bool = False                          # escrow program: bind through the Order account
    known_sellers: tuple[str, ...] = ()           # sellers of earlier LIST events (Order PDAs to try without RPC)


@dataclass
class VerifiedTx:
    signature: str
    actor: str
    block_time: int | None
    accounts: set[str]                            # accounts referenced by the matching instruction
    name: str = ""                                # Anchor instruction name that matched
    ix_accounts: list[str] = field(default_factory=list)   # the same accounts, in instruction order
    data: bytes = b""                             # instruction data (discriminator + Borsh args)
    events: list[tuple[str, dict]] = field(default_factory=list)   # the program's decoded Anchor events
    order_address: str | None = None              # escrow: the Order account at its IDL position
    order: dict | None = None                     # escrow: that Order as read from chain (None if closed / unread)
    account_data: dict[str, bytes | None] = field(default_factory=dict)  # escrow: data of the instruction's accounts

    @property
    def args(self) -> dict | None:
        return decode_ix_args(self.name, self.data)

    def account(self, role: str) -> str | None:
        pos = IX_ACCOUNTS.get(self.name, {}).get(role)
        return self.ix_accounts[pos] if pos is not None and pos < len(self.ix_accounts) else None

    def event(self, name: str) -> dict | None:
        """The first `name` event of the program that refers to this instruction's order (escrow) or any (flacon)."""
        for n, ev in self.events:
            if n == name and (self.order_address is None or ev.get("order") == self.order_address):
                return ev
        return None


class _TxCache:
    def __init__(self):
        self.hits: OrderedDict[str, tuple[float, dict]] = OrderedDict()
        self.misses: dict[str, float] = {}
        self.lock = threading.Lock()


_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_LOOKUPS)
_CACHE_LOCK = threading.Lock()


def _cache_for(rpc) -> _TxCache:
    c = getattr(rpc, "_fv_tx_cache", None)
    if c is None:
        with _CACHE_LOCK:
            c = getattr(rpc, "_fv_tx_cache", None)
            if c is None:
                c = _TxCache()
                try:
                    setattr(rpc, "_fv_tx_cache", c)
                except AttributeError:      # an RPC object without attributes: no cache
                    pass
    return c


def fetch_transaction(rpc, signature: str) -> dict:
    cache = _cache_for(rpc)
    now = time.monotonic()
    with cache.lock:
        hit = cache.hits.get(signature)
        if hit and now - hit[0] < TX_CACHE_TTL_S:
            cache.hits.move_to_end(signature)
            return hit[1]
        missed = cache.misses.get(signature)
        if missed is not None and now - missed < MISS_CACHE_TTL_S:
            raise TxRejected(503, "tx_not_visible", f"{signature[:12]}… not found a moment ago")
    if not _SLOTS.acquire(blocking=False):
        raise TxRejected(429, "rate_limited", "too many transaction lookups in flight")
    try:
        delays = TX_RETRY_DELAYS
        for attempt in range(len(delays) + 1):
            try:
                res = rpc.get_transaction(signature)
            except RpcError as exc:
                log.warning("getTransaction %s… failed: %s", signature[:12], exc)
                res = None
            if isinstance(res, dict) and isinstance(res.get("meta"), dict):   # meta null = status not available yet
                with cache.lock:
                    cache.hits[signature] = (time.monotonic(), res)
                    cache.misses.pop(signature, None)
                    while len(cache.hits) > TX_CACHE_SIZE:
                        cache.hits.popitem(last=False)
                return res
            if attempt < len(delays):
                time.sleep(delays[attempt])
    finally:
        _SLOTS.release()
    with cache.lock:
        cache.misses[signature] = time.monotonic()
        if len(cache.misses) > 4 * TX_CACHE_SIZE:
            cutoff = time.monotonic() - MISS_CACHE_TTL_S
            for k in [k for k, t in cache.misses.items() if t < cutoff]:
                del cache.misses[k]
    raise TxRejected(503, "tx_not_visible", f"{signature[:12]}… not found after {len(delays) + 1} lookups")


def _positions_ok(ix: Instruction, name: str, exp: Expectation) -> bool:
    pos = IX_ACCOUNTS.get(name, {})

    def at(role: str) -> str | None:
        i = pos.get(role)
        return ix.accounts[i] if i is not None and i < len(ix.accounts) else None

    if "passport" in pos and at("passport") != exp.passport:
        return False
    if not exp.escrow:
        if exp.seal and at("seal") != exp.seal:
            return False
        if exp.scan and at("scan") != exp.scan:
            return False
    elif at("order") is None:
        return False
    return True


def _fetch_accounts(rpc, accounts: list[str]) -> dict[str, bytes | None]:
    uniq = list(dict.fromkeys(accounts))
    datas = rpc.get_multiple_accounts(uniq)
    return dict(zip(uniq, datas))


def verify_transaction(rpc, signature: str, actor: str, exp: Expectation) -> VerifiedTx:
    res = fetch_transaction(rpc, signature)
    tx = parse_transaction(res)
    if tx.signatures and signature not in tx.signatures:
        raise _mismatch("signature is not part of the returned transaction")
    if actor not in tx.signers:
        raise _mismatch(f"actor {actor[:8]}… did not sign")
    names = {anchor_discriminator(n): n for n in exp.instructions}
    passport_pk = Pubkey.from_string(exp.passport)
    for ix in tx.instructions:
        name = names.get(ix.data[:8]) if ix.program == exp.program else None
        if not name or not _positions_ok(ix, name, exp):
            continue
        if actor not in ix.accounts:
            continue
        order_addr, order, data = None, None, {}
        if exp.escrow:
            order_addr = ix.accounts[IX_ACCOUNTS[name]["order"]]
            sellers = {*tx.keys, *exp.known_sellers}
            bound = name == "list" or order_addr in {str(pda_order(exp.program, passport_pk, s)) for s in sellers if is_pubkey(s)}
            if not bound or tx.err is None:
                try:
                    data = _fetch_accounts(rpc, ix.accounts)
                except RpcError as exc:
                    if not bound:
                        raise TxRejected(503, "tx_not_visible", f"order lookup failed: {exc}") from exc
                    log.warning("escrow accounts of %s… not readable: %s", signature[:12], exc)
                order = decode_order(data.get(order_addr))
                if order and not (order["passport"] == exp.passport
                                  and str(pda_order(exp.program, passport_pk, order["seller"])) == order_addr):
                    order = None                  # an Order of another passport (or not at its PDA)
                bound = bound or order is not None
            if not bound:
                continue
        if tx.err is not None:
            raise TxRejected(422, "tx_failed", f"meta.err={tx.err}")
        events = [e for e in (decode_event(d) for d in program_events(tx.logs, exp.program)) if e]
        return VerifiedTx(signature=signature, actor=actor, block_time=tx.block_time, accounts=set(ix.accounts), name=name,
                          ix_accounts=list(ix.accounts), data=ix.data, events=events, order_address=order_addr,
                          order=order, account_data=data)
    raise _mismatch(f"no {'/'.join(exp.instructions)} instruction of {exp.program[:8]}… with the expected accounts")
