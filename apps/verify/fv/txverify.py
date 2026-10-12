"""
On-chain backing for client-reported events (POST /api/events).

An event that claims an on-chain action is accepted only with the signature of a confirmed transaction that
  * the claimed `actor` signed,
  * ran an instruction of the expected program (flacon for MINT / SEAL_ATTACH / SCAN / SEAL_DEAD, escrow for
    LIST…DISPUTE) whose Anchor discriminator matches the event type, and whose account list references the actor,
    the passport PDA of the event's serial (escrow: the passport itself or one of its Order PDAs) and, where it
    applies, the seal PDA and the ScanProof PDA,
  * succeeded (`meta.err` is null) — checked after the binding, so a foreign failed tx can never fail an event.

Failures map to the HTTP contract the web client relies on:
  503 tx_not_visible (not found after the quick retries — client retries) · 422 tx_failed · 403 tx_mismatch.
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from solders.pubkey import Pubkey

from fv.chain import RpcError, pda_order
from fv.enums import EventType

log = logging.getLogger("fv.txverify")

# getTransaction is retried after each delay: 4 lookups spread over ≈ 4 s, then 503 tx_not_visible.
TX_RETRY_DELAYS: tuple[float, ...] = (1.0, 1.5, 1.5)

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
    EventType.SHIP: ("ship", "record_pre_ship_scan"),
    EventType.RECEIVE: ("record_receipt_scan",),
    EventType.RELEASE: ("release",),
    EventType.DISPUTE: ("dispute",),
}
# Event types that can only be created with a verified transaction (SEAL_DEAD may also be *reported* without one).
TX_REQUIRED: frozenset[int] = frozenset({EventType.MINT, EventType.SEAL_ATTACH, *ESCROW_IX})


def anchor_discriminator(name: str) -> bytes:
    """Anchor ≥ 0.30 default: sha256("global:<snake_case name>")[:8]."""
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]


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
    return ParsedTx(signatures=list(tx.get("signatures") or []), signers=static[:n_sig], keys=keys,
                    instructions=instructions, err=meta.get("err"), block_time=int(bt) if isinstance(bt, (int, float)) else None)


# ---------- verification ----------

@dataclass
class Expectation:
    program: str                                  # program id that must run the matching instruction
    instructions: tuple[str, ...]                 # accepted Anchor instruction names
    required: list[str] = field(default_factory=list)   # accounts the instruction must reference (all of them)
    # escrow: the passport is bound either directly (passport PDA, e.g. `list`) or through an Order PDA
    # ["order", passport, seller]; sellers tried = every key of the tx plus these known ones (e.g. LIST actors).
    order_passport: str | None = None
    order_program: str | None = None
    known_sellers: tuple[str, ...] = ()


@dataclass
class VerifiedTx:
    signature: str
    actor: str
    block_time: int | None
    accounts: set[str]                            # accounts referenced by the matching instruction


def fetch_transaction(rpc, signature: str) -> dict:
    delays = TX_RETRY_DELAYS
    for attempt in range(len(delays) + 1):
        try:
            res = rpc.get_transaction(signature)
        except RpcError as exc:
            log.warning("getTransaction %s… failed: %s", signature[:12], exc)
            res = None
        if isinstance(res, dict) and isinstance(res.get("meta"), dict):   # meta null = status not available yet
            return res
        if attempt < len(delays):
            time.sleep(delays[attempt])
    raise TxRejected(503, "tx_not_visible", f"{signature[:12]}… not found after {len(delays) + 1} lookups")


def _order_pdas(exp: Expectation, keys: list[str]) -> set[str]:
    if not (exp.order_passport and exp.order_program):
        return set()
    passport = Pubkey.from_string(exp.order_passport)
    out: set[str] = set()
    for s in {*keys, *exp.known_sellers}:
        if is_pubkey(s):
            out.add(str(pda_order(exp.order_program, passport, s)))
    return out


def verify_transaction(rpc, signature: str, actor: str, exp: Expectation) -> VerifiedTx:
    res = fetch_transaction(rpc, signature)
    tx = parse_transaction(res)
    if tx.signatures and signature not in tx.signatures:
        raise _mismatch("signature is not part of the returned transaction")
    if actor not in tx.signers:
        raise _mismatch(f"actor {actor[:8]}… did not sign")
    discs = {anchor_discriminator(n) for n in exp.instructions}
    bindings = ({exp.order_passport} | _order_pdas(exp, tx.keys)) if exp.order_passport else set()
    for ix in tx.instructions:
        if ix.program != exp.program or ix.data[:8] not in discs:
            continue
        accounts = set(ix.accounts)
        if actor not in accounts or not all(a in accounts for a in exp.required):
            continue
        if bindings and not (accounts & bindings):
            continue
        if tx.err is not None:
            raise TxRejected(422, "tx_failed", f"meta.err={tx.err}")
        return VerifiedTx(signature=signature, actor=actor, block_time=tx.block_time, accounts=accounts)
    raise _mismatch(f"no {'/'.join(exp.instructions)} instruction of {exp.program[:8]}… with the expected accounts")
