"""6. Full simulated flow with FastAPI TestClient and a temp DB (server key = vectors.serverTestKey)."""
import io

from nacl.signing import VerifyKey

from fv import proof
from fv.enums import EventType

SERIAL = "SN-2026-000001"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"
MEDIA = "0x358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380"


def _body(tap, nonce, **over):
    b = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
         "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92,
         "mediaHash": MEDIA, "location": {"country": "DE", "city": "Wickede"}, "attester": SELLER, "platform": "SIMULATOR"}
    b.update(over)
    return b


def _nonce(client) -> str:
    r = client.post("/api/session", json={})
    assert r.status_code == 200 and r.json()["nonce"].startswith("0x") and len(r.json()["nonce"]) == 66 and r.json()["ttl"] == 90
    return r.json()["nonce"]


def test_health(client, vectors):
    h = client.get("/health").json()
    assert h["ok"] and h["keyId"] == 1 and h["simulator"] is True and h["pubkeyHex"] == vectors["serverTestKey"]["pubkeyHex"]


def test_full_simulated_flow(chain_client, vectors, monkeypatch):
    client = chain_client
    pub = bytes.fromhex(vectors["serverTestKey"]["pubkeyHex"])
    before = client.get(f"/api/passport/{SERIAL}").json()

    # dev/tag attached to the seeded passport → dev/tap → session → verify: VALID and signed
    tag = client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    assert tag["serial"] == SERIAL and tag["counter"] == 0 and tag["alive"] and len(tag["uid"]) == 14 and tag["uid"].startswith("04")
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    assert tap["responds"] and tap["ctr"] == 1 and tap["ctrHex"] == "000001" and tap["url"].startswith("http://verify.test/t?uid=")

    pv = client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()
    assert pv["verdict"] == "VALID" and pv["counter"] == 1 and pv["serial"] == SERIAL and pv["sealKind"] == 1 and pv["sealDead"] is False
    pv2 = client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()
    assert pv2["verdict"] == "VALID", "preview must not consume the counter"

    nonce = _nonce(client)
    r = client.post("/api/verify", json=_body(tap, nonce))
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["verdict"] == "VALID" and v["counter"] == 1 and v["serial"] == SERIAL and v["grade"] == 0 and v["heatMask"] == 3
    assert v["reviewRecommended"] is False and v["keyId"] == 1 and v["serverPubkey"] == pub.hex() and v["eventId"]
    msg = bytes.fromhex(v["msgHex"])
    sig = bytes.fromhex(v["serverSig"][2:])
    VerifyKey(pub).verify(msg, sig)
    parsed = proof.parse_message(msg)
    assert parsed["counter"] == 1 and parsed["fill"] == 92 and parsed["heat"] == 0 and parsed["uv"] == 3 and parsed["tamper"] == 3
    assert parsed["serial_hash"].hex() == v["serialHash"][2:] and parsed["uid_hash"].hex() == v["uidHash"][2:]
    assert parsed["media_hash"].hex() == MEDIA[2:] and parsed["nonce"].hex() == nonce[2:] and parsed["ts"] == v["ts"]
    b = v["bundle"]
    assert b["schema"] == "flaconvault.scanproof.v1" and b["server"]["sig"] == v["serverSig"] and b["server"]["verdict"] == "VALID"
    assert b["seal"] == {"kind": "NECK", "uidHash": v["uidHash"]} and b["attester"] == {"role": 1, "tier": 2, "pubkey": SELLER}
    assert b["media"][0]["sha256"] == MEDIA and b["session"]["nonce"] == nonce and b["indicators"]["uv"] == 3
    assert proof.bundle_hash(proof.canonical_json(b)).hex() == v["bundleHash"][2:]
    assert v["message"] == "Seal genuine · tap 1"

    # same tap again → REPLAY, unsigned, HTTP 200
    r = client.post("/api/verify", json=_body(tap, _nonce(client)))
    assert r.status_code == 200 and r.json()["verdict"] == "REPLAY" and r.json()["serverSig"] is None and r.json()["grade"] == 4

    # reused nonce → NONCE_INVALID
    tap2 = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    r = client.post("/api/verify", json=_body(tap2, nonce))
    assert r.json()["verdict"] == "NONCE_INVALID" and r.json()["serverSig"] is None
    # ...and the tap was not consumed by a failed nonce check
    assert client.post("/api/preview", json={"uid": tap2["uid"], "ctr": tap2["ctrHex"], "cmac": tap2["cmac"]}).json()["verdict"] == "VALID"

    # expired nonce → NONCE_INVALID (time jumps past the TTL)
    n_exp = _nonce(client)
    import fv.routes_api as ra
    real_now = ra.now
    monkeypatch.setattr(ra, "now", lambda: real_now() + 1000)
    assert client.post("/api/verify", json=_body(tap2, n_exp)).json()["verdict"] == "NONCE_INVALID"
    monkeypatch.setattr(ra, "now", real_now)

    # unknown nonce / garbage nonce
    assert client.post("/api/verify", json=_body(tap2, "0x" + "ab" * 32)).json()["verdict"] == "NONCE_INVALID"
    assert client.post("/api/verify", json=_body(tap2, "nope")).json()["verdict"] == "NONCE_INVALID"

    # bad CMAC → INVALID
    bad = dict(tap2, cmac="00" * 8)
    assert client.post("/api/verify", json=_body(bad, _nonce(client))).json()["verdict"] == "INVALID"

    # heat inconsistency → 422 (malformed), tier 2 without media → 422
    r = client.post("/api/verify", json=_body(tap2, _nonce(client), indicators={"heat": 1, "humidity": 0, "uv": 3}))
    assert r.status_code == 422
    r = client.post("/api/verify", json=_body(tap2, _nonce(client), mediaHash=None))
    assert r.status_code == 422
    # wrong serial claim → 409
    r = client.post("/api/verify", json=_body(tap2, _nonce(client), serial="SN-2026-000002"))
    assert r.status_code == 409

    # tier 1 (no media, zero media hash), heat UNREADABLE trusted → review flag, grade by fill
    r = client.post("/api/verify", json=_body(tap2, _nonce(client), tier=1, mediaHash=None, fill=70,
                                              indicators={"heat": 2, "humidity": 0, "uv": 3}, heatLevels=[0, 0, 0, 0, 0, 0]))
    v2 = r.json()
    assert v2["verdict"] == "VALID" and v2["grade"] == 1 and v2["reviewRecommended"] is True and v2["bundle"]["media"] == []
    assert proof.parse_message(bytes.fromhex(v2["msgHex"]))["media_hash"] == bytes(32)

    # unregistered uid → UNREGISTERED (counter still returned), then REPLAY on the same tap
    u = client.post("/api/dev/tap", json={"uid": "04FFEEDDCCBBAA"}).json()
    r = client.post("/api/verify", json=_body(u, _nonce(client)))
    assert r.json()["verdict"] == "UNREGISTERED" and r.json()["counter"] == u["ctr"] and r.json()["serial"] is None and r.json()["serverSig"] is None
    assert client.post("/api/verify", json=_body(u, _nonce(client))).json()["verdict"] == "REPLAY"

    # kill → dev/tap responds:false → /api/tap/<id> NO_RESPONSE
    k = client.post("/api/dev/kill", json={"uid": tag["uid"]}).json()
    assert k["alive"] is False
    nr = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    assert nr["responds"] is False and nr["url"] == f"http://web.test/t?tap={nr['tapId']}"
    t = client.get(f"/api/tap/{nr['tapId']}").json()
    assert t["verdict"] == "NO_RESPONSE" and t["serial"] == SERIAL and t["message"] == "Seal not responding"
    assert client.post("/api/dev/revive", json={"uid": tag["uid"]}).json()["alive"] is True

    # /t with a valid URL (json) → VALID + counter; same URL again → REPLAY; HTML → 302 to the web app
    tap3 = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    r = client.get(tap3["url"], headers={"Accept": "application/json"})
    assert r.status_code == 200 and r.json()["verdict"] == "VALID" and r.json()["counter"] == tap3["ctr"]
    assert r.json()["serial"] == SERIAL and r.json()["message"] == f"Seal genuine · tap {tap3['ctr']}"
    assert r.json()["uid"] is None and r.json()["tapToken"]          # registered seal: no raw uid; one-time adoption token
    assert client.get(f"/api/tap/{r.json()['tapId']}").json() == {k: v for k, v in r.json().items() if k != "tapToken"}
    r2 = client.get(tap3["url"] + "&format=json")
    assert r2.json()["verdict"] == "REPLAY"
    r3 = client.get(tap3["url"], follow_redirects=False)
    assert r3.status_code == 302 and r3.headers["location"].startswith("http://web.test/t?tap=")
    r4 = client.get("/t?uid=zz&ctr=1&cmac=2", headers={"Accept": "application/json"})
    assert r4.status_code == 200 and r4.json()["verdict"] == "INVALID"

    # passport: seed timeline + our scans
    p = client.get(f"/api/passport/{SERIAL}").json()
    scan_events = [e for e in p["events"] if e["type"] == EventType.SCAN]
    assert len(p["events"]) >= 8 and len(before["events"]) >= 8
    assert p["stats"]["scanCount"] == len(scan_events) == before["stats"]["scanCount"] + 3  # verify ×2 + one /t sighting
    assert [e["ts"] for e in p["events"]] == sorted(e["ts"] for e in p["events"])
    assert p["sealStatus"] == "INTACT" and len(p["seals"]) == 2
    # unconfirmed scans change neither the header indicators nor the grade
    assert p["latest"] == before["latest"] and p["grade"] == before["grade"]
    pend = next(e for e in p["events"] if e["id"] == v["eventId"])
    assert pend["status"] == "pending" and pend["payload"]["server"]["sig"] == v["serverSig"] and pend["gradeAfter"] == 0
    assert pend["location"] == {"country": "DE", "city": "Wickede"} and pend["actor"] == SELLER
    assert client.get("/api/passport/SN-0000-000000").status_code == 404

    # nothing moved for the attester yet (the scans are only pending)
    assert client.get(f"/api/attester/{SELLER}").json()["scanCount"] == before_scans(vectors)

    # confirm the pending scan with its record_scan tx (actor defaults to the scan's attester, as the web sends it)
    client.rpc.scan_tx("5" * 88, v, SELLER)
    e = client.post("/api/events", json={"eventId": v["eventId"], "txSig": "5" * 88, "serial": SERIAL, "type": 2}).json()
    assert e["status"] == "confirmed" and e["txSig"] == "5" * 88 and e["actor"] == SELLER

    # attester stats moved for the confirmed scan only; the header now shows it
    a = client.get(f"/api/attester/{SELLER}").json()
    assert a["scanCount"] == before_scans(vectors) + 1 and a["recentSerials"][0] == SERIAL and a["agreeRate"] is not None
    p = client.get(f"/api/passport/{SERIAL}").json()
    assert p["latest"]["eventId"] == v["eventId"] and p["latest"]["counter"] == 1 and p["grade"] == 0


