"""
Shared tap check used by GET /t, POST /api/preview and POST /api/verify (briefing §5 steps 2–5).
"""
from __future__ import annotations

import re

from dataclasses import dataclass

from fv import proof
from fv.config import Settings
from fv.db import advance_seal_counter, get_seal_by_uid, last_counter_unregistered
from fv.enums import INVALID, REPLAY, UNREGISTERED, VALID
from fv.sdm import TagParamError, decrypt_tap, key_for_uid, parse_cmac, parse_ctr, parse_hex_len, parse_uid, validate_tap


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
    m = _TW.match((uid or "").strip())
    if not m:
        return uid, ctr, cmac
    zero = lambda v: v is None or str(v).strip("0") == ""  # noqa: E731
    return m.group(1), (m.group(2) if zero(ctr) else ctr), (m.group(3) if zero(cmac) else cmac)


def check_tap(conn, settings: Settings, uid: str | None, ctr: str | int | None, cmac: str | None, *, consume: bool,
              picc_data: str | None = None, enc: str | None = None) -> TapCheck:
    """
    CMAC → counter → seal lookup. Plain mirror (uid, ctr, cmac) or encrypted SUN (picc_data, cmac[, enc]) as written by
    sdm-backend / NFC Developer App. With consume=True the seal's last_counter is advanced on a genuine, fresh tap.
    """
    encrypted = bool(picc_data)
    if encrypted:
        if cmac is None:
            return TapCheck(INVALID, error="missing cmac", encrypted=True)
        try:
            picc_b = bytes.fromhex(picc_data.strip().removeprefix("0x"))
            if len(picc_b) not in (16, 24):
                raise TagParamError("picc_data: expected 16 or 24 bytes")
            cmac_b = parse_cmac(cmac)
            enc_b = None
            if enc:
                enc_b = bytes.fromhex(enc.strip().removeprefix("0x"))
                if not enc_b or len(enc_b) % 16:
                    raise TagParamError("enc: expected a multiple of 16 bytes")
        except (TagParamError, ValueError) as exc:
            return TapCheck(INVALID, error=str(exc) if str(exc) else "picc_data/enc: not hex", encrypted=True)
        dec = decrypt_tap(settings.key_mode, settings.master_key, picc_b, cmac_b, enc_b, settings.sdm_derive)
        if dec is None:
            return TapCheck(INVALID, cmac_hex=cmac_b.hex().upper(), error="bad cmac", encrypted=True)
        uid_b, ctr_n = dec
    else:
        uid, ctr, cmac = split_tagwriter(uid, ctr, cmac)   # NXP TagWriter: uid=<UID>x<CTR>x<MAC>
        if uid is None or ctr is None or cmac is None:
            return TapCheck(INVALID, uid_hex=(uid or None), error="missing uid/ctr/cmac")
        try:
            uid_b, ctr_n, cmac_b = parse_uid(uid), parse_ctr(ctr), parse_cmac(cmac)
        except TagParamError as exc:
            return TapCheck(INVALID, uid_hex=uid if isinstance(uid, str) and len(uid) <= 32 else None, error=str(exc))
        key = key_for_uid(settings.key_mode, settings.master_key, uid_b, settings.sdm_derive)
        if not validate_tap(uid_b, ctr_n, cmac_b, key):
            return TapCheck(INVALID, uid_hex=uid_b.hex().upper(), uid_hash_hex=proof.uid_hash(uid_b).hex(), counter=ctr_n,
                            cmac_hex=cmac_b.hex().upper(), error="bad cmac")
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
