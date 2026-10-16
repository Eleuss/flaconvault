"""FV_MAX_JSON_BODY: the ASGI body limit covers every route and method (only POST /api/media enforces its own limit), it
reads its value from the settings, counts chunked bodies, and its 413 carries the CORS headers a browser needs."""
import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from fv.main import create_app

LIMIT = 1000
ORIGIN = "http://localhost:3000"


@pytest.fixture()
def small(settings):
    settings.max_json_body = LIMIT
    with TestClient(create_app(settings)) as c:
        yield c


def _routes(routes) -> list[tuple[str, str]]:
    """(method, path) of every API route, routers included by the app walked recursively."""
    out = []
    for r in routes:
        if isinstance(r, APIRoute):
            path = re.sub(r"\{[^}]+\}", "1", r.path)
            out += [(m, path) for m in sorted(r.methods) if m != "HEAD"]
        elif getattr(r, "original_router", None) is not None:      # FastAPI's included-router wrapper
            out += _routes(r.original_router.routes)
        elif getattr(r, "routes", None):
            out += _routes(r.routes)
    return out


def test_every_route_refuses_a_body_over_the_limit(small):
    routes = _routes(small.app.routes)
    for route in (("GET", "/health"), ("POST", "/api/events"), ("POST", "/api/dev/reset"), ("GET", "/t"),
                  ("POST", "/api/admin/purge-seed"), ("POST", "/api/reconcile")):                    # every router module
        assert route in routes, route
    for method, path in routes:
        if (method, path) == ("POST", "/api/media"):
            continue
        r = small.request(method, path, content=b"x" * (LIMIT + 1), headers={"content-type": "application/json"})
        assert r.status_code == 413 and r.json() == {"detail": "request_too_large"}, (method, path, r.status_code)
    # unknown paths and methods are covered too (nothing is routed before the check)
    assert small.request("PUT", "/api/nowhere", content=b"x" * (LIMIT + 1)).status_code == 413
    assert small.request("PUT", "/api/media", content=b"x" * (LIMIT + 1)).status_code == 413


def test_a_body_at_the_limit_passes_and_chunked_bodies_are_counted(small):
    body = b'{"x": "' + b"a" * (LIMIT - 9) + b'"}'
    assert len(body) == LIMIT
    assert small.post("/api/session", content=body, headers={"content-type": "application/json"}).status_code == 200

    def chunks(n):
        for _ in range(n):
            yield b"x" * 300
    r = small.post("/api/verify", content=chunks(4), headers={"content-type": "application/json"})      # no Content-Length
    assert r.status_code == 413 and r.json()["detail"] == "request_too_large"
    assert small.post("/api/session", content=chunks(3), headers={"content-type": "application/json"}).status_code == 200


def test_media_upload_keeps_its_own_limit(small):
    nonce = small.post("/api/session", json={}).json()["nonce"]
    frame = b"\xff\xd8" + b"f" * 5000                                   # > FV_MAX_JSON_BODY, fine for /api/media
    r = small.post("/api/media", data={"nonce": nonce}, files={"file": ("f.jpg", frame, "image/jpeg")})
    assert r.status_code == 200 and r.json()["bytes"] == len(frame)


def test_the_413_carries_cors_headers(small):
    r = small.post("/api/events", content=b"x" * (LIMIT + 1),
                   headers={"content-type": "application/json", "origin": ORIGIN})
    assert r.status_code == 413 and r.headers["access-control-allow-origin"] == ORIGIN
    r = small.post("/api/events", content=b"x" * (LIMIT + 1),
                   headers={"content-type": "application/json", "origin": "https://evil.example"})
    assert r.status_code == 413 and "access-control-allow-origin" not in r.headers


def test_limit_comes_from_the_environment(monkeypatch):
    from fv.config import settings_from_env
    from tests.conftest import TEST_SEED_HEX
    monkeypatch.setenv("FV_SERVER_ED25519_SEED", TEST_SEED_HEX)
    monkeypatch.delenv("FV_MAX_JSON_BODY", raising=False)
    assert settings_from_env().max_json_body == 64 * 1024
    monkeypatch.setenv("FV_MAX_JSON_BODY", "2048")
    assert settings_from_env().max_json_body == 2048
