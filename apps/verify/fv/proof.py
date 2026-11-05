"""
ScanProof primitives — byte-identical to packages/proof (TS) and programs/flacon (Rust).
Fixtures: docs/vectors.json (scans[], grades[], v2.*).

  msg = "FVSCAN1" ‖ serial_hash(32) ‖ uid_hash(32) ‖ counter u32le ‖ tamper ‖ uv ‖ hum ‖ heat ‖ fill
        ‖ media_hash(32) ‖ nonce(32) ‖ ts i64le                                  → 152 bytes
  sig = ed25519(server_seed, msg)

FVSCAN2 (public record, docs/public-record.md §3–4): the 256-byte message record_scan_v2 parses out of the Ed25519
instruction, its v2 bundle (no note, city, platform or attester pubkey), the Holding commitment and the scan-head fold.
The same scan key signs both; prefix and length (152 vs 256) keep the two domains apart (D19). The v1 functions are
unchanged.
"""
from __future__ import annotations

import hashlib
import json
import struct
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from fv.enums import ActorKind, Cluster, Grade, Indicator, Purpose, Role, SealKind, Tamper, Tier, VALID, SEAL_KIND_NAMES

MSG_PREFIX = b"FVSCAN1"
MSG_LEN = 152
BUNDLE_SCHEMA = "flaconvault.scanproof.v1"
ZERO32 = bytes(32)
HEAT_DECISIVE_INDEX = 4  # the 40 °C field


# ---------- hashing / hex ----------

def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def serial_hash(serial: str) -> bytes:
    """sha256 of the serial string (UTF-8)."""
    return sha256(serial.encode("utf-8"))


def uid_hash(uid: bytes) -> bytes:
    """sha256 of the 7 raw UID bytes (not the hex string)."""
    if len(uid) != 7:
        raise ValueError(f"uid must be 7 bytes, got {len(uid)}")
    return sha256(uid)


def binding_hash(serial: str, batch_code: str, first_seal_uid_hash: bytes) -> bytes:
    return sha256(serial.encode("utf-8") + batch_code.encode("utf-8") + first_seal_uid_hash)


def hex0x(b: bytes) -> str:
    return "0x" + b.hex()


def strip0x(h: str) -> str:
    h = h.strip()
    return h[2:] if h[:2] in ("0x", "0X") else h


def parse_hex(h: str, length: int | None = None, what: str = "hex") -> bytes:
    try:
        b = bytes.fromhex(strip0x(h))
    except ValueError as exc:
        raise ValueError(f"{what}: not hex") from exc
    if length is not None and len(b) != length:
        raise ValueError(f"{what}: expected {length} bytes, got {len(b)}")
    return b


# ---------- message ----------

def build_message(*, serial_hash: bytes, uid_hash: bytes, counter: int, tamper: int, uv: int, hum: int,
                  heat: int, fill: int, media_hash: bytes, nonce: bytes, ts: int) -> bytes:
    for name, v in (("serial_hash", serial_hash), ("uid_hash", uid_hash), ("media_hash", media_hash), ("nonce", nonce)):
        if len(v) != 32:
            raise ValueError(f"{name} must be 32 bytes")
    if not 0 <= fill <= 100:
        raise ValueError("fill must be 0..100")
    for name, v in (("tamper", tamper), ("uv", uv), ("hum", hum), ("heat", heat)):
        if not 0 <= v <= 255:
            raise ValueError(f"{name} out of u8 range")
    msg = (MSG_PREFIX + serial_hash + uid_hash + struct.pack("<I", counter)
           + bytes([tamper, uv, hum, heat, fill]) + media_hash + nonce + struct.pack("<q", ts))
    assert len(msg) == MSG_LEN
    return msg


def parse_message(msg: bytes) -> dict[str, Any]:
    if len(msg) != MSG_LEN:
        raise ValueError(f"message length {len(msg)} != {MSG_LEN}")
    if msg[:7] != MSG_PREFIX:
        raise ValueError("bad prefix")
    o = 7
    out: dict[str, Any] = {}
    out["serial_hash"] = msg[o:o + 32]; o += 32
    out["uid_hash"] = msg[o:o + 32]; o += 32
    out["counter"] = struct.unpack_from("<I", msg, o)[0]; o += 4
    out["tamper"], out["uv"], out["hum"], out["heat"], out["fill"] = msg[o:o + 5]; o += 5
    out["media_hash"] = msg[o:o + 32]; o += 32
    out["nonce"] = msg[o:o + 32]; o += 32
    out["ts"] = struct.unpack_from("<q", msg, o)[0]
    return out


