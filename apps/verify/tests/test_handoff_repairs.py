"""Verifier handoffs of the previous round: a MINT event for an existing passport shows the names the passport keeps, and
a scan the reconcile job confirms drops its resume token like one confirmed by POST /api/events."""
from fv.chain import pda_scan, pda_seal
from tests.conftest import ADMIN, PROGRAM_ID, sig
from tests.test_reconcile import _account_for, _scan

SN2 = "SN-2026-000002"


def test_a_mint_for_an_existing_passport_without_a_mint_stores_the_kept_names(chain_client):
    c = chain_client
    with c.app.state.db.connect() as conn:                       # e.g. what an older purge-seed build left behind
        conn.execute("DELETE FROM events WHERE serial=? AND type=0", (SN2,))
        before = dict(conn.execute("SELECT brand, name, batch, issuer FROM passports WHERE serial=?", (SN2,)).fetchone())
    assert before["issuer"]
    c.rpc.mint_tx(sig("issuer-mint-replayed"), SN2, before["issuer"])  # the issuer's public mint tx, posted by anyone
    r = c.post("/api/events", json={"serial": SN2, "type": "MINT", "txSig": sig("issuer-mint-replayed"),
                                    "actor": before["issuer"],
                                    "payload": {"brand": "FAKE", "name": "COUNTERFEIT - do not buy", "batch": "X"}})
    assert r.status_code == 200, r.text
    payload = r.json()["payload"]
    assert (payload["brand"], payload["name"]) == (before["brand"], before["name"])
    assert payload.get("batch") == before["batch"] and "FAKE" not in r.text and "COUNTERFEIT" not in r.text
    p = c.get(f"/api/passport/{SN2}").json()
    assert (p["brand"], p["name"], p["batch"]) == (before["brand"], before["name"], before["batch"])
    mint = next(e for e in p["events"] if e["type"] == 0)
    assert mint["payload"]["name"] == before["name"]


def test_a_mint_for_a_new_serial_keeps_the_issuers_names(chain_client):
    c = chain_client
    issuer = "3Kd7cbs3aynm5a18JK3WWQS4HzCWdqHEXiPZ3xPr85in"
    c.rpc.mint_tx(sig("new-mint"), "SN-2026-000077", issuer)
    r = c.post("/api/events", json={"serial": "SN-2026-000077", "type": "MINT", "txSig": sig("new-mint"), "actor": issuer,
                                    "payload": {"brand": "Amouage", "name": "Interlude Man", "batch": "AM01"}})
    assert r.status_code == 200, r.text
    assert {k: r.json()["payload"][k] for k in ("brand", "name", "batch")} == {"brand": "Amouage", "name": "Interlude Man",
                                                                               "batch": "AM01"}


def test_a_scan_the_reconcile_job_confirms_drops_its_resume_token(chain_client):
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    v = _scan(c, tag["uid"])
    assert c.get(f"/api/verify/{v['eventId']}?token={v['resumeToken']}").status_code == 200
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, v["counter"]))] = _account_for(v)
    assert c.post("/api/reconcile", headers=ADMIN).json()["confirmed"] == 1
    with c.app.state.db.connect() as conn:
        row = conn.execute("SELECT status, resume_hash FROM events WHERE id=?", (v["eventId"],)).fetchone()
    assert tuple(row) == ("confirmed", None)
    r = c.get(f"/api/verify/{v['eventId']}?token={v['resumeToken']}")
    assert r.status_code == 404 and r.json()["detail"] == "resume_not_found"
