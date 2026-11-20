"""/api/media cannot fill the volume: uploads are staged per session nonce and kept only when a VALID /api/verify consumes
that nonce with their mediaHash; staged junk is purged once its nonce has expired; free-space floor, per-client and
global byte budgets refuse uploads before the body is read; files are streamed to disk in chunks."""
import io

import pytest
from fastapi.testclient import TestClient

import fv.media_store as ms
import fv.routes_api as ra
from fv import proof
from tests.conftest import post_media

SERIAL = "SN-2026-000001"
SEEDED_UID = "04A1B2C3D4E5F6"


def _jpeg(tag: bytes, n: int = 50) -> tuple:
    return ("files", (f"{tag.decode()}.jpg", io.BytesIO(b"\xff\xd8" + tag * n), "image/jpeg"))


def _nonce(c) -> str:
    return c.post("/api/session", json={}).json()["nonce"]


def _verify(c, nonce: str, media_hash: str | None, tier: int = 2, uid: str = SEEDED_UID):
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": tier,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92,
            "mediaHash": media_hash, "platform": "SIMULATOR"}
    return c.post("/api/verify", json=body).json()


def _blobs(settings) -> set[str]:
    return {p.name for p in settings.media_dir.iterdir() if p.is_file()} if settings.media_dir.exists() else set()


def _staging(settings) -> set[str]:
    root = settings.media_dir / "staging"
    return {p.name for p in root.iterdir()} if root.exists() else set()


@pytest.fixture(autouse=True)
def _purge_every_request(monkeypatch):
    monkeypatch.setattr(ms, "PURGE_EVERY_S", 0.0)


def test_only_the_upload_a_valid_scan_commits_to_is_kept(client, settings):
    nonce = _nonce(client)
    keep = post_media(client, files=[_jpeg(b"keep-1"), _jpeg(b"keep-2")], nonce=nonce).json()
    junk = post_media(client, files=[_jpeg(b"junk")], nonce=nonce).json()
    assert _blobs(settings) == set() and _staging(settings) == {nonce[2:]}            # staged, nothing permanent yet
    with client.app.state.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM media").fetchone()[0] == 0
    v = _verify(client, nonce, keep["sha256"])
    assert v["verdict"] == "VALID"
    sha = keep["sha256"][2:]
    assert _blobs(settings) == {sha + ".bin", sha + ".preview.jpg"}                    # the junk upload is gone
    assert (settings.media_dir / (sha + ".preview.jpg")).read_bytes() == b"\xff\xd8" + b"keep-1" * 50
    assert _staging(settings) == set()
    with client.app.state.db.connect() as conn:
        rows = conn.execute("SELECT sha256, bytes, files, content_type FROM media").fetchall()
    assert [tuple(r) for r in rows] == [(sha, keep["bytes"], 2, "image/jpeg")]
    assert junk["sha256"][2:] not in {r[0] for r in rows}


def test_a_scan_names_only_photos_its_own_session_uploaded(client, settings):
    """A hash is public (bundles, FVSCAN2): a tier ≥ 2 scan whose mediaHash was not uploaded under its own nonce is refused
    with 422 media_not_uploaded before the tap is used, whether those bytes were uploaded under another session's nonce,
    kept by an earlier scan, or never uploaded. It can never take over (and get archived) another scan's photos."""
    from fv.db import get_nonce

    def media_rows():
        with client.app.state.db.connect() as conn:
            return [tuple(r) for r in conn.execute("SELECT * FROM media ORDER BY sha256").fetchall()]

    first = _nonce(client)
    kept = post_media(client, files=[_jpeg(b"someone-elses")], nonce=first).json()
    assert _verify(client, first, kept["sha256"])["verdict"] == "VALID"            # kept by the first scan
    elsewhere = post_media(client, files=[_jpeg(b"other-session")], nonce=_nonce(client)).json()   # staged elsewhere
    before = media_rows()
    own = _nonce(client)
    for named in (kept["sha256"], elsewhere["sha256"], "0x" + "ab" * 32):
        tap = client.post("/api/dev/tap", json={"uid": SEEDED_UID}).json()
        r = client.post("/api/verify", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": own,
                                             "role": 1, "tier": 2, "indicators": {"heat": 0, "humidity": 0, "uv": 3},
                                             "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "mediaHash": named,
                                             "platform": "SIMULATOR"})
        assert r.status_code == 422 and r.json()["detail"] == "media_not_uploaded", named
        # nothing consumed: the tap is still fresh and the session nonce unused
        assert client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"],
                                                 "cmac": tap["cmac"]}).json()["verdict"] == "VALID"
    with client.app.state.db.connect() as conn:
        assert get_nonce(conn, own[2:])["used_at"] is None
    assert media_rows() == before and elsewhere["sha256"][2:] + ".bin" not in _blobs(settings)
    # an unusable nonce is still NONCE_INVALID (checked first), whatever the photos
    assert _verify(client, first, kept["sha256"])["verdict"] == "NONCE_INVALID"
    # the same bytes uploaded by this session: signed; the kept row is shared
    assert post_media(client, files=[_jpeg(b"someone-elses")], nonce=own).json()["sha256"] == kept["sha256"]
    v = _verify(client, own, kept["sha256"])
    assert v["verdict"] == "VALID" and v["bundle"]["media"][0]["sha256"] == kept["sha256"] and media_rows() == before


