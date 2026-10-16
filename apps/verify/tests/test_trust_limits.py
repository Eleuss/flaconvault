"""Abuse limits: per-IP rate limiting, SEAL_DEAD report limits, the /api/media nonce budget and size checks, serial
format, id bounds, and the production values of the limits themselves."""
import io

import pytest
from fastapi.testclient import TestClient

from fv import proof
from fv.ratelimit import RateLimiter, client_ip
from tests.conftest import ORIG_MEDIA_MAX_BYTES, ORIG_TX_RETRY_DELAYS, post_media

SERIAL = "SN-2026-000001"
UID_HASH = "0x" + proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")).hex()


def test_production_values_of_the_limits():
    import fv.routes_api as ra
    import fv.txverify as tv
    assert len(ORIG_TX_RETRY_DELAYS) == 3 and 3.5 <= sum(ORIG_TX_RETRY_DELAYS) <= 4.5
    assert ORIG_MEDIA_MAX_BYTES == 8 * 1024 * 1024 and ra.MEDIA_MAX_FILES == 6
    assert ra.MEDIA_MAX_BODY < 6 * 8 * 1024 * 1024 + 1024 * 1024
    assert tv.MAX_CONCURRENT_LOOKUPS <= 16 and ra.REPORT_WINDOW_S == 24 * 3600


# ---------- rate limiting ----------

def test_token_bucket():
    lim = RateLimiter.per_minute(3)
    assert [lim.hit("a", now=0.0) for _ in range(4)] == [True, True, True, False]
    assert lim.hit("b", now=0.0)                                    # per key
    assert lim.hit("a", now=20.0) and not lim.hit("a", now=20.0)    # one token back after 20 s
    small = RateLimiter(capacity=1, rate_per_s=1, max_keys=4)
    for i in range(10):
        small.hit(f"k{i}", now=float(i))
    assert len(small._buckets) <= 4                                 # memory stays bounded


def _app(settings, monkeypatch, per_min="3", reports="1000"):
    from fv.main import create_app
    monkeypatch.setenv("FV_RATE_LIMIT_PER_MIN", per_min)
    monkeypatch.setenv("FV_REPORT_LIMIT_PER_HOUR", reports)
    return create_app(settings)


def test_posts_and_t_are_rate_limited_per_ip(settings, monkeypatch):
    app = _app(settings, monkeypatch)
    with TestClient(app, client=("203.0.113.7", 1234)) as c:
        assert [c.post("/api/session", json={}).status_code for _ in range(4)] == [200, 200, 200, 429]
        r = c.post("/api/preview", json={"cmac": "00" * 8})
        assert r.status_code == 429 and r.json()["detail"] == "rate_limited" and int(r.headers["retry-after"]) >= 1
        assert c.get("/t?uid=04A1B2C3D4E5F6&ctr=000001&cmac=00").status_code == 429
        for path in ("/api/verify", "/api/events", "/api/media", "/api/reconcile"):
            assert c.post(path, json={}).status_code == 429, path
        assert c.get("/api/passports").status_code == 200           # reads are not limited
    # another client address has its own budget
    with TestClient(app, client=("203.0.113.8", 1234)) as c:
        assert c.post("/api/session", json={}).status_code == 200


def test_forwarded_for_is_trusted_only_from_the_platform_proxy(settings, monkeypatch):
    app = _app(settings, monkeypatch, per_min="2")
    with TestClient(app, client=("10.0.0.5", 1)) as proxy:            # Railway's edge reaches us over a private network
        h = {"x-forwarded-for": "198.51.100.1"}
        assert [proxy.post("/api/session", json={}, headers=h).status_code for _ in range(3)] == [200, 200, 429]
        # a client-written left part of the header does not create a new identity
        h2 = {"x-forwarded-for": "1.2.3.4, 198.51.100.1"}
        assert proxy.post("/api/session", json={}, headers=h2).status_code == 429
        assert proxy.post("/api/session", json={}, headers={"x-forwarded-for": "198.51.100.2"}).status_code == 200
    with TestClient(app, client=("8.8.8.8", 1)) as direct:           # a public peer: the header is ignored
        for i in range(2):
            assert direct.post("/api/session", json={}, headers={"x-forwarded-for": f"9.9.9.{i}"}).status_code == 200
        assert direct.post("/api/session", json={}, headers={"x-forwarded-for": "9.9.9.99"}).status_code == 429