def before_scans(_vectors) -> int:
    return 4  # seeded scans for the seller in docs/seed/passports.json


def test_seed_passports(client):
    lst = client.get("/api/passports").json()
    assert [p["serial"] for p in lst] == ["SN-2026-000001", "SN-2026-000002", "SN-2026-000003"]
    assert [p["grade"] for p in lst] == [0, 2, 4] and lst[2]["void"] is True and lst[0]["scanCount"] == 14
    p1 = client.get("/api/passport/SN-2026-000001").json()
    assert p1["stats"] == {"scanCount": 14, "attesterCount": 3, "certifiedCount": 1, "counter": 14}
    assert p1["issuerLabel"] == "Parfümerie X, Düsseldorf" and [e["type"] for e in p1["events"]][:3] == [0, 1, 2]
    assert {e["type"] for e in p1["events"]} >= {0, 1, 2, 3, 5, 6, 7}
    p2 = client.get("/api/passport/SN-2026-000002").json()
    assert p2["grade"] == 2 and p2["latest"]["indicators"] == {"heat": 1, "humidity": 2, "uv": 3} and p2["latest"]["reviewRecommended"]
    assert p2["seals"][0]["kind"] == 0
    p3 = client.get("/api/passport/SN-2026-000003").json()
    assert p3["grade"] == 4 and p3["void"] and p3["sealStatus"] == "NO_RESPONSE" and p3["seals"][0]["dead"]
    assert p3["events"][-1]["type"] == EventType.SEAL_DEAD and p3["events"][-1]["gradeAfter"] == 4
    tags = {t["uid"]: t for t in client.get("/api/dev/tags").json()}
    assert set(tags) == {"04A1B2C3D4E5F6", "04DE5F1EACC040", "041E3C8A2D6B80", "04FFEEDDCCBBAA"}
    assert tags["041E3C8A2D6B80"]["alive"] is False and tags["04FFEEDDCCBBAA"]["serial"] is None
    # seeded scan bundles are signed with a throwaway key (keyId 0), never with the server key
    pub = bytes.fromhex(client.get("/health").json()["pubkeyHex"])
    seeded = [e for e in p1["events"] if e["type"] == 2 and "msgHex" in e["payload"]]
    assert seeded and all(e["payload"]["seed"] is True and e["payload"]["server"]["keyId"] == 0 for e in seeded)
    for e in seeded:
        assert not proof.verify(pub, bytes.fromhex(e["payload"]["msgHex"]), bytes.fromhex(e["payload"]["server"]["sig"][2:]))


