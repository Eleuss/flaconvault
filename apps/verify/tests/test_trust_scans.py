"""Signed scans: nothing anchorable is published before confirmation (resume token instead), claimed attesters /
tiers never count until the chain confirms them, the server never signs a client-chosen tamper, and one physical tap
counts once."""
import hashlib

from solders.pubkey import Pubkey

from fv import proof
from tests.conftest import ADMIN, PROGRAM_ID, registry_pda, sig
from tests.test_chain import registry_bytes

SERIAL = "SN-2026-000001"
PARTNER = "PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR"          # seeded label "Parfümerie X, Düsseldorf"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"
MALLORY = str(Pubkey.from_bytes(hashlib.sha256(b"mallory").digest()))
MEDIA = "0x358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380"


def _registry(c, partners):
    c.rpc.accounts[registry_pda()] = registry_bytes(partners=[Pubkey.from_string(p) for p in partners],
                                                    sites=[(1, "Parfümerie X, Düsseldorf")])
    c.app.state.registry_cache = None


def _scan(c, uid, *, status=200, **over):
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = c.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "mediaHash": MEDIA,
            "attester": SELLER, "platform": "SIMULATOR"}
    body.update(over)
    r = c.post("/api/verify", json=body)
    assert r.status_code == status, r.text
    return r.json()


def _tag(c):
    return c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()["uid"]


def _event(c, eid):
    return next(e for e in c.get(f"/api/passport/{SERIAL}").json()["events"] if e["id"] == eid)


# ---------- M3: nothing anchorable in public views; resume token ----------

def test_pending_scans_publish_nothing_that_could_be_anchored(chain_client):
    c = chain_client
    v = _scan(c, _tag(c))
    texts = [c.get(f"/api/passport/{SERIAL}").text, c.get("/api/passports").text, c.get(f"/api/attester/{SELLER}").text]
    for t in texts:
        assert v["msgHex"] not in t and v["serverSig"][2:] not in t and v["bundle"]["session"]["nonce"][2:] not in t
    e = _event(c, v["eventId"])
    assert e["payload"]["server"]["sig"] is None and e["payload"]["session"]["nonce"] is None and "msgHex" not in e["payload"]
    # failed scans neither
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE events SET status='failed' WHERE id=?", (v["eventId"],))
    assert v["serverSig"][2:] not in c.get(f"/api/passport/{SERIAL}").text


def test_resume_token_returns_the_signed_scan_while_pending(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _scan(c, _tag(c))
    token = v["resumeToken"]
    assert isinstance(token, str) and len(token) >= 20
    r = c.get(f"/api/verify/{v['eventId']}", params={"token": token})
    assert r.status_code == 200 and r.json() == {k: x for k, x in v.items() if k != "resumeToken"}
    # only its sha256 is stored
    with c.app.state.db.connect() as conn:
        stored = conn.execute("SELECT resume_hash FROM events WHERE id=?", (v["eventId"],)).fetchone()[0]
    assert stored == hashlib.sha256(token.encode()).hexdigest() and token not in c.get(f"/api/passport/{SERIAL}").text
    # wrong / missing token, another event, unknown event → 404 resume_not_found
    other = _scan(c, _tag(c))
    for path, params in ((f"/api/verify/{v['eventId']}", {"token": "x" * 22}), (f"/api/verify/{v['eventId']}", {}),
                         (f"/api/verify/{other['eventId']}", {"token": token}), ("/api/verify/987654321", {"token": token})):
        r = c.get(path, params=params)
        assert r.status_code == 404 and r.json()["detail"] == "resume_not_found", path
    # confirmed → the link is spent
    rpc.scan_tx(sig("rs1"), v, SELLER)
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("rs1")}).json()["status"] == "confirmed"
    assert c.get(f"/api/verify/{v['eventId']}", params={"token": token}).status_code == 404
    assert c.get("/api/verify/99999999999999999999", params={"token": token}).status_code == 422


# ---------- M4: claimed attester / tier ----------

def test_certified_tiers_need_a_registry_partner(chain_client):
    c = chain_client
    _registry(c, [PARTNER])
    uid = _tag(c)
    for over in ({"tier": 3}, {"tier": 4, "role": 4}, {"tier": 2, "role": 3}, {"tier": 1, "role": 4}):
        r = _scan(c, uid, status=403, **over)
        assert r["detail"] == "not_partner", over
    assert _scan(c, uid, status=403, tier=3, attester=None)["detail"] == "not_partner"
    # the tap was not consumed by the refusal: the same counter still verifies for the partner
    v = _scan(c, uid, tier=4, role=4, attester=PARTNER)
    assert v["verdict"] == "VALID"
    # without a readable chain registry nobody is a partner (seed data never decides when a program is configured)
    c.rpc.accounts.pop(registry_pda())
    c.app.state.registry_cache = None
    assert _scan(c, uid, status=403, tier=4, role=4, attester=PARTNER)["detail"] == "not_partner"


