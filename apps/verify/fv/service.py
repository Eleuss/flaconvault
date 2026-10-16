"""
Shared tap check used by GET /t, POST /api/preview and POST /api/verify (briefing §5 steps 2–5), tap adoption, and the
state change of a confirmed scan.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from dataclasses import dataclass

from fv import proof
from fv.config import Settings
from fv.db import (advance_seal_counter, bump_attester, drop_superseded_sighting, get_seal_by_uid, get_tap,
                   last_counter_unregistered, mark_tap_adopted, newer_confirmed_scan_exists, previous_scan_before,
                   set_passport_grade, update_event_payload)
from fv.enums import INVALID, REPLAY, UNREGISTERED, VALID
from fv.sdm import TagParamError, decrypt_tap, key_for_uid, parse_cmac, parse_ctr, parse_uid, validate_tap


@dataclass
class TapCheck:
    verdict: str                     # VALID | INVALID | REPLAY | UNREGISTERED
    uid_hex: str | None = None       # uppercase, 14 chars
    uid_hash_hex: str | None = None  # lowercase, no 0x
    counter: int | None = None
    cmac_hex: str | None = None
    seal: dict | None = None         # seals row when registered
    error: str | None = None         # parse error text for INVALID
    encrypted: bool = False          # tap came as picc_data (+enc) instead of plain uid/ctr

    @property
    def serial(self) -> str | None:
        return self.seal["serial"] if self.seal else None

    @property
    def seal_dead(self) -> bool:
        return bool(self.seal and self.seal["dead"])


_TW = re.compile(r"^([0-9a-fA-F]{14})x([0-9a-fA-F]{6})x([0-9a-fA-F]{16})$")


def split_tagwriter(uid: str | None, ctr: str | int | None, cmac: str | None) -> tuple[str | None, str | int | None, str | None]:
    """NXP TagWriter writes its SDM mirrors as `uid=<UID>x<CTR>x<MAC>`; split that into the three parameters."""
    m = _TW.match((uid or "").strip()) if isinstance(uid, str) and len(uid) <= 64 else None
    if not m:
        return uid, ctr, cmac
    zero = lambda v: v is None or str(v).strip("0") == ""  # noqa: E731
    return m.group(1), (m.group(2) if zero(ctr) else ctr), (m.group(3) if zero(cmac) else cmac)


# Bounds on attacker-controlled tag parameters, checked before any hex decoding or crypto.
MAX_PICC_HEX = 48                 # 16 bytes (AES) = 32 hex, 24 bytes (LRP) = 48 hex
MAX_ENC_HEX = 64                  # SDMENCFileData: at most 32 bytes (production stickers send none)
MAX_PLAIN_HEX = 64                # uid (14) / TagWriter uid (38) / cmac (16) / ctr (6)


def lrp_enabled(settings: Settings) -> bool:
    """24-byte (LRP) picc_data is only accepted when the deployment enables LRP (FV_SDM_LRP); production stickers are AES."""
    return bool(getattr(settings, "sdm_lrp", False))


@dataclass
class TapAuth:
    """Result of the pure crypto step (no DB): the tap's uid/counter if the CMAC is genuine, else `invalid`."""
    uid_b: bytes | None = None
    ctr_n: int | None = None
    cmac_b: bytes | None = None
    encrypted: bool = False
    invalid: TapCheck | None = None


def _hex(value: str | None) -> str:
    v = (value or "").strip()
    return v[2:] if v[:2] in ("0x", "0X") else v


def _too_long(*values) -> bool:
    return any(isinstance(v, str) and len(v) > MAX_PLAIN_HEX for v in values)


