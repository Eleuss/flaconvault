"""CORS: the web runs on another origin and calls the verifier directly, so every error it must act on needs CORS headers,
and Retry-After (not a CORS-safelisted response header) must be listed in Access-Control-Expose-Headers, or the browser
hides it from fetch() and the web never waits it out (apps/web/src/lib/errors.ts, verify-api.ts eventRetryDelay)."""
import hashlib
import io

from fastapi.testclient import TestClient
from solders.pubkey import Pubkey

from tests.conftest import post_media, sig

ORIGIN = "http://localhost:3000"                 # the default FV_CORS_ORIGINS entry
EVIL = "https://evil.example"
SERIAL2 = "SN-2026-000002"
MALLORY = str(Pubkey.from_bytes(hashlib.sha256(b"mallory").digest()))


def _exposed(r) -> set[str]:
    return {h.strip().lower() for h in r.headers.get("access-control-expose-headers", "").split(",") if h.strip()}


def _assert_readable(r, status: int, detail: str):
    assert r.status_code == status and r.json()["detail"] == detail, (r.status_code, r.text)
    assert int(r.headers["retry-after"]) >= 1
    assert r.headers["access-control-allow-origin"] == ORIGIN
    assert "retry-after" in _exposed(r)


def _assert_no_cors(r):
    """No Access-Control-Allow-Origin: the browser then hides the whole response (status, body and headers) from that
    page. Starlette still adds its static Access-Control-Expose-Headers line, which grants nothing on its own."""
    assert "access-control-allow-origin" not in r.headers and "access-control-allow-credentials" not in r.headers, \
        dict(r.headers)


def _app(settings, monkeypatch, **env):
    from fv.main import create_app
    for k, v in env.items():
        monkeypatch.setenv(k, str(v))
    return create_app(settings)


def test_retry_after_is_exposed_on_a_429_rate_limited(settings, monkeypatch):
    app = _app(settings, monkeypatch, FV_RATE_LIMIT_PER_MIN=2)
    with TestClient(app, client=("203.0.113.50", 1)) as c:
        for _ in range(2):
            assert c.post("/api/session", json={}, headers={"origin": ORIGIN}).status_code == 200
        _assert_readable(c.post("/api/session", json={}, headers={"origin": ORIGIN}), 429, "rate_limited")
        # a disallowed origin gets the same 429 but no CORS headers at all, so its page cannot read anything
        r = c.post("/api/session", json={}, headers={"origin": EVIL})
        assert r.status_code == 429 and "retry-after" in r.headers
        _assert_no_cors(r)


def test_retry_after_is_exposed_on_a_503_media_busy(settings, monkeypatch):
    app = _app(settings, monkeypatch, FV_MEDIA_MAX_BYTES_PER_HOUR=20_000)

    def jpeg(tag: bytes):
        return ("files", (f"{tag.decode()}.jpg", io.BytesIO(b"\xff\xd8" + tag * 9000), "image/jpeg"))
    with TestClient(app, client=("203.0.113.51", 1), headers={"origin": ORIGIN}) as c:
        assert post_media(c, files=[jpeg(b"x")]).status_code == 200
        assert post_media(c, files=[jpeg(b"y")]).status_code == 200
        _assert_readable(post_media(c, files=[jpeg(b"z")]), 503, "media_busy")


def test_retry_after_is_exposed_on_a_503_busy(chain_client):
    import fv.txverify as tv
    held = 0
    while tv._SLOTS.acquire(blocking=False):
        held += 1
    try:
        body = {"serial": SERIAL2, "type": "LIST", "txSig": sig("cors-busy"), "actor": MALLORY}
        _assert_readable(chain_client.post("/api/events", json=body, headers={"origin": ORIGIN}), 503, "busy")
        r = chain_client.post("/api/events", json=body, headers={"origin": EVIL})
        assert r.status_code == 503 and r.json()["detail"] == "busy"
        _assert_no_cors(r)
    finally:
        for _ in range(held):
            tv._SLOTS.release()
    assert held == tv.MAX_CONCURRENT_LOOKUPS


def test_preflight_allows_only_the_configured_origins(client):
    ok = client.options("/api/events", headers={"origin": ORIGIN, "access-control-request-method": "POST",
                                                "access-control-request-headers": "content-type"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == ORIGIN
    bad = client.options("/api/events", headers={"origin": EVIL, "access-control-request-method": "POST"})
    assert bad.status_code == 400 and "access-control-allow-origin" not in bad.headers