def test_client_ip_parsing():
    class R:
        def __init__(self, peer, xff=None):
            self.client = type("C", (), {"host": peer})()
            self.headers = {"x-forwarded-for": xff} if xff else {}
    assert client_ip(R("10.1.2.3", "8.8.8.8")) == "8.8.8.8"
    assert client_ip(R("127.0.0.1", " 7.7.7.7 , 8.8.8.8 ")) == "8.8.8.8"
    assert client_ip(R("100.64.0.9", "8.8.4.4")) == "8.8.4.4"        # CGNAT range of platform edges
    assert client_ip(R("8.8.8.8", "1.1.1.1")) == "8.8.8.8"
    assert client_ip(R("testclient", "1.1.1.1")) == "testclient"


# ---------- SEAL_DEAD reports ----------

def _report(c, **over):
    nonce = c.post("/api/session", json={}).json()["nonce"]
    body = {"serial": SERIAL, "type": "SEAL_DEAD", "nonce": nonce, **over}
    return c.post("/api/events", json=body)


def test_one_open_report_per_seal_and_day(chain_client, monkeypatch):
    c = chain_client
    e = _report(c, sealUidHash=UID_HASH).json()
    assert e["status"] == "reported"
    r = _report(c, sealUidHash=UID_HASH)
    assert r.status_code == 429 and r.json()["detail"] == "report_limited"
    assert _report(c).status_code == 429                              # a report naming no seal is blocked by it as well
    # … a day later a new report is accepted again
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE events SET ts=ts-86401 WHERE id=?", (e["id"],))
    assert _report(c, sealUidHash=UID_HASH).json()["status"] == "reported"
    # the refused attempts did not consume their nonces
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert [x["status"] for x in p["events"] if x["type"] == 9] == ["reported", "reported"]
    assert p["void"] is False and p["sealStatus"] == "INTACT"


def test_report_payload_has_a_fixed_schema(chain_client):
    c = chain_client
    e = _report(c, actor="PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR", actorLabel="FlaconVault",
                payload={"source": "nfc", "uid": "04A1B2C3D4E5F6", "note": "Seal not responding", "blob": "x" * 10000,
                         "html": "<b>VOID</b>"}).json()
    assert e["payload"] == {"source": "nfc", "note": "Seal not responding", "uidTail": "…F6",
                            "reportedBy": "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"}
    assert e["sealUidHash"] == UID_HASH and e["actor"] is None and e["actorLabel"] is None
    assert "04A1B2C3D4E5F6" not in c.get(f"/api/passport/{SERIAL}").text
    e2 = _report(c, serial="SN-2026-000002", payload={"source": "<script>", "note": 5, "uid": "zz"}).json()
    assert e2["payload"] == {"source": "manual"}


def test_report_budget_per_ip(settings, monkeypatch):
    app = _app(settings, monkeypatch, per_min="1000", reports="2")
    with TestClient(app, client=("203.0.113.20", 1)) as c:
        assert _report(c, serial="SN-2026-000001").json()["status"] == "reported"
        assert _report(c, serial="SN-2026-000002").json()["status"] == "reported"
        r = _report(c, serial="SN-2026-000003")
        assert r.status_code == 429 and r.json()["detail"] == "report_limited"


def test_expired_report_nonce_is_refused(chain_client, monkeypatch):
    import fv.routes_api as ra
    c = chain_client
    nonce = c.post("/api/session", json={}).json()["nonce"]
    real = ra.now
    monkeypatch.setattr(ra, "now", lambda: real() + 1000)
    r = c.post("/api/events", json={"serial": SERIAL, "type": "SEAL_DEAD", "nonce": nonce})
    assert r.status_code == 403 and r.json()["detail"] == "nonce_invalid"


def test_reported_seal_dead_never_voids(chain_client):
    c = chain_client
    for serial in ("SN-2026-000001", "SN-2026-000002"):
        _report(c, serial=serial)
        p = c.get(f"/api/passport/{serial}").json()
        assert p["void"] is False and p["grade"] != 4 and p["sealStatus"] != "NO_RESPONSE"


# ---------- /api/media ----------

def _img(i, size=10):
    return ("files", (f"f{i}.png", io.BytesIO(b"\x89PNG" + bytes([i]) * size), "image/png"))