# ---------- ed25519 ----------

def signing_key(seed: bytes) -> SigningKey:
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    return SigningKey(seed)


def public_key(seed: bytes) -> bytes:
    return signing_key(seed).verify_key.encode()


def sign(seed: bytes, msg: bytes) -> bytes:
    return signing_key(seed).sign(msg).signature


def verify(pubkey: bytes, msg: bytes, sig: bytes) -> bool:
    try:
        VerifyKey(pubkey).verify(msg, sig)
        return True
    except BadSignatureError:
        return False


# ---------- grade (briefing §4.5) ----------

def compute_grade(*, verdict: str, tamper: int, heat: int, hum: int, fill: int, seal_dead: bool = False) -> tuple[int, bool]:
    """Returns (grade, review_recommended). UNREADABLE never lowers, sets the review flag."""
    review = heat == Indicator.UNREADABLE or hum == Indicator.UNREADABLE
    if verdict != VALID or tamper in (Tamper.OPENED_NOW, Tamper.OPENED_BEFORE) or seal_dead:
        return Grade.VOID, review
    if heat == Indicator.TRIGGERED or hum == Indicator.TRIGGERED:
        return Grade.C, review
    if fill >= 90:
        return Grade.A, review
    if fill >= 60:
        return Grade.B, review
    return Grade.D, review


def passport_after_scan(old_grade: int, old_void: bool, scan_grade: int, *, latest: bool = True) -> tuple[int, bool]:
    """
    Passport (grade, void) after a confirmed scan graded `scan_grade` — the verifier's mirror of record_scan
    (programs/flacon/src/grade.rs passport_after_scan; a scan grades VOID exactly when its tamper code says opened, and C
    exactly when heat or humidity triggered):
      VOID   if the passport is void or VOID already, or the scan grades VOID (sets void for good);
      C      else if the passport is C already, or the scan grades C (sticky);
      A/B/D  else the scan's own grade — but only from the newest confirmed scan (`latest`): an older scan whose
             confirmation arrives late may still make the passport C or VOID, never overwrite a newer fill reading.
    """
    old_grade, scan_grade = int(old_grade), int(scan_grade)
    if old_void or old_grade == Grade.VOID or scan_grade == Grade.VOID:
        return Grade.VOID, True
    if old_grade == Grade.C or scan_grade == Grade.C:
        return Grade.C, False
    return (scan_grade if latest else old_grade), False


def passport_from_chain(db_grade: int, db_void: bool, chain_grade: int, chain_void: bool, *,
                        chain_current: bool = True) -> tuple[int, bool]:
    """
    Passport (grade, void) after the reconcile job read the Passport account. VOID and C are sticky on both sides
    (whichever side has them wins); otherwise the chain's A/B/D wins, because record_scan applied the newest anchored
    scan. `chain_current` False (the account read shows fewer scans than the database has confirmed on chain: a lagging
    RPC node) keeps the database's A/B/D, so a stale read never flips a grade back and forth.
    """
    db_grade, chain_grade = int(db_grade), int(chain_grade)
    if db_void or chain_void or db_grade == Grade.VOID or chain_grade == Grade.VOID:
        return Grade.VOID, True
    if db_grade == Grade.C or chain_grade == Grade.C:
        return Grade.C, False
    return (chain_grade if chain_current else db_grade), False


def heat_levels_to_mask(levels: list[int]) -> int:
    if len(levels) != 6:
        raise ValueError("heatLevels must have 6 entries")
    mask = 0
    for i, v in enumerate(levels):
        if v not in (0, 1):
            raise ValueError("heatLevels entries must be 0/1")
        if v:
            mask |= 1 << i
    return mask


def mask_to_heat_levels(mask: int) -> list[int]:
    return [(mask >> i) & 1 for i in range(6)]


# ---------- canonical JSON / bundle (briefing §4.4) ----------

