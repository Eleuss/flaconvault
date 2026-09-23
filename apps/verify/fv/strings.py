"""
UI strings (briefing §16, binding). The seal is a handling and provenance record, not a damage
record — never "beschädigt", "zerstört", "ruiniert", "NFT", "tokenisiert".
"""
from __future__ import annotations

from fv.enums import INVALID, NONCE_INVALID, NO_RESPONSE, REPLAY, UNREGISTERED, VALID

SEAL_VALID = "Siegel echt · Tap {n}"
SEAL_NO_RESPONSE = "Siegel antwortet nicht"
SEAL_REPLAY = "Tap bereits verwendet · Zähler {n}"
SEAL_INVALID = "Siegel nicht bestätigt"
SEAL_UNREGISTERED = "Chip echt · Siegel nicht registriert · Tap {n}"
SESSION_INVALID = "Sitzung abgelaufen · bitte neu starten"

HEAT_TRIGGERED = "Hitze: über 40 °C erfasst"
HEAT_TRIGGERED_LONG = ("Hitze: über 40 °C erfasst — die Temperatur, bei der Kosmetik und Pharma "
                       "beschleunigte Alterung prüfen")
HUMIDITY_TRIGGERED = "Feuchte: über 60 % rF erfasst"
HUMIDITY_TRIGGERED_LONG = "Feuchte: über 60 % rF erfasst — Grenze für Karton und Etikett"
UV_MISSING = "Licht: nicht bestückt (Rev D)"
NOT_OPENED = "Seit der Zertifizierung nicht geöffnet"
ORIGIN_DOCUMENTED = "Herkunft ab Quelle dokumentiert"
WITNESSED = "Bezeugt von {n} Wallets, davon {c} zertifiziert"
GRADE_CD_NOTE = "Der Indikator dokumentiert die Handhabung, nicht den Zustand des Inhalts."

FORBIDDEN_WORDS = ("beschädigt", "zerstört", "ruiniert", "NFT", "tokenisiert", "Duft verändert",
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
