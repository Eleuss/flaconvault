""".github/scripts/check-health.py: the health check of the docker smoke test and of a manual deploy (docs/deploy.md)."""
import importlib.util
import urllib.error
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / ".github" / "scripts" / "check-health.py"
OLD, NEW = "a" * 40, "b" * 40


@pytest.fixture()
def ch(monkeypatch):
    spec = importlib.util.spec_from_file_location("check_health", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)
    return mod


def _health(build, simulator=False):
    return {"ok": True, "pubkeyHex": "ab" * 32, "keyId": 2, "simulator": simulator, "build": build}


def _answers(ch, monkeypatch, seq):
    calls = []

    def fetch(url):
        calls.append(url)
        item = seq[min(len(calls), len(seq)) - 1]
        if isinstance(item, Exception):
            raise item
        return item
    monkeypatch.setattr(ch, "fetch", fetch)
    return calls


def test_waits_for_the_new_build_after_a_deploy(ch, monkeypatch):
    calls = _answers(ch, monkeypatch, [urllib.error.URLError("refused"), _health(OLD), _health(OLD), _health(NEW)])
    assert ch.main(["https://verify.test", "--build", NEW, "--simulator", "false", "--wait-for-build", "--timeout", "60"]) == 0
    assert len(calls) == 4 and calls[0] == "https://verify.test/health"


def test_without_waiting_the_previous_build_fails(ch, monkeypatch):
    _answers(ch, monkeypatch, [_health(OLD), _health(NEW)])
    assert ch.main(["https://verify.test", "--build", NEW]) == 1


def test_waiting_gives_up_at_the_timeout(ch, monkeypatch):
    t = [0.0]
    monkeypatch.setattr(ch.time, "monotonic", lambda: t[0])
    monkeypatch.setattr(ch.time, "sleep", lambda s: t.__setitem__(0, t[0] + s))
    _answers(ch, monkeypatch, [_health(OLD)])
    assert ch.main(["https://verify.test", "--build", NEW, "--wait-for-build", "--timeout", "30"]) == 1
    assert t[0] >= 30


def test_other_checks_still_apply(ch, monkeypatch):
    _answers(ch, monkeypatch, [_health(NEW, simulator=True)])
    assert ch.main(["https://verify.test", "--build", NEW, "--simulator", "false", "--wait-for-build"]) == 1
    with pytest.raises(SystemExit):
        ch.main(["https://verify.test", "--wait-for-build"])                       # needs --build