def canonical_json(obj: Any) -> str:
    """JCS-style: keys sorted, no whitespace, non-ASCII kept verbatim (matches packages/proof canonicalize)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def bundle_hash(canonical: str) -> bytes:
    return sha256(canonical.encode("utf-8"))


def build_bundle(*, serial: str, serial_hash_b: bytes, uid_hash_b: bytes, counter: int, seal_kind: int,
                 tamper: int, heat: int, hum: int, uv: int, heat_levels: list[int], fill: int,
                 country: str | None, city: str | None, media_hash_b: bytes | None, media_ar: str | None,
                 nonce_b: bytes, issued_at: int, platform: str, role: int, tier: int, attester: str | None,
                 key_id: int, verdict: str, server_ts: int, sig_b: bytes | None, bundle_ts: int,
                 loop_intact: bool | None = None, note: str = "") -> dict[str, Any]:
    uh = hex0x(uid_hash_b)
    media = []
    if media_hash_b is not None and media_hash_b != ZERO32:
        media.append({"type": "SEAL_FRAMES", "sha256": hex0x(media_hash_b), "ar": media_ar})
    return {
        "schema": BUNDLE_SCHEMA,
        "serial": serial,
        "serialHash": hex0x(serial_hash_b),
        "uidHash": uh,
        "counter": counter,
        "seal": {"kind": SEAL_KIND_NAMES[seal_kind], "uidHash": uh},
        "tamper": tamper,
        "indicators": {"heat": heat, "humidity": hum, "uv": uv},
        "heatLevels": list(heat_levels),
        "fill": fill,
        "visual": {"loopIntact": loop_intact, "note": note},
        "location": {"country": country, "city": city},
        "media": media,
        "logger": None,
        "session": {"nonce": hex0x(nonce_b), "issuedAt": issued_at},
        "device": {"platform": platform},
        "attester": {"role": role, "tier": tier, "pubkey": attester},
        "server": {"keyId": key_id, "verdict": verdict, "ts": server_ts, "sig": hex0x(sig_b) if sig_b else None},
        "ts": bundle_ts,
    }


BUNDLE_KEYS = ("schema", "serial", "serialHash", "uidHash", "counter", "seal", "tamper", "indicators", "heatLevels", "fill",
               "visual", "location", "media", "logger", "session", "device", "attester", "server", "ts")


def bundle_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Strip the server extras (grade, msgHex, bundleHash, reconcile, …) off a stored SCAN payload → pure §4.4 bundle."""
    return {k: payload[k] for k in BUNDLE_KEYS if k in payload}


# ---------- FVSCAN2: the public-record scan message (docs/public-record.md §3) ----------

MSG2_PREFIX = b"FVSCAN2"
MSG2_LEN = 256
BUNDLE2_SCHEMA = "flaconvault.scanbundle.v2"
SCAN_HEAD_PREFIX = b"FVHEAD1"
COMMITMENT_PREFIX = b"FVHOLD1"
FILL_NONE = 255                 # "no fill reading": tier SIGHTING ⇔ fill FILL_NONE (D4)
MAX_COUNTER = 0x00FFFFFF        # 24-bit NTAG 424 SUN counter (Rust MAX_COUNTER)
HEAT_DECISIVE_BIT = HEAT_DECISIVE_INDEX
# byte offsets (Rust V2_OFF_* in message_v2.rs, TS MSG2_OFFSETS)
MSG2_OFFSETS = {"prefix": 0, "program_id": 7, "cluster_tag": 39, "serial_hash": 40, "uid_hash": 72, "counter": 104,
                "tier": 108, "role": 109, "tamper": 110, "uv": 111, "hum": 112, "heat": 113, "heat_levels": 114,
                "fill": 115, "site_id": 116, "purpose": 118, "actor_kind": 119, "actor": 120, "media_hash": 152,
                "bundle_hash": 184, "nonce": 216, "ts": 248}
MSG2_HASH_FIELDS = ("program_id", "serial_hash", "uid_hash", "actor", "media_hash", "bundle_hash", "nonce")
_MSG2_STRUCT = struct.Struct("<7s32sB32s32sIBBBBBBBBHBB32s32s32s32sq")
assert _MSG2_STRUCT.size == MSG2_LEN
_MSG2_ORDER = ("program_id", "cluster_tag", "serial_hash", "uid_hash", "counter", "tier", "role", "tamper", "uv", "hum",
               "heat", "heat_levels", "fill", "site_id", "purpose", "actor_kind", "actor", "media_hash", "bundle_hash",
               "nonce", "ts")


