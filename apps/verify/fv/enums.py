"""
u8 enums shared with packages/proof (TS) and programs/flacon (Rust).

Loaded at import time from the local copy fv/enums.json, which is synced from
docs/enums.json by scripts/sync_enums.py. tests/test_enums.py asserts both copies
are identical, so the values here can never silently drift from the source of truth.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

ENUMS_PATH = Path(__file__).with_name("enums.json")
_RAW: dict = json.loads(ENUMS_PATH.read_text(encoding="utf-8"))


class _Enum(SimpleNamespace):
    """Attribute access (Tamper.UNKNOWN == 3) plus name lookup (Tamper.name(3) == 'UNKNOWN')."""

    def __init__(self, mapping: dict[str, int]):
        super().__init__(**mapping)
        self._by_value = {v: k for k, v in mapping.items()}
        self._mapping = dict(mapping)

    def name(self, value: int) -> str:
        return self._by_value[value]

    def values(self) -> set[int]:
        return set(self._by_value)

    def as_dict(self) -> dict[str, int]:
        return dict(self._mapping)


Tamper = _Enum(_RAW["tamper"])
Indicator = _Enum(_RAW["indicator"])
Tier = _Enum(_RAW["tier"])
Role = _Enum(_RAW["role"])
Grade = _Enum(_RAW["grade"])
SealKind = _Enum(_RAW["seal_kind"])
EventType = _Enum(_RAW["event"])

# Server verdicts (strings). Only VALID is ever signed.
VERDICTS: tuple[str, ...] = tuple(_RAW["verdict"])
VALID, INVALID, REPLAY, NONCE_INVALID, UNREGISTERED, NO_RESPONSE = VERDICTS
assert VALID == "VALID" and NO_RESPONSE == "NO_RESPONSE"

# LOOP (2) is reserved for the optional 213 TT upgrade (briefing §13); bundle schema names it.
SEAL_KIND_NAMES: dict[int, str] = {**{v: k for k, v in _RAW["seal_kind"].items()}, 2: "LOOP"}