def test_seeded_tag_taps_after_seed_counter(client):
    # the seeded virtual tag continues at counter 15, and the seal accepts it
    tap = client.post("/api/dev/tap", json={"uid": "04A1B2C3D4E5F6"}).json()
    assert tap["ctr"] == 15
    r = client.get(tap["url"], headers={"Accept": "application/json"}).json()
    assert r["verdict"] == "VALID" and r["counter"] == 15 and r["serial"] == "SN-2026-000001"
    dead = client.post("/api/dev/tap", json={"uid": "041E3C8A2D6B80"}).json()
    assert dead["responds"] is False and client.get(f"/api/tap/{dead['tapId']}").json()["serial"] == "SN-2026-000003"


PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"


def test_events_mint_and_seal_attach_create_rows(chain_client):
    client, rpc = chain_client, chain_client.rpc
    rpc.mint_tx("4" * 88, "SN-2026-000010", PARTNER, block_time=1790000100)
    e = client.post("/api/events", json={"serial": "SN-2026-000010", "type": "MINT", "actor": PARTNER, "ts": 1,
                                         "txSig": "4" * 88, "payload": {"brand": "Amouage", "name": "Interlude Man", "batch": "AM01"},
                                         "location": {"country": "DE", "city": "Düsseldorf"}}).json()
    assert e["type"] == 0 and e["status"] == "confirmed" and e["actorLabel"] == "Parfümerie X, Düsseldorf"
    assert e["ts"] == 1790000100                                    # blockTime, never the client ts

    # a chip tapped while still unassigned: its counter carries over into the seal on attach (no replay window)
    client.post("/api/dev/tag", json={"uid": "04111111111111"})
    early = client.post("/api/dev/tap", json={"uid": "04111111111111"}).json()
    assert client.get(early["url"] + "&format=json").json()["verdict"] == "UNREGISTERED"

    rpc.attach_tx("A" * 88, "SN-2026-000010", "04111111111111", PARTNER, block_time=1790000200)
    e2 = client.post("/api/events", json={"serial": "SN-2026-000010", "type": "SEAL_ATTACH", "txSig": "A" * 88, "actor": PARTNER,
                                          "payload": {"uid": "04111111111111", "kind": 1}}).json()
    assert e2["status"] == "confirmed" and e2["sealUidHash"] == "0x" + proof.uid_hash(bytes.fromhex("04111111111111")).hex()
    p = client.get("/api/passport/SN-2026-000010").json()
    assert p["brand"] == "Amouage" and p["seals"][0]["kind"] == 1 and p["issuerLabel"] == "Parfümerie X, Düsseldorf"
    assert p["seals"][0]["lastCounter"] == early["ctr"]
    assert client.post("/api/preview", json={"uid": early["uid"], "ctr": early["ctr"], "cmac": early["cmac"]}).json()["verdict"] == "REPLAY"
    # the simulator tag for that uid (created before the attach) now verifies as VALID
    tap = client.post("/api/dev/tap", json={"uid": "04111111111111"}).json()
    assert client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctr"], "cmac": tap["cmac"]}).json()["serial"] == "SN-2026-000010"
    # SEAL_DEAD backed by a partner's mark_seal_dead tx voids the passport
    rpc.dead_tx("6" * 88, "SN-2026-000010", "04111111111111", PARTNER)
    d = client.post("/api/events", json={"serial": "SN-2026-000010", "type": "SEAL_DEAD", "sealUidHash": e2["sealUidHash"],
                                         "txSig": "6" * 88, "actor": PARTNER}).json()
    assert d["gradeAfter"] == 4 and d["status"] == "confirmed"
    p = client.get("/api/passport/SN-2026-000010").json()
    assert p["void"] and p["grade"] == 4 and p["sealStatus"] == "NO_RESPONSE"
    assert client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctr"], "cmac": tap["cmac"]}).json()["verdict"] == "NO_RESPONSE"
    assert client.post("/api/events", json={"serial": "SN-nope", "type": "LIST", "txSig": "L" * 88, "actor": PARTNER}).status_code == 404
    assert client.post("/api/events", json={"serial": "SN-2026-000010", "type": "WHAT"}).status_code == 422


