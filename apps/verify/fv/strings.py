"""
UI strings (briefing §16, binding). The seal is a handling and provenance record, not a damage
record — never "damaged", "destroyed", "ruined", "NFT", "tokenized" (nor the German equivalents
"beschädigt", "zerstört", "ruiniert", "tokenisiert").
"""
from __future__ import annotations

from fv.enums import INVALID, NONCE_INVALID, NO_RESPONSE, REPLAY, UNREGISTERED, VALID

SEAL_VALID = "Seal genuine · tap {n}"
SEAL_NO_RESPONSE = "Seal not responding"
SEAL_REPLAY = "Repeated tap · counter {n}"
SEAL_INVALID = "Seal not confirmed"
SEAL_UNREGISTERED = "Chip genuine · seal not assigned to any passport · tap {n}"
SESSION_INVALID = "Session expired · please start again"

HEAT_TRIGGERED = "Heat: above 40 °C recorded"
HEAT_TRIGGERED_LONG = ("Heat: above 40 °C recorded — the temperature at which cosmetics and pharma "
                       "test for accelerated ageing")
HUMIDITY_TRIGGERED = "Humidity: above 60 % RH recorded"
HUMIDITY_TRIGGERED_LONG = "Humidity: above 60 % RH recorded — the limit for carton and label"
UV_MISSING = "Light: not fitted (Rev D)"
NOT_OPENED = "Seal responding · no break recorded"
ORIGIN_DOCUMENTED = "Registered by a partner"
WITNESSED = "Witnessed by {n} wallets, {c} of them certified"
GRADE_CD_NOTE = "The indicator documents the handling, not the condition of the contents."

# Guard list, not user-facing. English terms plus the German originals, because the seed data
# (docs/seed/passports.json) is checked against this list too.
FORBIDDEN_WORDS = ("damaged", "destroyed", "ruined", "NFT", "tokenized", "tokenised", "scent altered",
                   "tamper-proof through blockchain", "The blockchain proves authenticity",
                   "beschädigt", "zerstört", "ruiniert", "tokenisiert", "Duft verändert",
                   "fälschungssicher durch Blockchain", "Die Blockchain beweist Echtheit")


def tap_message(verdict: str, counter: int | None = None) -> str:
    n = counter if counter is not None else "–"
    if verdict == VALID:
        return SEAL_VALID.format(n=n)
    if verdict == REPLAY:
        return SEAL_REPLAY.format(n=n)
    if verdict == INVALID:
        return SEAL_INVALID
    if verdict == UNREGISTERED:
        return SEAL_UNREGISTERED.format(n=n)
    if verdict == NO_RESPONSE:
        return SEAL_NO_RESPONSE
    if verdict == NONCE_INVALID:
        return SESSION_INVALID
    return verdict