def test_claimed_attester_is_kept_out_of_actor_and_stats_until_confirmed(chain_client):
    c = chain_client
    _registry(c, [PARTNER])
    before = c.get(f"/api/passport/{SERIAL}").json()
    partner_before = c.get(f"/api/attester/{PARTNER}").json()
    v = _scan(c, _tag(c), tier=4, role=4, attester=PARTNER)
    e = _event(c, v["eventId"])
    assert e["actor"] is None and e["actorLabel"] is None and e["payload"]["attester"]["pubkey"] == PARTNER
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["stats"] == before["stats"]                                 # pending: not counted
    assert c.get(f"/api/attester/{PARTNER}").json()["recentSerials"] == partner_before["recentSerials"]


def test_confirmation_takes_attester_tier_and_role_from_the_chain(chain_client):
    """Mallory claims the partner at /api/verify; the partner's own tx anchors the scan as tier 0 (owner): never certified."""
    c, rpc = chain_client, chain_client.rpc
    _registry(c, [PARTNER])
    before = c.get(f"/api/passport/{SERIAL}").json()["stats"]
    v = _scan(c, _tag(c), tier=4, role=4, attester=PARTNER)
    rpc.scan_tx(sig("cf1"), v, PARTNER, tier=0, role=0)
    e = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("cf1")}).json()
    assert e["status"] == "confirmed" and e["actor"] == PARTNER and e["actorLabel"] == "Parfümerie X, Düsseldorf"
    assert e["payload"]["tier"] == 0 and e["payload"]["role"] == 0
    assert e["payload"]["confirmed"] == {"attester": PARTNER, "tier": 0, "role": 0, "siteId": 0, "source": "tx",
                                         "mismatch": ["tier", "role"]}
    after = c.get(f"/api/passport/{SERIAL}").json()["stats"]
    assert after["certifiedCount"] == before["certifiedCount"] and after["scanCount"] == before["scanCount"] + 1
    assert after["onChainScanCount"] == before["onChainScanCount"] + 1


def test_reconcile_with_another_signer_never_keeps_the_claimed_label_or_tier(chain_client):
    from fv.chain import pda_scan, pda_seal
    from tests.test_reconcile import _account_for
    c, rpc = chain_client, chain_client.rpc
    _registry(c, [PARTNER])
    before = c.get(f"/api/passport/{SERIAL}").json()["stats"]
    v = _scan(c, _tag(c), tier=4, role=4, attester=PARTNER)
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, v["counter"]))] = _account_for(v, attester=Pubkey.from_string(MALLORY), tier=0, role=0)
    assert c.post("/api/reconcile", headers=ADMIN).json()["confirmed"] == 1
    e = _event(c, v["eventId"])
    assert e["status"] == "confirmed" and e["actor"] == MALLORY and e["actorLabel"] is None
    assert e["payload"]["tier"] == 0 and "attester" in e["payload"]["confirmed"]["mismatch"]
    assert c.get(f"/api/passport/{SERIAL}").json()["stats"]["certifiedCount"] == before["certifiedCount"]
    assert c.get(f"/api/attester/{MALLORY}").json()["certifiedCount"] == 0


def test_confirm_needs_the_record_scan_signer(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _scan(c, _tag(c))
    # the claimed attester co-signed (fee payer), but record_scan's attester account is Mallory
    rpc.scan_tx(sig("cs1"), v, MALLORY)
    rpc.txs[sig("cs1")]["transaction"]["message"]["accountKeys"].insert(0, SELLER)
    rpc.txs[sig("cs1")]["transaction"]["message"]["header"]["numRequiredSignatures"] = 2
    for ix in rpc.txs[sig("cs1")]["transaction"]["message"]["instructions"]:
        ix["programIdIndex"] += 1
        ix["accounts"] = [i + 1 for i in ix["accounts"]]
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("cs1"), "actor": SELLER}).json()["detail"] == "tx_mismatch"
    # the claimed attester signed and appears in record_scan, but not as its attester account (position 4)
    from fv.txverify import b58decode
    good = rpc.txs[rpc.scan_tx(sig("cs2"), v, MALLORY)]
    keys = good["transaction"]["message"]["accountKeys"]
    ix = next(i for i in good["transaction"]["message"]["instructions"] if i["accounts"])
    accounts = [keys[i] for i in ix["accounts"]]
    accounts[5] = SELLER                                         # SELLER in the instructions-sysvar slot, MALLORY the attester
    rpc.add_tx(sig("cs3"), signers=[MALLORY, SELLER], instructions=[(PROGRAM_ID, "record_scan", accounts, b58decode(ix["data"])[8:])])
    r = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("cs3"), "actor": SELLER})
    assert r.status_code == 403 and r.json()["detail"] == "tx_mismatch"
    assert _event(c, v["eventId"])["status"] == "pending"