def test_media_upload(client, settings):
    data = b"\xff\xd8\xff\xe0frame-bytes-" * 100
    r = client.post("/api/media", files={"file": ("frames.jpg", io.BytesIO(data), "image/jpeg")})
    assert r.status_code == 200
    j = r.json()
    assert j["sha256"] == "0x" + proof.sha256(data).hex() and j["ar"] is None and j["bytes"] == len(data) and j["files"] == 1
    assert (settings.media_dir / (proof.sha256(data).hex() + ".bin")).read_bytes() == data
    assert client.post("/api/media").status_code == 422


def test_media_limits(client, monkeypatch):
    import fv.routes_api as ra
    img = lambda i: ("files", (f"f{i}.png", io.BytesIO(b"\x89PNG" + bytes([i]) * 10), "image/png"))  # noqa: E731
    assert client.post("/api/media", files=[img(i) for i in range(6)]).status_code == 200
    assert client.post("/api/media", files=[img(i) for i in range(7)]).status_code == 413          # > 6 files
    for ctype in ("application/octet-stream", "text/html", "image/svg+xml", "image/gif"):
        r = client.post("/api/media", files={"file": ("x", io.BytesIO(b"<svg/>"), ctype)})
        assert r.status_code == 415, ctype
    # mixed batch: one bad part rejects the whole upload
    mixed = [img(1), ("files", ("x.html", io.BytesIO(b"<html>"), "text/html"))]
    assert client.post("/api/media", files=mixed).status_code == 415
    monkeypatch.setattr(ra, "MEDIA_MAX_BYTES", 1000)                                                 # 8 MB in production
    assert client.post("/api/media", files={"file": ("big.webp", io.BytesIO(b"R" * 1001), "image/webp")}).status_code == 413
    assert client.post("/api/media", files={"file": ("ok.webp", io.BytesIO(b"R" * 1000), "image/webp")}).status_code == 200