def authenticate_tap(settings: Settings, uid: str | None, ctr: str | int | None, cmac: str | None, *,
                     picc_data: str | None = None, enc: str | None = None) -> TapAuth:
    """
    Parse and authenticate a tap — plain mirror (uid, ctr, cmac) or encrypted SUN (picc_data, cmac[, enc]) as written by
    sdm-backend / NFC Developer App. Pure CPU, no DB: callers run it *before* opening a write transaction, so a slow key
    derivation never holds the SQLite write lock. Input sizes are bounded first, so no request can buy unbounded
    (LRP-)CMAC work.
    """
    if picc_data:
        if cmac is None:
            return TapAuth(encrypted=True, invalid=TapCheck(INVALID, error="missing cmac", encrypted=True))
        picc_h, enc_h = _hex(picc_data), _hex(enc)
        if len(picc_h) > MAX_PICC_HEX or len(enc_h) > MAX_ENC_HEX or _too_long(cmac):
            return TapAuth(encrypted=True, invalid=TapCheck(INVALID, error="picc_data/enc/cmac too long", encrypted=True))
        try:
            picc_b = bytes.fromhex(picc_h)
            if len(picc_b) not in (16, 24):
                raise TagParamError("picc_data: expected 16 or 24 bytes")
            if len(picc_b) == 24 and not lrp_enabled(settings):
                raise TagParamError("picc_data: LRP (24 bytes) is not enabled on this server")
            cmac_b = parse_cmac(cmac)
            enc_b = None
            if enc_h:
                enc_b = bytes.fromhex(enc_h)
                if len(enc_b) % 16:
                    raise TagParamError("enc: expected a multiple of 16 bytes")
        except (TagParamError, ValueError) as exc:
            msg = str(exc) if isinstance(exc, TagParamError) else "picc_data/enc: not hex"
            return TapAuth(encrypted=True, invalid=TapCheck(INVALID, error=msg, encrypted=True))
        dec = decrypt_tap(settings.key_mode, settings.master_key, picc_b, cmac_b, enc_b, settings.sdm_derive)
        if dec is None:
            return TapAuth(encrypted=True, invalid=TapCheck(INVALID, cmac_hex=cmac_b.hex().upper(), error="bad cmac", encrypted=True))
        return TapAuth(uid_b=dec[0], ctr_n=dec[1], cmac_b=cmac_b, encrypted=True)
    if _too_long(uid, ctr, cmac):
        return TapAuth(invalid=TapCheck(INVALID, error="uid/ctr/cmac too long"))
    uid, ctr, cmac = split_tagwriter(uid, ctr, cmac)   # NXP TagWriter: uid=<UID>x<CTR>x<MAC>
    if uid is None or ctr is None or cmac is None:
        return TapAuth(invalid=TapCheck(INVALID, uid_hex=(uid or None), error="missing uid/ctr/cmac"))
    try:
        uid_b, ctr_n, cmac_b = parse_uid(uid), parse_ctr(ctr), parse_cmac(cmac)
    except TagParamError as exc:
        return TapAuth(invalid=TapCheck(INVALID, uid_hex=uid if isinstance(uid, str) else None, error=str(exc)))
    key = key_for_uid(settings.key_mode, settings.master_key, uid_b, settings.sdm_derive)
    if not validate_tap(uid_b, ctr_n, cmac_b, key):
        return TapAuth(invalid=TapCheck(INVALID, uid_hex=uid_b.hex().upper(), uid_hash_hex=proof.uid_hash(uid_b).hex(),
                                        counter=ctr_n, cmac_hex=cmac_b.hex().upper(), error="bad cmac"))
    return TapAuth(uid_b=uid_b, ctr_n=ctr_n, cmac_b=cmac_b)


def check_tap(conn, settings: Settings, uid: str | None, ctr: str | int | None, cmac: str | None, *, consume: bool,
              picc_data: str | None = None, enc: str | None = None, auth: TapAuth | None = None) -> TapCheck:
    """
    CMAC → counter → seal lookup. `auth` is authenticate_tap() computed outside the write transaction; without it the
    crypto runs here. With consume=True the seal's last_counter is advanced on a genuine, fresh tap.
    """
    if auth is None:
        auth = authenticate_tap(settings, uid, ctr, cmac, picc_data=picc_data, enc=enc)
    if auth.invalid is not None:
        return auth.invalid
    uid_b, ctr_n, cmac_b, encrypted = auth.uid_b, auth.ctr_n, auth.cmac_b, auth.encrypted
    assert uid_b is not None and ctr_n is not None and cmac_b is not None
    uid_hex, uid_hash_hex, cmac_hex = uid_b.hex().upper(), proof.uid_hash(uid_b).hex(), cmac_b.hex().upper()
    seal = get_seal_by_uid(conn, uid_hex)
    last = int(seal["last_counter"]) if seal else last_counter_unregistered(conn, uid_hex)
    if ctr_n <= last:
        return TapCheck(REPLAY, uid_hex=uid_hex, uid_hash_hex=uid_hash_hex, counter=ctr_n, cmac_hex=cmac_hex, seal=seal, encrypted=encrypted)
    if seal and consume:
        advance_seal_counter(conn, seal["uid_hash"], ctr_n)
        seal = dict(seal, last_counter=ctr_n)
    verdict = VALID if seal else UNREGISTERED
    return TapCheck(verdict, uid_hex=uid_hex, uid_hash_hex=uid_hash_hex, counter=ctr_n, cmac_hex=cmac_hex, seal=seal, encrypted=encrypted)