def test_promote_takes_over_nothing_it_did_not_stage(client, settings):
    """media_store.promote raises NotStaged — and touches nothing — when the nonce staged no upload with that hash, also
    when an earlier scan kept those bytes (no fallback to the kept row): /api/verify then answers 422 and rolls back."""
    nonce = _nonce(client)
    kept = post_media(client, files=[_jpeg(b"kept-bytes")], nonce=nonce).json()
    assert _verify(client, nonce, kept["sha256"])["verdict"] == "VALID"
    other = _nonce(client)
    staged = post_media(client, files=[_jpeg(b"staged-bytes")], nonce=other).json()
    assert ms.is_staged(settings, other[2:], staged["sha256"][2:]) and not ms.is_staged(settings, other[2:], kept["sha256"][2:])
    assert not ms.is_staged(settings, "zz", staged["sha256"][2:]) and not ms.is_staged(settings, other[2:], "../x")
    with client.app.state.db.connect() as conn, pytest.raises(ms.NotStaged):
        ms.promote(conn, settings, other[2:], kept["sha256"][2:], 1)
    assert ms.is_staged(settings, other[2:], staged["sha256"][2:])                  # the session's own upload is untouched


def test_a_scan_whose_upload_vanished_meanwhile_is_rolled_back(client, settings, monkeypatch):
    """The upload is checked before the tap is used and again when it is promoted: gone in between (its nonce expired and
    the staging was purged meanwhile) → 422 media_not_uploaded, and the transaction is rolled back (tap and nonce unused)."""
    nonce = _nonce(client)
    m = post_media(client, files=[_jpeg(b"vanishing")], nonce=nonce).json()
    real = ms.promote

    def purged_first(conn, settings_, nonce_hex, sha_hex, ts):
        ms.discard(settings_, nonce_hex)
        return real(conn, settings_, nonce_hex, sha_hex, ts)
    monkeypatch.setattr(ms, "promote", purged_first)
    tap = client.post("/api/dev/tap", json={"uid": SEEDED_UID}).json()
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92,
            "mediaHash": m["sha256"], "platform": "SIMULATOR"}
    with client.app.state.db.connect() as conn:
        events_before = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    r = client.post("/api/verify", json=body)
    assert r.status_code == 422 and r.json()["detail"] == "media_not_uploaded"
    with client.app.state.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == events_before
        assert conn.execute("SELECT used_at FROM nonces WHERE nonce_hex=?", (nonce[2:],)).fetchone()[0] is None
    assert client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()["verdict"] == "VALID"


def test_a_scan_without_a_valid_verdict_keeps_nothing(client, settings):
    nonce = _nonce(client)
    m = post_media(client, files=[_jpeg(b"replayed")], nonce=nonce).json()
    tap = client.post("/api/dev/tap", json={"uid": SEEDED_UID}).json()
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92,
            "mediaHash": m["sha256"], "platform": "SIMULATOR"}
    assert client.post("/api/verify", json=body).json()["verdict"] == "VALID"
    # the same tap again under a new nonce (REPLAY): its upload is not promoted, the nonce stays usable
    n2 = _nonce(client)
    m2 = post_media(client, files=[_jpeg(b"second")], nonce=n2).json()
    assert client.post("/api/verify", json={**body, "nonce": n2, "mediaHash": m2["sha256"]}).json()["verdict"] == "REPLAY"
    assert m2["sha256"][2:] + ".bin" not in _blobs(settings) and n2[2:] in _staging(settings)
    # a tier-1 scan (no media) keeps nothing that was staged under its nonce
    n3 = _nonce(client)
    post_media(client, files=[_jpeg(b"tier-one")], nonce=n3)
    assert _verify(client, n3, None, tier=1)["verdict"] == "VALID"
    assert n3[2:] not in _staging(settings)


def test_an_unreferenced_upload_is_gone_after_the_nonce_ttl(client, settings, monkeypatch):
    nonce = _nonce(client)
    m = post_media(client, files=[_jpeg(b"never-used")], nonce=nonce).json()
    staged = settings.media_dir / "staging" / nonce[2:] / (m["sha256"][2:] + ".bin")
    assert staged.is_file()
    _nonce(client)                                           # a purge while the nonce is still valid keeps it
    assert staged.is_file()
    real = ra.now
    monkeypatch.setattr(ra, "now", lambda: real() + settings.nonce_ttl_s + 1)
    _nonce(client)                                           # the next session request purges expired staging
    assert not staged.exists() and nonce[2:] not in _staging(settings)
    assert _blobs(settings) == set()