def test_dev_routes_404_when_simulator_off(settings):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    settings.dev_simulator = False
    settings.key_mode = "sdmbackend"                                  # a real deployment: real key mode ...
    settings.master_key_hex = "0123456789ABCDEF0123456789ABCDEF"     # ... and a non-zero master key
    with TestClient(create_app(settings)) as c:
        assert c.get("/health").json()["simulator"] is False
        assert c.get("/api/dev/tags").status_code == 404
        assert c.post("/api/dev/tap", json={"uid": "04A1B2C3D4E5F6"}).status_code == 404
        assert c.post("/api/dev/tag", json={"uid": "04A1B2C3D4E5F6"}).status_code == 404
        assert c.post("/api/dev/reset", headers={"x-admin-token": settings.admin_token}).status_code == 404


def test_refuses_to_start_without_simulator_and_zero_master_key(settings):
    import pytest
    from fastapi.testclient import TestClient
    from fv.config import Settings
    from fv.main import create_app
    settings.dev_simulator = False
    assert settings.master_key == bytes(16)
    with pytest.raises(RuntimeError, match="FV_MASTER_KEY is all zeros"):
        with TestClient(create_app(settings)):
            pass
    # the simulator is off unless explicitly enabled
    assert Settings(server_seed_hex="11" * 32).dev_simulator is False


