"""Passport statistics count confirmed scans only (C2, onChainScanCount); the off-chain grade keeps VOID and C (M6,
the full rule is in test_grade_mirror.py)."""
import json

from fv.db import passport_stats, set_passport_grade
from tests.conftest import ADMIN, passport_pda, sig
from tests.test_chain import passport_bytes

SERIAL = "SN-2026-000001"
OWNER = "5VgGgiSB6Gq5ubpbVHMv2dKaKdoEq1wieuX4okHwtUeU"
MEDIA = "0x358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380"


def _verify(c, uid, **over):
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = c.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 0, "tier": 1,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [0, 0, 0, 0, 0, 0], "fill": 95,
            "attester": OWNER, "platform": "SIMULATOR"}
    body.update(over)
    v = c.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID", v
    return v


def _confirm(c, v, sig):
    c.rpc.scan_tx(sig, v, OWNER)
    e = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig, "actor": OWNER}).json()
    assert e["status"] == "confirmed", e
    return e


def _stats(c, serial=SERIAL):
    return c.get(f"/api/passport/{serial}").json()["stats"]


def test_pending_scans_never_count(chain_client):
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    before = _stats(c)
    listed_before = next(p for p in c.get("/api/passports").json() if p["serial"] == SERIAL)["scanCount"]
    v = _verify(c, tag["uid"], tier=2, mediaHash=MEDIA, attester="3Kd7cbs3aynm5a18JK3WWQS4HzCWdqHEXiPZ3xPr85in")
    assert _stats(c) == before                                               # pending: no scan, no attester, nothing certified
    assert next(p for p in c.get("/api/passports").json() if p["serial"] == SERIAL)["scanCount"] == listed_before
    with c.app.state.db.connect() as conn:                                   # a failed scan does not count either
        conn.execute("UPDATE events SET status='failed' WHERE id=?", (v["eventId"],))
    assert _stats(c) == before


def test_on_chain_scan_count(chain_client):
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    before = _stats(c)
    assert before["onChainScanCount"] == 0                                   # seeded demo scans are never on chain
    v1 = _verify(c, tag["uid"])
    _confirm(c, v1, sig("a"))                                                # anchored with its record_scan tx
    sighting = c.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    assert c.get(sighting["url"] + "&format=json").json()["verdict"] == "VALID"   # Tier-0 /t sighting: confirmed, off chain
    s = _stats(c)
    assert s["scanCount"] == before["scanCount"] + 2 and s["onChainScanCount"] == 1

    # a scan confirmed by the reconcile job without a signature (lookup failed) was still counted by the program
    v2 = _verify(c, tag["uid"])
    with c.app.state.db.connect() as conn:
        p = json.loads(conn.execute("SELECT payload_json FROM events WHERE id=?", (v2["eventId"],)).fetchone()[0])
        p["reconcile"] = {"scanPda": "SomePda"}
        conn.execute("UPDATE events SET status='confirmed', payload_json=? WHERE id=?", (json.dumps(p), v2["eventId"]))
    assert _stats(c)["onChainScanCount"] == 2


def test_certified_count_uses_the_on_chain_tier(client):
    with client.app.state.db.connect() as conn:
        before = passport_stats(conn, SERIAL)["certifiedCount"]
        row = conn.execute("SELECT id, payload_json FROM events WHERE serial=? AND type=2 AND status='confirmed' "
                           "AND json_extract(payload_json, '$.attester.tier') >= 3", (SERIAL,)).fetchone()
        p = json.loads(row["payload_json"])
        p["chain"] = {"tier": 0, "role": 0}                                  # claimed tier 4, anchored as tier 0
        conn.execute("UPDATE events SET payload_json=? WHERE id=?", (json.dumps(p), row["id"]))
        assert passport_stats(conn, SERIAL)["certifiedCount"] == before - 1


def test_set_passport_grade_keeps_c_and_void(client):
    with client.app.state.db.connect() as conn:
        grade = lambda: tuple(conn.execute("SELECT grade, void FROM passports WHERE serial=?", (SERIAL,)).fetchone())  # noqa: E731
        conn.execute("UPDATE passports SET grade=0, void=0 WHERE serial=?", (SERIAL,))
        set_passport_grade(conn, SERIAL, 2)
        assert grade() == (2, 0)
        set_passport_grade(conn, SERIAL, 0)                                  # a better-looking later scan never resets C
        assert grade() == (2, 0)
        set_passport_grade(conn, SERIAL, 4)                                  # an OPENED scan grades VOID → void flag
        assert grade() == (4, 1)
        set_passport_grade(conn, SERIAL, 0)
        assert grade() == (4, 1)


def test_heat_c_then_missing_scan_keeps_c_on_server_and_after_reconcile(chain_client):
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 0
    hot = _verify(c, tag["uid"], tier=2, mediaHash=MEDIA, indicators={"heat": 1, "humidity": 0, "uv": 3},
                  heatLevels=[1, 1, 1, 1, 1, 0], fill=95)
    assert hot["grade"] == 2
    _confirm(c, hot, sig("b"))
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 2
    # 'Without photo': both indicators MISSING, fill 95 → the scan itself grades A ...
    plain = _verify(c, tag["uid"], indicators={"heat": 3, "humidity": 3, "uv": 3})
    assert plain["grade"] == 0
    _confirm(c, plain, sig("c"))
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["grade"] == 2 and p["void"] is False                            # ... but the passport stays C
    # a chain that reports A after the second scan (the program before the sticky-grade upgrade): reconcile keeps C
    c.rpc.accounts[passport_pda(SERIAL)] = passport_bytes(grade=0, scan_count=2, void=False)
    c.post("/api/reconcile", headers=ADMIN)
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 2


def test_reconcile_never_clears_void(chain_client):
    c = chain_client
    serial = "SN-2026-000003"                                                # seeded VOID passport
    assert c.get(f"/api/passport/{serial}").json()["void"] is True
    c.rpc.accounts[passport_pda(serial)] = passport_bytes(grade=0, scan_count=3, void=False)
    c.post("/api/reconcile", headers=ADMIN)
    p = c.get(f"/api/passport/{serial}").json()
    assert p["void"] is True and p["grade"] == 4
    # and a chain void reaches a DB passport that was not void
    serial = "SN-2026-000002"
    c.rpc.accounts[passport_pda(serial)] = passport_bytes(grade=2, scan_count=3, void=True)
    c.post("/api/reconcile", headers=ADMIN)
    p = c.get(f"/api/passport/{serial}").json()
    assert p["void"] is True and p["grade"] == 4