ADOPT_WINDOW_S = 180


def adopt_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_adopt_token() -> tuple[str, str]:
    """(token handed to the browser once via the /t redirect, sha256 hex stored on the tap row)."""
    token = secrets.token_urlsafe(16)
    return token, adopt_token_hash(token)


# The resume token of a signed scan (GET /api/verify/{eventId}?token=) has the same shape: only its sha256 is stored.
new_resume_token = new_adopt_token
resume_token_hash = adopt_token_hash


def token_matches(token: str | None, stored_hash: str | None) -> bool:
    """Constant-time check of a one-time token against its stored sha256 (False for a missing token or hash)."""
    given = adopt_token_hash(token) if token else ""
    stored = stored_hash or ""
    return hmac.compare_digest(given.encode(), stored.encode()) and bool(stored) and bool(given)


def adopt_tap(conn, tap_id: int, token: str | None, now_ts: int) -> TapCheck:
    """
    A sticker tap that landed on /t (background NFC read on the phone) already passed CMAC + counter and advanced the
    seal. A scan session started right afterwards may adopt it instead of asking for a second tap — but only with the
    unguessable one-time token /t put into the redirect (`k`), once (adopted_at is set in the caller's transaction),
    within ADOPT_WINDOW_S, and only for a VALID /t tap. A wrong or missing token is indistinguishable from an unknown
    tap (INVALID).
    """
    tap = get_tap(conn, tap_id)
    stored = (tap or {}).get("adopt_hash") or ""
    given = adopt_token_hash(token) if token else ""
    # always run the comparison (constant time), even for unknown taps
    token_ok = hmac.compare_digest(given.encode(), stored.encode()) and bool(stored) and bool(given)
    if not tap or tap["source"] != "t" or not token_ok:
        return TapCheck(INVALID, error="tap not found")
    if tap["verdict"] != VALID or not tap["uid_hex"] or tap["ctr"] is None:
        return TapCheck(INVALID, error="tap not adoptable")
    ctr, uid_hex = int(tap["ctr"]), tap["uid_hex"]
    if tap["adopted_at"] is not None:
        return TapCheck(REPLAY, uid_hex=uid_hex, counter=ctr, cmac_hex=tap["cmac"], error="tap already used")
    if now_ts - int(tap["ts"]) > ADOPT_WINDOW_S:
        return TapCheck(REPLAY, uid_hex=uid_hex, counter=ctr, cmac_hex=tap["cmac"], error="tap too old")
    if not mark_tap_adopted(conn, tap_id, now_ts):
        return TapCheck(REPLAY, uid_hex=uid_hex, counter=ctr, cmac_hex=tap["cmac"], error="tap already used")
    seal = get_seal_by_uid(conn, uid_hex)
    uid_hash_hex = proof.uid_hash(bytes.fromhex(uid_hex)).hex()
    return TapCheck(VALID if seal else UNREGISTERED, uid_hex=uid_hex, uid_hash_hex=uid_hash_hex, counter=ctr,
                    cmac_hex=tap["cmac"], seal=seal)