def test_simulator_default_off_in_env(monkeypatch):
    from fv.config import settings_from_env
    monkeypatch.delenv("FV_DEV_SIMULATOR", raising=False)
    monkeypatch.setenv("FV_SERVER_ED25519_SEED", "11" * 32)
    assert settings_from_env().dev_simulator is False
    monkeypatch.setenv("FV_DEV_SIMULATOR", "true")
    assert settings_from_env().dev_simulator is True


def test_dev_tag_refuses_registered_seal(client):
    # 04DE5F1EACC040 is the seeded BOX seal of SN-2026-000002 — and it has a sim tag, so the simulator may serve it
    assert client.post("/api/dev/tag", json={"uid": "04DE5F1EACC040"}).status_code == 200
    # a registered seal without a virtual tag of its own (a real chip): never a CMAC oracle
    with client.app.state.db.connect() as conn:
        conn.execute("DELETE FROM sim_tags WHERE uid_hex='04DE5F1EACC040'")
    r = client.post("/api/dev/tag", json={"uid": "04DE5F1EACC040"})
    assert r.status_code == 409
    assert client.post("/api/dev/tap", json={"uid": "04DE5F1EACC040"}).status_code == 404
    assert client.post("/api/dev/tag", json={"uid": "04DE5F1EACC040", "serial": "SN-2026-000001"}).status_code == 409
    assert client.post("/api/dev/tag", json={"uid": "nothex"}).status_code == 422


def test_reset_reseeds(client):
    client.post("/api/dev/tag", json={"serial": SERIAL})
    assert len(client.get("/api/dev/tags").json()) == 5
    assert client.post("/api/dev/reset").status_code == 403                                    # FV_ADMIN_TOKEN is set
    assert client.post("/api/dev/reset", headers={"x-admin-token": "wrong"}).status_code == 403
    assert len(client.get("/api/dev/tags").json()) == 5
    assert client.post("/api/dev/reset", headers={"x-admin-token": "test-admin-token"}).json()["ok"]
    assert len(client.get("/api/dev/tags").json()) == 4


def test_reset_without_admin_token_env(settings):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    settings.admin_token = ""
    with TestClient(create_app(settings)) as c:
        assert c.post("/api/dev/reset").json()["ok"]                                           # simulator-only dev box


