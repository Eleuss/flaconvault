"""Briefing §16: binding wording; forbidden words never appear in any server-emitted UI line."""
import re

from fv import strings


def test_tap_messages():
    assert strings.tap_message("VALID", 14) == "Siegel echt · Tap 14"
    assert strings.tap_message("NO_RESPONSE") == "Siegel antwortet nicht"
    assert strings.HEAT_TRIGGERED.startswith("Hitze: über 40 °C erfasst")
    assert strings.HUMIDITY_TRIGGERED.startswith("Feuchte: über 60 % rF erfasst")


def test_no_forbidden_words():
    lines = [v for k, v in vars(strings).items() if isinstance(v, str) and k.isupper()]
    lines += [strings.tap_message(v, 1) for v in ("VALID", "INVALID", "REPLAY", "NONCE_INVALID", "UNREGISTERED", "NO_RESPONSE")]
    def has(bad: str, text: str) -> bool:   # whole words only ("Herkunft" is fine, "NFT" is not)
        return re.search(r"(?<!\w)" + re.escape(bad) + r"(?!\w)", text, re.IGNORECASE) is not None

    for line in lines:
        for bad in strings.FORBIDDEN_WORDS:
            assert not has(bad, line), (bad, line)
    # and not in the seed data either
    from tests.conftest import DOCS
    seed = (DOCS / "seed" / "passports.json").read_text(encoding="utf-8")
    for bad in strings.FORBIDDEN_WORDS:
        assert not has(bad, seed), bad