def test_media_needs_an_unused_session_nonce(client, monkeypatch):
    import fv.routes_api as ra
    f = {"file": ("a.jpg", io.BytesIO(b"\xff\xd8x" * 10), "image/jpeg")}
    for data in ({}, {"nonce": "garbage"}, {"nonce": "0x" + "ab" * 32}):
        r = client.post("/api/media", data=data, files=f)
        assert r.status_code == 403 and r.json()["detail"] == "media_nonce_invalid", data
    # the nonce is checked before any file is looked at
    r = client.post("/api/media", data={"nonce": "0x" + "ab" * 32}, files={"file": ("x.html", io.BytesIO(b"<b>"), "text/html")})
    assert r.status_code == 403 and r.json()["detail"] == "media_nonce_invalid"
    nonce = client.post("/api/session", json={}).json()["nonce"]
    assert post_media(client, files=f, nonce=nonce).status_code == 200
    # expired
    real = ra.now
    monkeypatch.setattr(ra, "now", lambda: real() + 1000)
    assert post_media(client, files=f, nonce=nonce).json()["detail"] == "media_nonce_invalid"
    monkeypatch.setattr(ra, "now", real)
    # consumed by /api/verify
    tap = client.post("/api/dev/tap", json={"uid": "04A1B2C3D4E5F6"}).json()
    n2 = client.post("/api/session", json={}).json()["nonce"]
    v = client.post("/api/verify", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": n2, "role": 0, "tier": 1,
                                         "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6, "fill": 90}).json()
    assert v["verdict"] == "VALID"
    assert post_media(client, files=f, nonce=n2).json()["detail"] == "media_nonce_invalid"


def test_at_most_six_files_per_nonce(client):
    nonce = client.post("/api/session", json={}).json()["nonce"]
    assert post_media(client, files=[_img(i) for i in range(4)], nonce=nonce).status_code == 200
    r = post_media(client, files=[_img(i + 10) for i in range(3)], nonce=nonce)
    assert r.status_code == 413 and "session" in r.json()["detail"]
    assert post_media(client, files=[_img(i + 20) for i in range(2)], nonce=nonce).status_code == 200
    assert post_media(client, files=[_img(30)], nonce=nonce).status_code == 413
    assert post_media(client, files=[_img(i) for i in range(8)]).status_code == 413       # > 6 in one upload


def test_media_body_size_is_checked_before_reading(client):
    import fv.routes_api as ra
    nonce = client.post("/api/session", json={}).json()["nonce"]
    body = b"x" * 10

    def gen():
        yield body
    r = client.post("/api/media", content=gen(), headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 411                                             # streamed without Content-Length
    r = client.post("/api/media", content=b"--x--", headers={"content-type": "multipart/form-data; boundary=x",
                                                              "content-length": str(ra.MEDIA_MAX_BODY + 1)})
    assert r.status_code == 413
    with client.app.state.db.connect() as conn:
        assert conn.execute("SELECT media_files FROM nonces WHERE nonce_hex=?", (nonce[2:],)).fetchone()[0] == 0


# ---------- serial format, id bounds ----------

@pytest.mark.parametrize("serial", ["SN 2026/0001", "LOT#7", "50%-batch", "ab", "-SN-1", "x" * 65, "SN-2026-000001 "])
def test_invalid_serials_are_refused(chain_client, serial):
    from tests.conftest import sig
    c = chain_client
    c.rpc.mint_tx(sig("ser"), "SN-2026-000400", "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR")
    r = c.post("/api/events", json={"serial": serial, "type": "MINT", "txSig": sig("ser"),
                                    "actor": "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR", "payload": {"brand": "B", "name": "N"}})
    assert r.status_code == 422, serial
    nonce = c.post("/api/session", json={}).json()["nonce"]
    assert c.post("/api/events", json={"serial": serial, "type": "SEAL_DEAD", "nonce": nonce}).status_code == 422
    v = c.post("/api/verify", json={"uid": "04A1B2C3D4E5F6", "ctr": "000001", "cmac": "00" * 8, "nonce": nonce, "role": 0, "tier": 1,
                                    "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6, "fill": 90, "serial": serial})
    assert v.status_code == 422


def test_valid_serial_charset():
    from fv.routes_api import valid_serial
    for s in ("SN-2026-000001", "abc", "A.b_c-1", "x" * 64):
        assert valid_serial(s), s
    for s in ("", None, "ab", "x" * 65, ".abc", "a/b", "a b", "ä-1234"):
        assert not valid_serial(s), s


def test_ids_beyond_sqlite_range_are_422_not_500(chain_client):
    c = chain_client
    huge = 99999999999999999999
    assert c.post("/api/events", json={"eventId": huge, "txSig": "x"}).status_code == 422
    assert c.post("/api/events", json={"eventId": 0}).status_code == 422
    nonce = c.post("/api/session", json={}).json()["nonce"]
    assert c.post("/api/verify", json={"tapId": huge, "tapToken": "x", "nonce": nonce, "role": 0, "tier": 1,
                                       "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6, "fill": 90}).status_code == 422


def test_passport_metadata_json(client):
    m = client.get("/api/passport/SN-2026-000001/metadata.json").json()
    assert m["name"] == "Roja Parfums · Haute Luxe" and m["external_url"] == "http://web.test/p/SN-2026-000001"
    assert m["image"].startswith("http://web.test/") and {"trait_type": "Serial", "value": "SN-2026-000001"} in m["attributes"]
    assert "NFT" not in str(m)
    assert client.get("/api/passport/SN-nope-404/metadata.json").status_code == 404