def test_certify_console_mint_and_seal_attach_idempotent(chain_client):
    client, rpc = chain_client, chain_client.rpc
    partner = PARTNER
    rpc.mint_tx("M" * 88, "SN-2026-000042", partner, block_time=1790000300)
    rpc.mint_tx("N" * 88, "SN-2026-000042", partner, block_time=1790000301)
    mint = {"serial": "SN-2026-000042", "type": "MINT", "actor": partner, "txSig": "M" * 88,
            "payload": {"serial": "SN-2026-000042", "brand": "Amouage", "name": "Interlude Man", "batch": "AM01",
                        "asset": "4FQoaiZa5NGcjJK5qzZ2VnXFa8MBM7TZEtyruU2wu6ck", "issuerLabel": "Parfümerie X, Düsseldorf", "siteId": 1},
            "location": {"country": "DE", "city": "Düsseldorf"}}
    e1 = client.post("/api/events", json=mint).json()
    assert e1["type"] == 0 and e1["status"] == "confirmed" and e1["txSig"] == "M" * 88 and e1["payload"]["siteId"] == 1
    p = client.get("/api/passport/SN-2026-000042").json()
    assert p["asset"] == "4FQoaiZa5NGcjJK5qzZ2VnXFa8MBM7TZEtyruU2wu6ck" and p["issuer"] == partner and p["batch"] == "AM01"
    assert p["issuerLabel"] == "Parfümerie X, Düsseldorf" and p["grade"] == 0
    # second MINT for the same serial by the issuer: same event row, a confirmed event is never changed, no duplicate;
    # the issuer may rename the passport
    e1b = client.post("/api/events", json={**mint, "txSig": "N" * 88, "payload": {**mint["payload"], "name": "Interlude Man EDP"}}).json()
    assert e1b["id"] == e1["id"] and e1b["txSig"] == "M" * 88 and e1b["status"] == "confirmed" and e1b["ts"] == e1["ts"]
    p = client.get("/api/passport/SN-2026-000042").json()
    assert [e["type"] for e in p["events"]] == [0] and p["name"] == "Interlude Man EDP"
    # the same tx again (recovered path of the certify console) is idempotent too
    assert client.post("/api/events", json=mint).json()["id"] == e1["id"]

    # the simulator tag exists before the attach (dev/tag refuses registered seals without one)
    client.post("/api/dev/tag", json={"uid": "04C0FFEE000042"})
    rpc.attach_tx("S" * 88, "SN-2026-000042", "04C0FFEE000042", partner, block_time=1790000400)
    rpc.attach_tx("T" * 88, "SN-2026-000042", "04C0FFEE000042", partner, block_time=1790000401)
    att = {"serial": "SN-2026-000042", "type": "SEAL_ATTACH", "actor": partner, "txSig": "S" * 88,
           "payload": {"uid": "04c0ffee000042", "kind": 1}}
    e2 = client.post("/api/events", json=att).json()
    uid_hash = "0x" + proof.uid_hash(bytes.fromhex("04C0FFEE000042")).hex()
    assert e2["type"] == 1 and e2["status"] == "confirmed" and e2["sealUidHash"] == uid_hash and e2["payload"]["kindName"] == "NECK"
    p = client.get("/api/passport/SN-2026-000042").json()
    assert p["seals"] == [{"uidHash": uid_hash, "kind": 1, "lastCounter": 0, "dead": False, "attachedAt": e2["ts"]}]
    assert e2["ts"] == 1790000400
    e2b = client.post("/api/events", json={**att, "txSig": "T" * 88}).json()
    assert e2b["id"] == e2["id"] and e2b["txSig"] == "S" * 88
    p = client.get("/api/passport/SN-2026-000042").json()
    assert len(p["seals"]) == 1 and [e["type"] for e in p["events"]] == [0, 1]
    # the attached uid now verifies against this passport
    tap = client.post("/api/dev/tap", json={"uid": "04C0FFEE000042"}).json()
    assert client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()["serial"] == "SN-2026-000042"
