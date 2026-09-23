"""
Shared tap check used by GET /t, POST /api/preview and POST /api/verify (briefing §5 steps 2–5).
"""
from __future__ import annotations

from dataclasses import dataclass

from fv import proof
from fv.config import Settings
from fv.db import advance_seal_counter, get_seal_by_uid, last_counter_unregistered
from fv.enums import INVALID, REPLAY, UNREGISTERED, VALID
from fv.sdm import TagParamError, key_for_uid, parse_cmac, parse_ctr, parse_uid, validate_tap


@dataclass
class TapCheck:
    verdict: str                     # VALID | INVALID | REPLAY | UNREGISTERED
    uid_hex: str | None = None       # uppercase, 14 chars
    uid_hash_hex: str | None = None  # lowercase, no 0x
    counter: int | None = None
    cmac_hex: str | None = None
    seal: dict | None = None         # seals row when registered
    error: str | None = None         # parse error text for INVALID

    @property
    def serial(self) -> str | None:
        return self.seal["serial"] if self.seal else None

    @property
    def seal_dead(self) -> bool:
        return bool(self.seal and self.seal["dead"])


def check_tap(conn, settings: Settings, uid: str | None, ctr: str | int | None, cmac: str | None, *, consume: bool) -> TapCheck:
    """CMAC → counter → seal lookup. With consume=True the seal's last_counter is advanced on a genuine, fresh tap."""
    if uid is None or ctr is None or cmac is None:
        return TapCheck(INVALID, uid_hex=(uid or None), error="missing uid/ctr/cmac")
    try:
        uid_b, ctr_n, cmac_b = parse_uid(uid), parse_ctr(ctr), parse_cmac(cmac)
    except TagParamError as exc:
        return TapCheck(INVALID, uid_hex=uid if isinstance(uid, str) and len(uid) <= 32 else None, error=str(exc))
    uid_hex, uid_hash_hex, cmac_hex = uid_b.hex().upper(), proof.uid_hash(uid_b).hex(), cmac_b.hex().upper()
    key = key_for_uid(settings.key_mode, settings.master_key, uid_b)
    if not validate_tap(uid_b, ctr_n, cmac_b, key):
        return TapCheck(INVALID, uid_hex=uid_hex, uid_hash_hex=uid_hash_hex, counter=ctr_n, cmac_hex=cmac_hex, error="bad cmac")
    seal = get_seal_by_uid(conn, uid_hex)
    last = int(seal["last_counter"]) if seal else last_counter_unregistered(conn, uid_hex)
    if ctr_n <= last:
        return TapCheck(REPLAY, uid_hex=uid_hex, uid_hash_hex=uid_hash_hex, counter=ctr_n, cmac_hex=cmac_hex, seal=seal)
    if seal and consume:
        advance_seal_counter(conn, seal["uid_hash"], ctr_n)
        seal = dict(seal, last_counter=ctr_n)
    verdict = VALID if seal else UNREGISTERED
    return TapCheck(verdict, uid_hex=uid_hex, uid_hash_hex=uid_hash_hex, counter=ctr_n, cmac_hex=cmac_hex, seal=seal)