def test_partner_badge_comes_from_the_onchain_registry(chain_client):
    c = chain_client
    # seed data marks PARTNER as partner; the registry lists SELLER only
    _registry(c, [SELLER])
    assert c.get(f"/api/attester/{PARTNER}").json()["isPartner"] is False
    assert c.get(f"/api/attester/{SELLER}").json()["isPartner"] is True
    assert c.get("/api/attester/not-a-pubkey").status_code == 404


def test_raw_uids_of_older_rows_are_scrubbed_from_views(chain_client):
    """Rows written before uids were hashed (SEAL_ATTACH payload.uid, reports) never show the raw UID."""
    import json
    c = chain_client
    with c.app.state.db.connect() as conn:
        for t, status in ((1, "confirmed"), (9, "reported")):
            conn.execute("INSERT INTO events(serial, type, ts, status, payload_json) VALUES(?,?,?,?,?)",
                         (SERIAL, t, 1790000000, status, json.dumps({"uid": "0438380ABD2390", "kind": 1})))
    text = c.get(f"/api/passport/{SERIAL}").text
    assert "0438380ABD2390" not in text
    rows = [e for e in c.get(f"/api/passport/{SERIAL}").json()["events"] if e["ts"] == 1790000000]
    assert [e["payload"].get("uidTail") for e in rows] == ["…90", "…90"] and all("uid" not in e["payload"] for e in rows)


# ---------- M7: tamper ----------

def test_tamper_is_never_taken_from_the_client(chain_client):
    c = chain_client
    uid = _tag(c)
    for t in (0, 1, 2):
        v = _scan(c, uid, tamper=t)
        assert proof.parse_message(bytes.fromhex(v["msgHex"]))["tamper"] == 3 and v["bundle"]["tamper"] == 3
        assert v["grade"] == 0


# ---------- S12 / C2: one tap counts once; on-chain count ----------

def test_adopted_tap_counts_once(chain_client):
    from urllib.parse import parse_qs, urlparse
    c, rpc = chain_client, chain_client.rpc
    uid = _tag(c)
    before = c.get(f"/api/passport/{SERIAL}").json()["stats"]
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    loc = c.get(tap["url"], follow_redirects=False).headers["location"]
    q = parse_qs(urlparse(loc).query)
    nonce = c.post("/api/session", json={}).json()["nonce"]
    v = c.post("/api/verify", json={"tapId": int(q["tap"][0]), "tapToken": q["k"][0], "nonce": nonce, "role": 0, "tier": 1,
                                    "indicators": {"heat": 3, "humidity": 3, "uv": 3}, "heatLevels": [0] * 6, "fill": 92,
                                    "attester": SELLER}).json()
    assert v["verdict"] == "VALID"
    assert c.get(f"/api/passport/{SERIAL}").json()["stats"]["scanCount"] == before["scanCount"] + 1     # the /t sighting
    rpc.scan_tx(sig("ad1"), v, SELLER)
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("ad1")}).json()["status"] == "confirmed"
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["stats"]["scanCount"] == before["scanCount"] + 1                  # the signed scan replaced the sighting
    same_tap = [e for e in p["events"] if e["type"] == 2 and e["sealUidHash"] == v["uidHash"] and e["payload"].get("counter") == v["counter"]]
    assert [e["id"] for e in same_tap] == [v["eventId"]]


def test_list_counts_confirmed_scans_only(chain_client):
    c = chain_client
    n = next(p for p in c.get("/api/passports").json() if p["serial"] == SERIAL)["scanCount"]
    _scan(c, _tag(c))
    assert next(p for p in c.get("/api/passports").json() if p["serial"] == SERIAL)["scanCount"] == n
