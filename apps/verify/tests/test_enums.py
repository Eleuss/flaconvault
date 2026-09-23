"""5. fv/enums.json (local copy) == docs/enums.json, and the constants are wired correctly."""
import json

from fv import enums


def test_local_copy_equals_docs(enums_doc):
    local = json.loads(enums.ENUMS_PATH.read_text(encoding="utf-8"))
    assert local == enums_doc, "run: uv run python scripts/sync_enums.py"


def test_constants(enums_doc):
    assert enums.Tamper.UNKNOWN == 3 and enums.Indicator.MISSING == 3 and enums.Grade.VOID == 4
    assert enums.EventType.SEAL_DEAD == 9 and enums.SealKind.NECK == 1 and enums.Tier.BIRTH == 4 and enums.Role.PARTNER == 4
    assert enums.Tamper.as_dict() == enums_doc["tamper"] and enums.EventType.as_dict() == enums_doc["event"]
    assert list(enums.VERDICTS) == enums_doc["verdict"]
    assert enums.Grade.name(2) == "C" and enums.SEAL_KIND_NAMES == {0: "BOX", 1: "NECK", 2: "LOOP"}