class ScanFieldError(ValueError):
    """A §3.4 field-rule violation; `code` is the record_scan_v2 error the program would raise (§7.6, §7.8)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _need(ok: bool, code: str, message: str) -> None:
    if not ok:
        raise ScanFieldError(code, message)


def is_pro_role(role: int) -> bool:
    return role in (Role.VAULT, Role.PARTNER)


def check_fields_v2(f: dict[str, Any], *, known_sites: set[int] | None = None) -> None:
    """
    §3.4 field validity in the order of record_scan_v2 step 3 (same error names), then the actor rule 7 (step 4,
    ActorMismatch) — the mirror of packages/proof checkScanFieldsV2. The verifier never signs anything this rejects.
    `known_sites` (registry site ids) checks rule 5's "registered site" when given.
    """
    for name in MSG2_HASH_FIELDS:
        if not isinstance(f[name], (bytes, bytearray)) or len(f[name]) != 32:
            raise ValueError(f"{name} must be 32 bytes")
    for name in ("cluster_tag", "tier", "role", "tamper", "uv", "hum", "heat", "heat_levels", "fill", "purpose", "actor_kind"):
        if not isinstance(f[name], int) or not 0 <= f[name] <= 0xFF:
            raise ValueError(f"{name} must be a u8")
    if not isinstance(f["site_id"], int) or not 0 <= f["site_id"] <= 0xFFFF:
        raise ValueError("site_id must be a u16")
    _need(f["cluster_tag"] in Cluster.values(), "InvalidClusterTag", "cluster_tag must be 1 (MAINNET), 2 (DEVNET) or 3 (LOCALNET)")
    _need(isinstance(f["counter"], int) and 0 <= f["counter"] <= MAX_COUNTER, "CounterOutOfRange", "counter must be ≤ 0x00FFFFFF")
    # step 3
    _need(f["role"] <= max(Role.values()), "InvalidRole", "role must be 0..=4")
    _need(f["tier"] <= max(Tier.values()), "InvalidTier", "tier must be 0..=4")
    _need(f["purpose"] <= max(Purpose.values()), "InvalidPurpose", "purpose must be 0..=6")
    _need(f["actor_kind"] <= max(ActorKind.values()), "InvalidActorKind", "actor_kind must be 0..=4")
    _need(all(f[k] <= Indicator.MISSING for k in ("tamper", "uv", "hum", "heat")), "InvalidIndicator",
          "tamper/uv/hum/heat must be 0..=3")
    _need(f["fill"] <= 100 or f["fill"] == FILL_NONE, "InvalidFill", "fill must be 0..=100 or FILL_NONE (255)")
    _need(f["heat_levels"] < 64, "InvalidHeatLevels", "heat_levels is a 6-bit mask")
    if f["heat"] in (Indicator.INTACT, Indicator.TRIGGERED):
        _need(f["heat"] == (f["heat_levels"] >> HEAT_DECISIVE_BIT) & 1, "HeatInconsistent",
              "heat INTACT/TRIGGERED must equal bit 4 of heat_levels")
    sighting = f["tier"] == Tier.SIGHTING
    _need(sighting == (f["fill"] == FILL_NONE), "InvalidSighting", "tier SIGHTING if and only if fill is FILL_NONE")
    if sighting:
        _need(f["uv"] == f["hum"] == f["heat"] == Indicator.MISSING and f["heat_levels"] == 0 and f["media_hash"] == ZERO32,
              "InvalidSighting", "a sighting has uv/hum/heat MISSING, heat_levels 0 and no media")
    pro = is_pro_role(f["role"])
    if not pro:
        _need(f["tier"] <= Tier.SELF_MEDIA, "TierNotAllowedForRole", "OWNER/SELLER/BUYER scans are at most tier 2")
    if pro or f["tier"] >= Tier.CERTIFIED:
        _need(f["actor_kind"] == ActorKind.PARTNER, "NotPartner", "a pro role or tier ≥ CERTIFIED needs actor PARTNER")
    if f["site_id"] != 0:
        _need(pro, "SiteIdNotAllowed", "site_id is only for role VAULT/PARTNER")
        if known_sites is not None:
            _need(f["site_id"] in known_sites, "UnknownSite", f"site {f['site_id']} is not registered")
    if f["purpose"] == Purpose.TAP:
        _need(sighting, "PurposeNotAllowed", "TAP is a tier-0 sighting")
    if sighting:
        _need(f["purpose"] in (Purpose.TAP, Purpose.CLAIM), "PurposeNotAllowed", "a sighting is a TAP or a CLAIM")
    if f["purpose"] == Purpose.BIRTH:
        _need(f["actor_kind"] == ActorKind.PARTNER and f["tier"] == Tier.BIRTH, "PurposeNotAllowed",
              "BIRTH needs actor PARTNER and tier BIRTH")
    if f["actor_kind"] == ActorKind.NONE:
        _need(f["purpose"] in (Purpose.TAP, Purpose.CHECK), "PurposeNotAllowed", "a visitor scan is a TAP or a CHECK")
    if f["actor_kind"] == ActorKind.RECIPIENT:
        _need(f["purpose"] == Purpose.RECEIPT, "PurposeNotAllowed", "RECIPIENT scans are RECEIPTs")
    # rule 7 (program step 4)
    if f["actor_kind"] == ActorKind.NONE:
        _need(f["actor"] == ZERO32, "ActorMismatch", "a visitor's actor is 32 zero bytes")
    if f["actor_kind"] == ActorKind.RECIPIENT:
        _need(f["actor"] != ZERO32, "ActorMismatch", "a RECIPIENT actor is a commitment")


def build_message_v2(*, program_id: bytes, cluster_tag: int, serial_hash: bytes, uid_hash: bytes, counter: int, tier: int,
                     role: int, tamper: int, uv: int, hum: int, heat: int, heat_levels: int, fill: int, site_id: int,
                     purpose: int, actor_kind: int, actor: bytes, media_hash: bytes, bundle_hash: bytes, nonce: bytes,
                     ts: int, known_sites: set[int] | None = None) -> bytes:
    """
    "FVSCAN2" ‖ program_id ‖ cluster_tag ‖ serial_hash ‖ uid_hash ‖ counter u32 ‖ tier ‖ role ‖ tamper ‖ uv ‖ hum ‖ heat ‖
    heat_levels ‖ fill ‖ site_id u16 ‖ purpose ‖ actor_kind ‖ actor ‖ media_hash ‖ bundle_hash ‖ nonce ‖ ts i64 (256 bytes,
    little endian). Raises ScanFieldError for anything record_scan_v2 would reject (check_fields_v2).
    """
    f = dict(program_id=bytes(program_id), cluster_tag=cluster_tag, serial_hash=bytes(serial_hash), uid_hash=bytes(uid_hash),
             counter=counter, tier=tier, role=role, tamper=tamper, uv=uv, hum=hum, heat=heat, heat_levels=heat_levels,
             fill=fill, site_id=site_id, purpose=purpose, actor_kind=actor_kind, actor=bytes(actor),
             media_hash=bytes(media_hash), bundle_hash=bytes(bundle_hash), nonce=bytes(nonce), ts=ts)
    check_fields_v2(f, known_sites=known_sites)
    msg = _MSG2_STRUCT.pack(MSG2_PREFIX, *(f[k] for k in _MSG2_ORDER))
    assert len(msg) == MSG2_LEN
    return msg


def parse_message_v2(msg: bytes) -> dict[str, Any]:
    """The fields of a 256-byte FVSCAN2 message. Checks length and prefix only (run check_fields_v2 for the rules)."""
    if len(msg) != MSG2_LEN:
        raise ValueError(f"message length {len(msg)} != {MSG2_LEN}")
    values = _MSG2_STRUCT.unpack(bytes(msg))
    if values[0] != MSG2_PREFIX:
        raise ValueError("bad prefix")
    return dict(zip(_MSG2_ORDER, values[1:]))


# ---------- Holding hashes (§4.1, §4.2) ----------

SCAN_HEAD_ZERO = ZERO32


def commitment(passport: bytes, epoch: int, secret: bytes) -> bytes:
    """sha256("FVHOLD1" ‖ passport (32 raw bytes of the Passport PDA) ‖ epoch u32 LE ‖ secret32), 75 input bytes."""
    if len(passport) != 32 or len(secret) != 32:
        raise ValueError("passport and secret must be 32 bytes")
    return sha256(COMMITMENT_PREFIX + bytes(passport) + struct.pack("<I", epoch) + bytes(secret))


def fold_scan_head(head: bytes, msg: bytes) -> bytes:
    """scan_head_n = sha256("FVHEAD1" ‖ scan_head_(n−1) ‖ sha256(msg_n)); msg_n is a full 256-byte FVSCAN2."""
    if len(head) != 32:
        raise ValueError("scan head must be 32 bytes")
    if len(msg) != MSG2_LEN:
        raise ValueError(f"message length {len(msg)} != {MSG2_LEN}")
    return sha256(SCAN_HEAD_PREFIX + bytes(head) + sha256(bytes(msg)))


# ---------- Ed25519 precompile instruction (§3.6) ----------

ED25519_THIS_IX = 0xFFFF
ED25519_HEADER_LEN = 16


def ed25519_ix_data(pubkey: bytes, sig: bytes, msg: bytes) -> bytes:
    """Ed25519SigVerify111… data for one signature carried in the instruction itself (web3.js
    Ed25519Program.createInstructionWithPublicKey layout): 368 bytes for FVSCAN2, 264 for FVSCAN1."""
    if len(pubkey) != 32 or len(sig) != 64:
        raise ValueError("pubkey must be 32 bytes and sig 64 bytes")
    pk_off = ED25519_HEADER_LEN
    sig_off, msg_off = pk_off + 32, pk_off + 32 + 64
    return (struct.pack("<BBHHHHHHH", 1, 0, sig_off, ED25519_THIS_IX, pk_off, ED25519_THIS_IX, msg_off, len(msg),
                        ED25519_THIS_IX) + bytes(pubkey) + bytes(sig) + bytes(msg))


def parse_ed25519_ix_data(data: bytes, *, message_len: int = MSG2_LEN, own_index: int | None = None) -> dict[str, bytes]:
    """
    {pubkey, sig, msg} of Ed25519 instruction data, parsed like the program's parse_single_ed25519_n: one signature, every
    instruction index 0xFFFF (or `own_index`), the given message size, all parts in bounds. Raises ValueError otherwise.
    """
    data = bytes(data)
    if len(data) < ED25519_HEADER_LEN:
        raise ValueError("malformed Ed25519 instruction: shorter than the header")
    n, _pad, sig_off, sig_ix, pk_off, pk_ix, msg_off, msg_size, msg_ix = struct.unpack_from("<BBHHHHHHH", data, 0)
    if n != 1:
        raise ValueError("malformed Ed25519 instruction: not exactly one signature")
    if any(i != ED25519_THIS_IX and i != own_index for i in (sig_ix, pk_ix, msg_ix)):
        raise ValueError("malformed Ed25519 instruction: data lives in another instruction")
    if msg_size != message_len:
        raise ValueError(f"malformed Ed25519 instruction: message is {msg_size} bytes, expected {message_len}")
    if pk_off + 32 > len(data) or sig_off + 64 > len(data) or msg_off + msg_size > len(data):
        raise ValueError("malformed Ed25519 instruction: out of bounds")
    return {"pubkey": data[pk_off:pk_off + 32], "sig": data[sig_off:sig_off + 64], "msg": data[msg_off:msg_off + msg_size]}


# ---------- grade rule v2 (§7.7) ----------

def actor_changes_grade(actor_kind: int) -> bool:
    """Only HOLDER, WALLET and PARTNER scans change grade and void; NONE (a visitor) and RECIPIENT are evidence only."""
    return actor_kind in (ActorKind.HOLDER, ActorKind.WALLET, ActorKind.PARTNER)


def passport_after_scan_v2(old_grade: int, old_void: bool, *, tamper: int, heat: int, hum: int, fill: int) -> tuple[int, bool]:
    """
    record_scan_v2's passport (grade, void) after a HOLDER/WALLET/PARTNER scan: without a fill reading (FILL_NONE) VOID
    and C still apply, A/B/D stay; with one, the v1 rule (passport_after_scan with the scan's own grade).
    """
    opened = tamper in (Tamper.OPENED_NOW, Tamper.OPENED_BEFORE)
    triggered = heat == Indicator.TRIGGERED or hum == Indicator.TRIGGERED
    if fill == FILL_NONE:
        if old_void or int(old_grade) == Grade.VOID or opened:
            return Grade.VOID, True
        if int(old_grade) == Grade.C or triggered:
            return Grade.C, False
        return int(old_grade), False
    scan_grade, _ = compute_grade(verdict=VALID, tamper=tamper, heat=heat, hum=hum, fill=fill)
    return passport_after_scan(old_grade, old_void, scan_grade)


# ---------- v2 bundle (§4.3) ----------

BUNDLE2_KEYS = ("schema", "cluster", "programId", "serial", "serialHash", "seal", "counter", "purpose", "actor", "attester",
                "tamper", "indicators", "heatLevels", "fill", "visual", "location", "media", "session", "server")


def build_bundle_v2(*, program_id: bytes, cluster_tag: int, serial: str, uid_hash_b: bytes, seal_kind: int, counter: int,
                    purpose: int, actor_kind: int, actor: bytes, tier: int, role: int, site_id: int, tamper: int, heat: int,
                    hum: int, uv: int, heat_levels: int, fill: int, loop_intact: bool | None, country: str | None,
                    media_hash_b: bytes, nonce_b: bytes, issued_at: int, key_id: int, server_ts: int) -> dict[str, Any]:
    """
    `flaconvault.scanbundle.v2` — exactly the §4.3 keys: the public detail document whose sha256 FVSCAN2 signs as
    bundle_hash. It carries no server signature (hashed before signing) and none of: free-text note, city, device
    platform, attester pubkey, Arweave links, logger, a second top-level ts — those stay only in SQLite (erasable).
    """
    from solders.pubkey import Pubkey
    if seal_kind not in (SealKind.BOX, SealKind.NECK):
        raise ValueError("v2 bundles name BOX or NECK seals only")
    if country is not None and not (len(country) == 2 and country.isascii() and country.isalpha() and country.isupper()):
        raise ValueError("country must be two upper-case letters or None")
    return {
        "schema": BUNDLE2_SCHEMA,
        "cluster": Cluster.name(cluster_tag),
        "programId": str(Pubkey.from_bytes(bytes(program_id))),
        "serial": serial,
        "serialHash": hex0x(serial_hash(serial)),
        "seal": {"kind": SEAL_KIND_NAMES[seal_kind], "uidHash": hex0x(uid_hash_b)},
        "counter": counter,
        "purpose": Purpose.name(purpose),
        "actor": {"kind": ActorKind.name(actor_kind), "id": None if actor_kind == ActorKind.NONE else hex0x(actor)},
        "attester": {"tier": tier, "role": role, "siteId": site_id},
        "tamper": tamper,
        "indicators": {"heat": heat, "humidity": hum, "uv": uv},
        "heatLevels": mask_to_heat_levels(heat_levels),
        "fill": None if fill == FILL_NONE else fill,
        "visual": {"loopIntact": loop_intact},
        "location": {"country": country},
        "media": [] if bytes(media_hash_b) == ZERO32 else [{"type": "SEAL_FRAMES", "sha256": hex0x(media_hash_b)}],
        "session": {"nonce": hex0x(nonce_b), "issuedAt": issued_at},
        "server": {"keyId": key_id, "verdict": VALID, "ts": server_ts},
    }


def build_scan_v2(*, seed: bytes, key_id: int, program_id: bytes, cluster_tag: int, serial: str, uid_hash_b: bytes,
                  seal_kind: int, counter: int, purpose: int, actor_kind: int, actor: bytes, tier: int, role: int,
                  site_id: int, tamper: int, heat: int, hum: int, uv: int, heat_levels: int, fill: int, country: str | None,
                  media_hash_b: bytes, nonce_b: bytes, issued_at: int, ts: int,
                  loop_intact: bool | None = None) -> tuple[dict[str, Any], bytes, bytes, bytes]:
    """(v2 bundle, bundle_hash, FVSCAN2 message, signature): the bundle is hashed, the hash signed inside the message."""
    bundle = build_bundle_v2(program_id=program_id, cluster_tag=cluster_tag, serial=serial, uid_hash_b=uid_hash_b,
                             seal_kind=seal_kind, counter=counter, purpose=purpose, actor_kind=actor_kind, actor=actor,
                             tier=tier, role=role, site_id=site_id, tamper=tamper, heat=heat, hum=hum, uv=uv,
                             heat_levels=heat_levels, fill=fill, loop_intact=loop_intact, country=country,
                             media_hash_b=media_hash_b, nonce_b=nonce_b, issued_at=issued_at, key_id=key_id, server_ts=ts)
    b_hash = bundle_hash(canonical_json(bundle))
    msg = build_message_v2(program_id=program_id, cluster_tag=cluster_tag, serial_hash=serial_hash(serial),
                           uid_hash=uid_hash_b, counter=counter, tier=tier, role=role, tamper=tamper, uv=uv, hum=hum,
                           heat=heat, heat_levels=heat_levels, fill=fill, site_id=site_id, purpose=purpose,
                           actor_kind=actor_kind, actor=actor, media_hash=media_hash_b, bundle_hash=b_hash, nonce=nonce_b,
                           ts=ts)
    return bundle, b_hash, msg, sign(seed, msg)
