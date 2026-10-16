"""Arweave operations: minimal sidecar environment (S14), visible failures and the balance probe (S15), backfill from the
reconcile job (S8). The sidecar is mocked at the subprocess boundary; no network."""
import io
import json
import subprocess
from pathlib import Path

import pytest

import fv.arweave as aw
from tests.conftest import ADMIN
from tests.test_reconcile import _account_for, _scan

SERIAL = "SN-2026-000001"
KEYPAIR = json.dumps(list(range(64)))          # obviously fake test keypair


@pytest.fixture(autouse=True)
def _fresh_status():
    aw.reset_status()
    yield
    aw.reset_status()


def _ok(id_="Q" * 43):
    return json.dumps({"id": id_, "url": f"https://gateway.irys.xyz/{id_}", "ar": f"ar://{id_}", "bytes": 3}) + "\n"


def test_sidecar_gets_no_secrets(settings, monkeypatch, tmp_path):
    for k, v in {"FV_MASTER_KEY": "aa" * 16, "FV_SERVER_ED25519_SEED": "bb" * 32, "FV_ADMIN_TOKEN": "admin-secret",
                 "FV_IRYS_KEY_JSON": KEYPAIR, "AWS_SECRET_ACCESS_KEY": "nope", "HTTPS_PROXY": "http://proxy.test:3128"}.items():
        monkeypatch.setenv(k, v)
    settings.arweave, settings.irys_key_json, settings.node_bin = True, KEYPAIR, "/usr/bin/true"
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(cmd=cmd, **kw)
        return subprocess.CompletedProcess(cmd, 0, stdout=_ok(), stderr="")
    monkeypatch.setattr(subprocess, "run", fake_run)
    f = tmp_path / "x.bin"
    f.write_bytes(b"abc")
    assert aw.upload_file(f, "image/jpeg", settings)["id"] == "Q" * 43
    env = seen["env"]
    assert not any(k.startswith("FV_") for k in env) and "AWS_SECRET_ACCESS_KEY" not in env
    assert all(secret not in json.dumps(env) for secret in ("aa" * 16, "bb" * 32, "admin-secret", KEYPAIR))
    assert env["NODE_NO_WARNINGS"] == "1" and env["PATH"] and env["HTTPS_PROXY"] == "http://proxy.test:3128"
    # the inline key reaches the sidecar only as a 0600 file next to the database
    key_file = Path(seen["cmd"][seen["cmd"].index("--key") + 1])
    assert key_file == settings.db_path.parent / "irys-key.json" and key_file.read_text() == KEYPAIR
    assert key_file.stat().st_mode & 0o777 == 0o600


def test_failures_are_recorded_and_classified(settings, monkeypatch, tmp_path):
    settings.arweave, settings.irys_key, settings.node_bin = True, str(tmp_path / "key.json"), "/usr/bin/true"
    f = tmp_path / "x.bin"
    f.write_bytes(b"abc")
    msg = "irys-sidecar: insufficient Irys balance: have 0 SOL, need 0.0001 SOL for 3 bytes — run: node fund.mjs"
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, stdout="", stderr=msg))
    assert aw.upload_file(f, "image/jpeg", settings) is None
    st = aw.status(settings)
    assert st["failures"] == 1 and st["consecutiveFailures"] == 1 and st["lastErrorCode"] == "insufficient_balance"
    assert "insufficient Irys balance" in st["lastError"]
    h = aw.health(settings)
    assert h["enabled"] is True and h["ok"] is False and h["lastErrorCode"] == "insufficient_balance"
    assert "lastError" not in h                                     # raw sidecar output stays out of the public view
    assert aw.in_backoff()
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, stdout=_ok(), stderr=""))
    assert aw.upload_file(f, "image/jpeg", settings)
    assert aw.status(settings)["consecutiveFailures"] == 0 and aw.status(settings)["uploads"] == 1 and not aw.in_backoff()


def test_backoff_grows_and_expires(settings):
    aw._record_error(aw.ArweaveError("boom"))
    last = aw.status(settings)["lastErrorAt"]
    assert aw.in_backoff(last + 30) and not aw.in_backoff(last + 61)
    aw._record_error(aw.ArweaveError("boom"))
    assert aw.in_backoff(last + 61) and not aw.in_backoff(last + 200)
    for _ in range(20):
        aw._record_error(aw.ArweaveError("boom"))
    assert not aw.in_backoff(aw.status(settings)["lastErrorAt"] + aw.BACKOFF_MAX_S + 1)


def test_config_problem_names_the_silent_misconfigurations(settings, tmp_path):
    assert aw.config_problem(settings) is None                       # archiving off: nothing to report
    settings.arweave = True
    assert "neither FV_IRYS_KEY nor FV_IRYS_KEY_JSON" in aw.config_problem(settings) and aw.enabled(settings) is False
    assert aw.health(settings)["ok"] is False
    settings.irys_key_json = "4bQ9...base58-secret-not-json"
    p = aw.config_problem(settings)
    assert "not a JSON array of 64 numbers" in p and "base58" not in p
    with pytest.raises(aw.ArweaveError):
        aw.key_path(settings)
    settings.irys_key_json, settings.irys_key = "", str(tmp_path / "missing.json")
    assert "Irys key file not found" in aw.config_problem(settings)


