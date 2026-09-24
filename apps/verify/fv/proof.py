"""
ScanProof primitives — byte-identical to packages/proof (TS) and programs/flacon (Rust).
Fixtures: docs/vectors.json (scans[], grades[]).

  msg = "FVSCAN1" ‖ serial_hash(32) ‖ uid_hash(32) ‖ counter u32le ‖ tamper ‖ uv ‖ hum ‖ heat ‖ fill
        ‖ media_hash(32) ‖ nonce(32) ‖ ts i64le                                  → 152 bytes
  sig = ed25519(server_seed, msg)
"""
from __future__ import annotations

import hashlib
import json
import struct
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from fv.enums import Grade, Indicator, Tamper, VALID, SEAL_KIND_NAMES

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
