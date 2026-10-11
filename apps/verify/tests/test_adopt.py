"""A tap consumed by /t can be adopted once by a scan session started afterwards (no second tap on the phone)."""
from urllib.parse import parse_qs, urlparse

SERIAL = "SN-2026-000001"


def _verify_body(nonce, tap_id, **over):
    b = {"tapId": tap_id, "nonce": nonce, "role": 0, "tier": 1, "indicators": {"heat": 3, "humidity": 3, "uv": 3},
         "heatLevels": [0, 0, 0, 0, 0, 0], "fill": 92, "platform": "IOS_WEB"}
    b.update(over)
    return b


def test_adopt_tap_from_t(client):
    tag = client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    q = urlparse(tap["url"]).query
    r = client.get(f"/t?{q}", follow_redirects=False)
    assert r.status_code == 302
    tap_id = int(parse_qs(urlparse(r.headers["location"]).query)["tap"][0])
    row = client.get(f"/api/tap/{tap_id}").json()
    assert row["verdict"] == "VALID" and row["counter"] == 1

    nonce = client.post("/api/session", json={}).json()["nonce"]
    v = client.post("/api/verify", json=_verify_body(nonce, tap_id)).json()
    assert v["verdict"] == "VALID" and v["counter"] == 1 and v["serial"] == SERIAL and v["serverSig"], v

    # second adoption of the same tap → REPLAY
    nonce2 = client.post("/api/session", json={}).json()["nonce"]
    v2 = client.post("/api/verify", json=_verify_body(nonce2, tap_id)).json()
    assert v2["verdict"] == "REPLAY"

    # unknown tap → INVALID
    nonce3 = client.post("/api/session", json={}).json()["nonce"]
    v3 = client.post("/api/verify", json=_verify_body(nonce3, 999999)).json()
    assert v3["verdict"] == "INVALID"