def test_staging_of_consumed_or_unknown_nonces_is_purged(client, settings):
    from fv.db import now
    nonce = _nonce(client)
    post_media(client, files=[_jpeg(b"orphan")], nonce=nonce)
    stray = settings.media_dir / "staging" / ("ab" * 32)                  # a nonce row that no longer exists
    stray.mkdir(parents=True)
    (stray / "x.bin").write_bytes(b"x")
    with client.app.state.db.connect() as conn:
        conn.execute("UPDATE nonces SET used_at=? WHERE nonce_hex=?", (now(), nonce[2:]))
        assert ms.purge(conn, settings, now()) == 2
    assert _staging(settings) == set()


def test_uploads_are_refused_below_the_free_space_floor(client, settings, monkeypatch):
    nonce = _nonce(client)
    monkeypatch.setattr(ms, "disk_free", lambda _p: ms.DEFAULT_MIN_FREE_BYTES + 1000)
    r = post_media(client, files=[_jpeg(b"a" * 4, 400)], nonce=nonce)           # leaves less than the floor
    assert r.status_code == 507 and r.json()["detail"] == "storage_full"
    assert _staging(settings) == set()
    with client.app.state.db.connect() as conn:                               # refused before the nonce budget was touched
        assert conn.execute("SELECT media_files FROM nonces WHERE nonce_hex=?", (nonce[2:],)).fetchone()[0] == 0
    monkeypatch.setattr(ms, "disk_free", lambda _p: 10 * ms.DEFAULT_MIN_FREE_BYTES)
    assert post_media(client, files=[_jpeg(b"a" * 4, 400)], nonce=nonce).status_code == 200


def _app(settings, monkeypatch, **env):
    from fv.main import create_app
    for k, v in env.items():
        monkeypatch.setenv(k, str(v))
    return create_app(settings)


def test_per_client_byte_budget(settings, monkeypatch):
    app = _app(settings, monkeypatch, FV_MEDIA_MAX_BYTES_PER_IP_DAY=20_000)
    with TestClient(app, client=("203.0.113.30", 1)) as c:
        nonce = _nonce(c)
        assert post_media(c, files=[_jpeg(b"x" * 10, 900)], nonce=nonce).status_code == 200      # ≈ 9 kB charged
        assert post_media(c, files=[_jpeg(b"y" * 10, 900)], nonce=nonce).status_code == 200      # ≈ 18 kB
        r = post_media(c, files=[_jpeg(b"z" * 10, 900)], nonce=nonce)
        assert r.status_code == 429 and r.json()["detail"] == "media_limited" and int(r.headers["retry-after"]) >= 1
    with TestClient(app, client=("203.0.113.31", 1)) as other:                                   # its own budget
        assert post_media(other, files=[_jpeg(b"z" * 10, 900)]).status_code == 200


def test_global_byte_budget_per_hour(settings, monkeypatch):
    app = _app(settings, monkeypatch, FV_MEDIA_MAX_BYTES_PER_HOUR=20_000)
    with TestClient(app, client=("203.0.113.40", 1)) as a, TestClient(app, client=("203.0.113.41", 1)) as b:
        assert post_media(a, files=[_jpeg(b"x" * 10, 900)]).status_code == 200
        assert post_media(b, files=[_jpeg(b"y" * 10, 900)]).status_code == 200
        r = post_media(a, files=[_jpeg(b"z" * 10, 900)])
        assert r.status_code == 503 and r.json()["detail"] == "media_busy" and "retry-after" in r.headers


def test_files_are_streamed_in_chunks(settings, monkeypatch):
    """stage() never reads more than CHUNK bytes at once, hashes the concatenation and enforces the per-file cap."""
    monkeypatch.setattr(ms, "CHUNK", 1000)
    reads: list[int] = []

    class Spy(io.BytesIO):
        def read(self, n=-1):
            reads.append(n)
            return super().read(n)

    class Up:
        def __init__(self, data):
            self.file = Spy(data)

    a, b = b"A" * 2500, b"B" * 10
    staged = ms.stage(settings, "cd" * 32, [Up(a), Up(b)], 4000)
    assert staged["sha256"] == proof.sha256(a + b).hex() and staged["sizes"] == [2500, 10]
    assert reads and all(0 < n <= 1000 for n in reads)
    assert staged["part"].read_bytes() == a + b
    with pytest.raises(ms.FileTooLarge):
        ms.stage(settings, "cd" * 32, [Up(b"C" * 4001)], 4000)
    assert [p.name for p in (settings.media_dir / "staging" / ("cd" * 32)).iterdir()] == [staged["part"].name]


def test_production_values_of_the_media_budgets():
    assert ms.DEFAULT_MIN_FREE_BYTES >= 128 * 1024 * 1024
    assert ms.DEFAULT_MAX_BYTES_PER_IP_DAY <= 512 * 1024 * 1024
    assert ms.DEFAULT_MAX_BYTES_PER_HOUR <= 4 * 1024 * 1024 * 1024 and ms.CHUNK <= 1 << 20
