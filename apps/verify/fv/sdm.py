"""
NTAG 424 DNA SUN, plain mirror (AN12196) — thin wrapper around the vendored libsdm
(icedevml/sdm-backend, MIT) plus the simulator side (CMAC *generation*) and
AN10922 key diversification.

Tag URL:  https://<verifier-host>/t?uid=04A1B2C3D4E5F6&ctr=00000E&cmac=6F3A0B1C2D3E4F50
  uid  7 bytes hex · ctr 3 bytes hex big-endian in the URL · cmac 8 bytes hex
"""
from __future__ import annotations

from Crypto.Cipher import AES
from Crypto.Hash import CMAC

from libsdm.sdm import InvalidMessage, ParamMode, calculate_sdmmac, validate_plain_sun

FACTORY_KEY = bytes(16)
KEY_DIV_APP_ID = bytes.fromhex("D2760000850101")     # vectors.json constants.KEY_DIV_APP_ID_HEX
KEY_DIV_SYS_ID = "FlaconVault".encode("utf-8")        # vectors.json constants.KEY_DIV_SYS_ID


class TagParamError(ValueError):
    """Malformed uid/ctr/cmac parameters."""


def parse_uid(uid_hex: str) -> bytes:
    try:
        b = bytes.fromhex(uid_hex.strip().removeprefix("0x"))
    except (ValueError, AttributeError) as exc:
        raise TagParamError("uid: not hex") from exc
    if len(b) != 7:
        raise TagParamError(f"uid: expected 7 bytes, got {len(b)}")
    return b


def parse_ctr(ctr: str | int) -> int:
    """ctr from the URL (3 byte hex, big-endian) or already an int."""
    if isinstance(ctr, bool):
        raise TagParamError("ctr: bad type")
    if isinstance(ctr, int):
        n = ctr
    else:
        s = ctr.strip().removeprefix("0x")
        if len(s) != 6:
            raise TagParamError("ctr: expected 3 bytes hex")
        try:
            n = int(s, 16)
        except ValueError as exc:
            raise TagParamError("ctr: not hex") from exc
    if not 0 <= n <= 0xFFFFFF:
        raise TagParamError("ctr: out of 24-bit range")
    return n


def parse_cmac(cmac_hex: str) -> bytes:
    try:
        b = bytes.fromhex(cmac_hex.strip().removeprefix("0x"))
    except (ValueError, AttributeError) as exc:
        raise TagParamError("cmac: not hex") from exc
    if len(b) != 8:
        raise TagParamError(f"cmac: expected 8 bytes, got {len(b)}")
    return b


def ctr_hex(ctr: int) -> str:
    return ctr.to_bytes(3, "big").hex().upper()


def sdm_cmac(uid: bytes, ctr: int, key: bytes) -> bytes:
    """
    SDMMAC as the tag computes it for the plain mirror: CMAC over UID ‖ SDMReadCtr (LSB first).
    Mirrors what libsdm.validate_plain_sun reconstructs — used by the simulator to *generate* taps.
    """
    ctr_lsb_first = ctr.to_bytes(3, "big")[::-1]
    return calculate_sdmmac(ParamMode.SEPARATED, key, uid + ctr_lsb_first)


def validate_tap(uid: bytes, ctr: int, cmac: bytes, key: bytes) -> bool:
    """True if the CMAC is genuine for this uid/counter under `key` (libsdm, AN12196)."""
    try:
        validate_plain_sun(uid, ctr.to_bytes(3, "big"), cmac, key)
        return True
    except InvalidMessage:
        return False


def tag_url(host: str, uid: bytes, ctr: int, cmac: bytes) -> str:
    return f"{host.rstrip('/')}/t?uid={uid.hex().upper()}&ctr={ctr_hex(ctr)}&cmac={cmac.hex().upper()}"


# ---------- keys ----------

def diversify(master: bytes, uid: bytes, aid: bytes, sysid: bytes) -> bytes:
    """
    AN10922 AES-128 key diversification: K_div = AES-CMAC(K_master, 0x01 ‖ UID ‖ AID ‖ SysID).
    Standard CMAC padding (0x80…, subkey K2) applies when the input is shorter than 32 bytes.
    Published vector: K=00112233445566778899AABBCCDDEEFF, UID 04782E21801D80, AID 3042F5,
    SysID "NXP Abu" → A8DD63A3B89D54B37CA802473FDA9175.
    """
    if len(master) != 16:
        raise ValueError("master key must be 16 bytes (AES-128)")
    d = b"\x01" + uid + aid + sysid
    if len(d) > 32:
        raise ValueError("diversification input must be at most 31 bytes after the 0x01 constant")
    c = CMAC.new(master, ciphermod=AES)
    c.update(d)
    return c.digest()


def key_for_uid(mode: str, master: bytes, uid: bytes) -> bytes:
    if mode == "factory":
        return FACTORY_KEY
    if mode == "diversified":
        return diversify(master, uid, KEY_DIV_APP_ID, KEY_DIV_SYS_ID)
    raise ValueError(f"unknown key mode {mode!r}")
