"""A tap consumed by /t can be adopted once by a scan session started afterwards (no second tap on the phone) —
only with the one-time token the /t redirect carries (`k`)."""
from urllib.parse import parse_qs, urlparse

SERIAL = "SN-2026-000001"


def _verify_body(nonce, tap_id, token, **over):
    b = {"tapId": tap_id, "tapToken": token, "nonce": nonce, "role": 0, "tier": 1, "indicators": {"heat": 3, "humidity": 3, "uv": 3},
         "heatLevels": [0, 0, 0, 0, 0, 0], "fill": 92, "platform": "IOS_WEB"}
    b.update(over)
    return b


def _nonce(client) -> str:
    return client.post("/api/session", json={}).json()["nonce"]


def _t_tap(client, uid):
    """Simulated sticker tap landing on /t → (tapId, token) from the redirect."""
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    r = client.get(f"/t?{urlparse(tap['url']).query}", follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    return int(q["tap"][0]), q.get("k", [None])[0]


def test_adopt_tap_from_t(client):
    tag = client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    tap_id, token = _t_tap(client, tag["uid"])
    assert token and len(token) >= 20
    row = client.get(f"/api/tap/{tap_id}").json()
    assert row["verdict"] == "VALID" and row["counter"] == 1
    assert row["uid"] is None and "tapToken" not in row             # registered seal: no raw uid, never the token

    # wrong / missing token → INVALID, and the tap stays adoptable
    assert client.post("/api/verify", json=_verify_body(_nonce(client), tap_id, "x" * 22)).json()["verdict"] == "INVALID"
    assert client.post("/api/verify", json=_verify_body(_nonce(client), tap_id, None)).json()["verdict"] == "INVALID"
    # a sequential neighbour id with this token → INVALID (the token is bound to its tap)
    assert client.post("/api/verify", json=_verify_body(_nonce(client), tap_id + 1, token)).json()["verdict"] == "INVALID"

    v = client.post("/api/verify", json=_verify_body(_nonce(client), tap_id, token)).json()
    assert v["verdict"] == "VALID" and v["counter"] == 1 and v["serial"] == SERIAL and v["serverSig"], v

    # second adoption of the same tap (same token) → REPLAY
    v2 = client.post("/api/verify", json=_verify_body(_nonce(client), tap_id, token)).json()
    assert v2["verdict"] == "REPLAY" and v2["serverSig"] is None

    # unknown tap → INVALID
    assert client.post("/api/verify", json=_verify_body(_nonce(client), 999999, token)).json()["verdict"] == "INVALID"


def test_adopt_window_and_failed_nonce(client):
    tag = client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    tap_id, token = _t_tap(client, tag["uid"])
    # a bad nonce does not burn the adoption
    assert client.post("/api/verify", json=_verify_body("0x" + "ab" * 32, tap_id, token)).json()["verdict"] == "NONCE_INVALID"
    # older than 180 s → REPLAY (and not adopted)
    with client.app.state.db.connect() as conn:
        conn.execute("UPDATE taps SET ts=ts-181 WHERE id=?", (tap_id,))
    assert client.post("/api/verify", json=_verify_body(_nonce(client), tap_id, token)).json()["verdict"] == "REPLAY"
    with client.app.state.db.connect() as conn:
        conn.execute("UPDATE taps SET ts=ts+181 WHERE id=?", (tap_id,))
        assert conn.execute("SELECT adopted_at FROM taps WHERE id=?", (tap_id,)).fetchone()[0] is None
    assert client.post("/api/verify", json=_verify_body(_nonce(client), tap_id, token)).json()["verdict"] == "VALID"


def test_only_valid_t_taps_get_a_token(client):
    # REPLAY on /t → redirect without k, and the tap cannot be adopted
    tag = client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    q = urlparse(tap["url"]).query
    assert client.get(f"/t?{q}", follow_redirects=False).status_code == 302
    r = client.get(f"/t?{q}", follow_redirects=False)
    loc = parse_qs(urlparse(r.headers["location"]).query)
    assert "k" not in loc
    assert client.get(f"/api/tap/{loc['tap'][0]}").json()["verdict"] == "REPLAY"
    # unregistered chip: /api/tap shows the uid (the web offers to attach it), no token either
    u = client.post("/api/dev/tap", json={"uid": "04FFEEDDCCBBAA"}).json()
    r = client.get(f"/t?{urlparse(u['url']).query}", follow_redirects=False)
    loc = parse_qs(urlparse(r.headers["location"]).query)
    assert "k" not in loc
    row = client.get(f"/api/tap/{loc['tap'][0]}").json()
    assert row["verdict"] == "UNREGISTERED" and row["uid"] == "04FFEEDDCCBBAA"
    # JSON mode hands the token to the tapper as well
    tap2 = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    j = client.get(tap2["url"] + "&format=json").json()
    assert j["verdict"] == "VALID" and len(j["tapToken"]) >= 20
    v = client.post("/api/verify", json=_verify_body(_nonce(client), j["tapId"], j["tapToken"])).json()
    assert v["verdict"] == "VALID"


def test_tap_view_with_malformed_stored_uid(client):
    # 14 chars that are not hex: /t no longer stores such a hit at all …
    r = client.get("/t?uid=ZZZZZZZZZZZZZZ&ctr=000001&cmac=0000000000000000", headers={"Accept": "application/json"})
    assert r.status_code == 200 and r.json()["verdict"] == "INVALID" and r.json()["tapId"] is None
    # … but a row like that from an older database must not make /api/tap 500
    with client.app.state.db.connect() as conn:
        tap_id = conn.execute("INSERT INTO taps(ts, source, uid_hex, ctr, cmac, verdict, serial, message) "
                              "VALUES(1, 't', 'ZZZZZZZZZZZZZZ', 1, NULL, 'INVALID', NULL, 'Seal not confirmed')").lastrowid
    row = client.get(f"/api/tap/{tap_id}")
    assert row.status_code == 200 and row.json()["uid"] is None and row.json()["uidHash"] is None