def test_bad_inline_key_never_reaches_the_sidecar(settings, monkeypatch, tmp_path):
    settings.arweave, settings.irys_key_json = True, "[1, 2, 3]"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("sidecar must not run"))
    f = tmp_path / "x.bin"
    f.write_bytes(b"abc")
    assert aw.upload_file(f, "image/jpeg", settings) is None
    assert aw.status(settings)["lastErrorCode"] == "key_invalid"


def test_probe_reads_the_balance(settings, monkeypatch):
    settings.arweave, settings.irys_key, settings.node_bin = True, "default", "/usr/bin/true"
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        out = {"address": "7oSBfake", "balanceSol": "0", "priceSol": "0.00002", "status": "would fund 0.01 SOL"}
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(out) + "\n", stderr="")
    monkeypatch.setattr(subprocess, "run", fake_run)
    res = aw.probe(settings)
    assert seen["cmd"][1].endswith("fund.mjs") and "--dry-run" in seen["cmd"]            # read-only, never funds
    assert res["balanceOk"] is False and res["balanceSol"] == "0"
    h = aw.health(settings)
    assert h["balanceOk"] is False and h["balanceSol"] == "0" and h["ok"] is False
    settings.arweave = False
    assert aw.probe(settings) is None


class Sidecar:
    def __init__(self, fail_first: int = 0):
        self.calls, self.fail_first = [], fail_first

    def __call__(self, args, settings):
        self.calls.append(args)
        if len(self.calls) <= self.fail_first:
            raise aw.ArweaveError("irys-sidecar: insufficient Irys balance", "insufficient_balance")
        id_ = f"BF{len(self.calls):02d}" + "x" * 39
        return {"id": id_, "url": f"https://gateway.irys.xyz/{id_}", "ar": f"ar://{id_}", "bytes": 1}


def test_reconcile_backfills_media_and_bundles(chain_client, settings, monkeypatch):
    """Archiving failed while the scan was confirmed (sidecar down / unfunded): the reconcile job catches up later."""
    c, rpc = chain_client, chain_client.rpc
    from fv.chain import pda_scan, pda_seal
    from tests.conftest import PROGRAM_ID
    frames = [b"\xff\xd8frame-1" * 40, b"\xff\xd8frame-2" * 40]
    files = [("files", (f"f{i}.jpg", io.BytesIO(b), "image/jpeg")) for i, b in enumerate(frames)]
    m = c.post("/api/media", files=files).json()                    # archiving off at upload time → ar null
    assert m["ar"] is None
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"], mediaHash=m["sha256"])
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, v["counter"]))] = _account_for(v)

    settings.arweave, settings.irys_key = True, "default"           # switched on (or fixed) later
    sidecar = Sidecar(fail_first=1)
    monkeypatch.setattr(aw, "_run_sidecar", sidecar)
    s = c.post("/api/reconcile", headers=ADMIN).json()               # confirms; the inline archive fails
    assert s["confirmed"] == 1 and s["arweave"]["skipped"] == "backoff"
    e = next(x for x in c.get(f"/api/passport/{SERIAL}").json()["events"] if x["id"] == v["eventId"])
    assert e["arBundle"] is None
    assert c.post("/api/reconcile", headers=ADMIN).json()["arweave"]["skipped"] == "backoff"   # no hammering
    aw.reset_status()                                                # backoff over
    s = c.post("/api/reconcile", headers=ADMIN).json()
    assert s["arweave"]["archived"] >= 1 and s["arweave"]["failed"] == 0
    e = next(x for x in c.get(f"/api/passport/{SERIAL}").json()["events"] if x["id"] == v["eventId"])
    assert e["arBundle"].startswith("ar://BF") and e["arMedia"].startswith("https://gateway.irys.xyz/BF")
    with c.app.state.db.connect() as conn:
        row = conn.execute("SELECT ar, url FROM media WHERE sha256=?", (m["sha256"][2:],)).fetchone()
    assert row["ar"].startswith("ar://BF")
    tags = [dict(a.split("=", 1) for i, a in enumerate(args) if i and args[i - 1] == "--tag") for args in sidecar.calls]
    assert any(t.get("App-Type") == "seal-frames" for t in tags) and any(t.get("App-Type") == "scanproof-bundle" for t in tags)
    # seeded demo scans are never archived
    assert all(t.get("FV-Serial", SERIAL) == SERIAL for t in tags)
    n = len(sidecar.calls)
    c.post("/api/reconcile", headers=ADMIN)
    assert len(sidecar.calls) == n                                   # nothing left to archive
