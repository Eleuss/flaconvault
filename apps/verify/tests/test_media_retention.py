"""Media retention in the reconcile job (M9): staged uploads of expired nonces and, after FV_MEDIA_RETENTION_S, kept blobs
that no pending, confirmed or still recoverable failed scan references, plus blob files without a media row."""
import io
import os
import time

import pytest

import fv.reconcile as rc
from fv.config import Settings, settings_from_env
from tests.conftest import TEST_SEED_HEX, post_media
from tests.test_reconcile import _scan

SERIAL = "SN-2026-000001"
DAY = 86400


def _kept_scan(c, payload: bytes) -> tuple[dict, str]:
    """A VALID tier-2 scan whose upload was promoted out of staging (media row + blob + preview)."""
    nonce = c.post("/api/session", json={}).json()["nonce"]
    files = [("files", (f"f{i}.jpg", io.BytesIO(payload + bytes([i])), "image/jpeg")) for i in range(2)]
    m = post_media(c, files=files, nonce=nonce).json()
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"], mediaHash=m["sha256"], nonce=nonce)
    sha = m["sha256"][2:]
    return v, sha


def _files(settings, sha: str) -> list[str]:
    return sorted(p.name for p in settings.media_dir.iterdir() if p.name.startswith(sha))


def _row(c, sha: str):
    with c.app.state.db.connect() as conn:
        return conn.execute("SELECT sha256 FROM media WHERE sha256=?", (sha,)).fetchone()


def _run(c, ts: int) -> dict:
    return rc.reconcile_once(c.app.state.db, c.app.state.settings, c.app.state.rpc, ts=ts)["media"]


def test_referenced_media_is_kept_and_unreferenced_media_expires(client, settings):
    c = client
    now = int(time.time())
    pending, sha_pending = _kept_scan(c, b"\xff\xd8pending" * 50)
    dropped, sha_dropped = _kept_scan(c, b"\xff\xd8dropped" * 50)
    assert _files(settings, sha_pending) == [f"{sha_pending}.bin", f"{sha_pending}.preview.jpg"]
    with c.app.state.db.connect() as conn:                           # the scan behind this blob is gone (e.g. purge-seed)
        conn.execute("DELETE FROM events WHERE id=?", (dropped["eventId"],))

    s = _run(c, now + 6 * DAY)                                         # younger than the 7-day default: nothing goes
    assert (s["rows"], s["files"]) == (0, 0) and _row(c, sha_dropped)
    s = _run(c, now + 8 * DAY)
    assert s["rows"] == 1 and s["bytes"] > 0
    assert _row(c, sha_dropped) is None and _files(settings, sha_dropped) == []
    assert _row(c, sha_pending) and len(_files(settings, sha_pending)) == 2      # a pending scan still references it


def test_failed_scans_keep_their_media_while_reconcile_may_recover_them(client, settings):
    c = client
    now = int(time.time())
    v, sha = _kept_scan(c, b"\xff\xd8failed" * 50)
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE events SET status='failed' WHERE id=?", (v["eventId"],))
        conn.execute("UPDATE media SET created_at=created_at - ? WHERE sha256=?", (8 * DAY, sha))   # older than the TTL
    # within FAILED_RECHECK_S of the scan the failed event is still a reference (a ScanProof may still appear) ...
    assert _run(c, now + 3600)["rows"] == 0 and _row(c, sha) and len(_files(settings, sha)) == 2
    # ... after it, the media of a failed scan expires like unreferenced media
    assert _run(c, now + rc.FAILED_RECHECK_S + 3600)["rows"] == 1
    assert _row(c, sha) is None and _files(settings, sha) == []


def test_confirmed_scans_keep_their_media_for_good(client, settings):
    c = client
    v, sha = _kept_scan(c, b"\xff\xd8confirmed" * 50)
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE events SET status='confirmed' WHERE id=?", (v["eventId"],))
    assert _run(c, int(time.time()) + 365 * DAY)["rows"] == 0 and len(_files(settings, sha)) == 2


def test_orphan_files_expire_and_nothing_else_is_touched(client, settings):
    c = client
    media = settings.media_dir
    old = time.time() - 8 * DAY
    orphan, young = media / (("ab" * 32) + ".bin"), media / (("cd" * 32) + ".bin")
    orphan_preview = media / (("ab" * 32) + ".preview.webp")
    others = [media / "notes.txt", media / (("ef" * 32) + ".bin.bak"), media / "irys-key.json", media / ("EF" * 32 + ".bin")]
    for f in (orphan, young, orphan_preview, *others):
        f.write_bytes(b"x" * 10)
    for f in (orphan, orphan_preview, *others):
        os.utime(f, (old, old))
    s = _run(c, int(time.time()))
    assert s["files"] == 2 and not orphan.exists() and not orphan_preview.exists()
    assert young.exists() and all(f.exists() for f in others)


def test_expired_staging_is_purged_by_the_cycle(client, settings):
    c = client
    nonce = c.post("/api/session", json={}).json()["nonce"]
    post_media(c, files={"file": ("f.jpg", io.BytesIO(b"\xff\xd8staged" * 10), "image/jpeg")}, nonce=nonce)
    staging = settings.media_dir / "staging" / nonce[2:]
    assert staging.is_dir()
    assert _run(c, int(time.time()))["staging"] == 0 and staging.is_dir()       # the nonce is still valid
    assert _run(c, int(time.time()) + settings.nonce_ttl_s + 1)["staging"] == 1 and not staging.exists()


def test_retention_zero_keeps_kept_media_forever(client, settings):
    c = client
    settings.media_retention_s = 0
    v, sha = _kept_scan(c, b"\xff\xd8forever" * 50)
    with c.app.state.db.connect() as conn:
        conn.execute("DELETE FROM events WHERE id=?", (v["eventId"],))
    s = _run(c, int(time.time()) + 3650 * DAY)
    assert (s["rows"], s["files"]) == (0, 0) and _row(c, sha) and len(_files(settings, sha)) == 2


def test_retention_runs_in_the_reconcile_cycle_with_a_program_id(chain_client, settings):
    c = chain_client
    v, sha = _kept_scan(c, b"\xff\xd8chain" * 50)
    with c.app.state.db.connect() as conn:
        conn.execute("DELETE FROM events WHERE id=?", (v["eventId"],))
    s = rc.reconcile_once(c.app.state.db, settings, c.rpc, ts=int(time.time()) + 8 * DAY)
    assert s["enabled"] is True and s["media"]["rows"] == 1 and _row(c, sha) is None


def test_retention_setting(monkeypatch):
    monkeypatch.setenv("FV_SERVER_ED25519_SEED", TEST_SEED_HEX)
    monkeypatch.delenv("FV_MEDIA_RETENTION_S", raising=False)
    assert settings_from_env().media_retention_s == 7 * DAY
    monkeypatch.setenv("FV_MEDIA_RETENTION_S", "0")
    assert settings_from_env().media_retention_s == 0
    with pytest.raises(ValueError, match="FV_MEDIA_RETENTION_S"):
        Settings(server_seed_hex=TEST_SEED_HEX, media_retention_s=-1)