def _int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def confirmed_attestation(payload: dict, attester: str | None, chain: dict | None) -> dict:
    """
    Who attested a confirmed scan, with which tier/role/site. `chain` holds the values the program recorded (record_scan
    args of the verified tx, or the decoded ScanProof) and always wins. Without it the claim made at /api/verify is
    only kept when the verified signer is the claimed attester; otherwise the scan counts as uncertified (tier 0).
    """
    claimed = payload.get("attester") or {}
    claim = {"attester": claimed.get("pubkey"), "tier": _int(claimed.get("tier")), "role": _int(claimed.get("role")),
             "siteId": _int(payload.get("siteId"))}
    if chain:
        got = {"attester": attester, "tier": _int(chain.get("tier")), "role": _int(chain.get("role")),
               "siteId": _int(chain.get("siteId"))}
        source = chain.get("source") or "chain"
        mismatch = [k for k in ("attester", "tier", "role") if claim[k] is not None and claim[k] != got[k]]
        if claim["siteId"] is not None and claim["siteId"] != (got["siteId"] or 0):
            mismatch.append("siteId")
        mismatch += [m for m in (chain.get("mismatch") or []) if m not in mismatch]
    elif attester and attester == claim["attester"]:
        got, source, mismatch = {**claim, "attester": attester}, "claimed", []
    else:
        got = {"attester": attester, "tier": 0, "role": None, "siteId": None}
        source, mismatch = "unverified", (["attester"] if claim["attester"] else [])
    return {**got, "source": source, "mismatch": mismatch}


def apply_confirmed_scan(conn, event: dict, attester: str | None, ts: int, chain: dict | None = None) -> None:
    """
    Shared state a SCAN may change, applied once — when the event turns confirmed (POST /api/events with a verified
    record_scan tx, or the reconcile job finding the ScanProof PDA). `attester` is the verified signer, never the
    pubkey the client claimed at /api/verify; `chain` carries the tier/role/siteId the program recorded (record_scan
    args or the decoded ScanProof — the reconcile job should pass its decoded account).
      * payload.confirmed ← verified attester, tier, role, site and the differences to the claim; payload.tier/role ←
        the verified values (what the timeline and the certified count read); actor_label ← the verified signer's label;
      * passport grade ← record_scan's rule (set_passport_grade / proof.passport_after_scan): VOID is sticky (void
        passport or a scan graded VOID), C is sticky once any scan graded C, otherwise A/B/D follow the newest confirmed
        scan. An older scan confirmed late (lost or retried confirm POST, a failed scan recovered by reconcile) still
        makes the passport C or VOID, but its fill grade never overwrites the one of a newer confirmed scan;
      * the Tier-0 /t sighting of the same physical tap (same seal and counter) is dropped, so it is not counted twice;
      * attester stats: scans (+certified for a verified tier ≥ 3); agreement with the previous confirmed scan by
        someone else.
    """
    payload = json.loads(event.get("payload_json") or "{}")
    if "indicators" not in payload:
        return                                     # Tier-0 sightings carry no grade and no attester
    serial = event["serial"]
    att = confirmed_attestation(payload, attester, chain)
    payload["confirmed"] = att
    payload["tier"] = att["tier"] if att["tier"] is not None else 0
    if att["role"] is not None:
        payload["role"] = att["role"]
    else:
        payload.pop("role", None)
    update_event_payload(conn, event["id"], payload)
    conn.execute("UPDATE events SET actor_label=(SELECT label FROM attesters WHERE pubkey=?) WHERE id=?", (attester, event["id"]))
    grade = payload.get("grade")
    if grade is not None:
        set_passport_grade(conn, serial, int(grade), latest=not newer_confirmed_scan_exists(conn, event))
    if event.get("seal_uid_hash") and payload.get("counter") is not None:
        drop_superseded_sighting(conn, serial, event["seal_uid_hash"], int(payload["counter"]), event["id"])
    if not attester:
        return
    bump_attester(conn, attester, ts, scans=1, certified=1 if payload["tier"] >= 3 else 0)
    prev = previous_scan_before(conn, serial, event["id"])
    if prev and prev["actor_pubkey"] and prev["actor_pubkey"] != attester:
        pb = json.loads(prev["payload_json"] or "{}")
        pi, ci = pb.get("indicators") or {}, payload.get("indicators") or {}
        try:
            fill_close = abs(int(pb.get("fill", -100)) - int(payload.get("fill", 100))) <= 5
        except (TypeError, ValueError):
            fill_close = False
        agree = pi.get("heat") == ci.get("heat") and pi.get("humidity") == ci.get("humidity") and fill_close
        bump_attester(conn, prev["actor_pubkey"], ts, compare=1, agree=1 if agree else 0)
