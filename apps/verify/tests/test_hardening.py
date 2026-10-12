"""Safe defaults and plumbing of the security hardening: DB migration, base58/discriminators, getTransaction params,
admin-gated reconcile (RPC outside the write transaction), constant-time MACs, seal counter seeding, wording."""
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from fv import strings
from fv.db import Database
from tests.conftest import ADMIN, PROGRAM_ID, REPO

OLD_SCHEMA = """
CREATE TABLE passports (serial TEXT PRIMARY KEY, serial_hash TEXT NOT NULL UNIQUE, brand TEXT NOT NULL, name TEXT NOT NULL,
  batch TEXT, asset TEXT, issuer TEXT, issuer_label TEXT, grade INTEGER NOT NULL DEFAULT 0, void INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial        TEXT NOT NULL REFERENCES passports(serial) ON DELETE CASCADE,
  type          INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  actor_pubkey  TEXT,
  actor_label   TEXT,
  tx_sig        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
  seal_uid_hash TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  ar_bundle     TEXT,
  ar_media      TEXT,
  grade_after   INTEGER,
  country       TEXT,
  city          TEXT
);
CREATE INDEX events_serial_ts ON events(serial, ts);
CREATE TABLE taps (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 't', uid_hex TEXT,
  ctr INTEGER, cmac TEXT, verdict TEXT NOT NULL, serial TEXT, message TEXT NOT NULL);
"""


def test_migration_of_an_existing_database(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript(OLD_SCHEMA)
    conn.execute("INSERT INTO passports(serial, serial_hash, brand, name, created_at) VALUES('S1', 'h1', 'B', 'N', 1)")
    for i in range(3):
        conn.execute("INSERT INTO events(serial, type, ts, status) VALUES('S1', 2, ?, 'confirmed')", (i,))
    conn.execute("DELETE FROM events WHERE id=3")             # AUTOINCREMENT must not hand out id 3 again
    conn.execute("INSERT INTO taps(ts, verdict, message) VALUES(1, 'VALID', 'm')")
    conn.commit()
    conn.close()

    db = Database(path)
    db.init()
    db.init()                                                  # idempotent
    with db.connect() as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(taps)")}
        assert {"adopt_hash", "adopted_at"} <= cols
        assert [r["id"] for r in c.execute("SELECT id FROM events ORDER BY id")] == [1, 2]
        c.execute("INSERT INTO events(serial, type, ts, status) VALUES('S1', 9, 5, 'reported')")
        assert c.execute("SELECT MAX(id) FROM events").fetchone()[0] == 4
        with pytest.raises(sqlite3.IntegrityError):
            c.execute("INSERT INTO events(serial, type, ts, status) VALUES('S1', 9, 5, 'bogus')")
        idx = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")}
        assert {"events_serial_ts", "events_actor"} <= idx
        assert c.execute("SELECT adopt_hash FROM taps").fetchone()[0] is None


def test_base58_roundtrip_and_pubkeys():
    from fv.txverify import b58decode, b58encode, is_pubkey
    for b in (b"", b"\x00", b"\x00\x00\x01", hashlib.sha256(b"x").digest(), bytes(64)):
        assert b58decode(b58encode(b)) == b
    assert b58encode(bytes(32)) == "11111111111111111111111111111111"
    assert is_pubkey(PROGRAM_ID) and not is_pubkey("0OIl") and not is_pubkey("") and not is_pubkey(None)
    with pytest.raises(ValueError):
        b58decode("0")


def test_discriminators_match_the_idls():
    """sha256("global:<name>")[:8] — checked against the Anchor IDLs when the programs were built locally."""
    from fv.txverify import ESCROW_IX, FLACON_IX, anchor_discriminator
    idls = {name: REPO / "target" / "idl" / f"{name}.json" for name in ("flacon", "escrow")}
    if not all(p.exists() for p in idls.values()):
        pytest.skip("target/idl not built")
    for name, table in (("flacon", FLACON_IX), ("escrow", ESCROW_IX)):
        idl = json.loads(idls[name].read_text())
        by_name = {ix["name"]: bytes(ix["discriminator"]) for ix in idl["instructions"]}
        for ixs in table.values():
            for ix in ixs:
                assert by_name[ix] == anchor_discriminator(ix), (name, ix)
    assert json.loads(idls["escrow"].read_text())["address"] == "9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL"


def test_rpc_get_transaction_params(monkeypatch):
    import httpx
    from fv.chain import Rpc

    sent = {}

    class Resp:
        def raise_for_status(self): pass
        def json(self): return {"jsonrpc": "2.0", "id": 1, "result": None}

    def fake_post(url, json=None, timeout=None):
        sent.update(json)
        return Resp()
    monkeypatch.setattr(httpx, "post", fake_post)
    assert Rpc("http://127.0.0.1:8899").get_transaction("5" * 88) is None
    assert sent["method"] == "getTransaction"
    assert sent["params"] == ["5" * 88, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}]


def test_reconcile_endpoint_needs_the_admin_token(chain_client, settings):
    c = chain_client
    assert c.post("/api/reconcile").status_code == 403
    assert c.post("/api/reconcile", headers={"x-admin-token": "nope"}).status_code == 403
    assert c.post("/api/reconcile", headers=ADMIN).status_code == 200


def test_reconcile_endpoint_disabled_without_env(settings):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    settings.admin_token = ""
    with TestClient(create_app(settings)) as c:
        assert c.post("/api/reconcile").status_code == 403
        assert c.post("/api/reconcile", headers={"x-admin-token": ""}).status_code == 403


def test_reconcile_reads_chain_outside_the_write_transaction(chain_client, settings):
    """Every RPC call of a cycle must be able to take the SQLite write lock itself, i.e. reconcile does not hold it."""
    from tests.test_reconcile import _account_for, _scan
    from fv.chain import pda_scan, pda_seal
    from fv.reconcile import reconcile_once
    c, rpc = chain_client, chain_client.rpc
    tag = c.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    v = _scan(c, tag["uid"])
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, v["counter"]))] = _account_for(v)
    probes = []

    def lock_free():
        probe = sqlite3.connect(settings.db_path, timeout=0, isolation_level=None)
        try:
            probe.execute("BEGIN IMMEDIATE")
            probe.execute("ROLLBACK")
            probes.append(True)
        except sqlite3.OperationalError:
            probes.append(False)
        finally:
            probe.close()

    for name in ("get_multiple_accounts", "get_signatures_for_address"):
        real = getattr(rpc, name)
        setattr(rpc, name, (lambda real: lambda *a, **k: (lock_free(), real(*a, **k))[1])(real))
    s = reconcile_once(c.app.state.db, settings, rpc)
    assert s["confirmed"] == 1 and len(probes) >= 3 and all(probes), probes


def test_reconcile_confirmation_applies_grade_and_attester(chain_client):
    from tests.test_reconcile import _account_for, _scan
    from fv.chain import pda_scan, pda_seal
    from solders.pubkey import Pubkey
    c, rpc = chain_client, chain_client.rpc
    other = str(Pubkey.from_bytes(hashlib.sha256(b"other").digest()))
    tag = c.post("/api/dev/tag", json={"serial": "SN-2026-000001", "kind": 1}).json()
    v = _scan(c, tag["uid"], fill=70)                          # grade B, client claims the seeded SELLER as attester
    assert v["grade"] == 1 and c.get("/api/passport/SN-2026-000001").json()["grade"] == 0
    seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
    rpc.accounts[str(pda_scan(PROGRAM_ID, seal, v["counter"]))] = _account_for(v, attester=Pubkey.from_string(other))
    c.post("/api/reconcile", headers=ADMIN)
    p = c.get("/api/passport/SN-2026-000001").json()
    ev = next(e for e in p["events"] if e["id"] == v["eventId"])
    assert ev["status"] == "confirmed" and ev["actor"] == other and p["grade"] == 1
    assert c.get(f"/api/attester/{other}").json()["scanCount"] == 1           # the on-chain signer, not the claim


def test_libsdm_uses_constant_time_mac_comparison(monkeypatch):
    import libsdm.sdm as ls
    from fv import sdm
    calls = []
    real = ls.hmac.compare_digest
    monkeypatch.setattr(ls.hmac, "compare_digest", lambda a, b: calls.append(1) or real(a, b))
    uid, key = bytes.fromhex("04A1B2C3D4E5F6"), bytes(16)
    mac = sdm.sdm_cmac(uid, 7, key)
    assert sdm.validate_tap(uid, 7, mac, key) and not sdm.validate_tap(uid, 7, bytes(8), key)
    assert sdm.decrypt_tap("factory", bytes(16), bytes.fromhex("EF963FF7828658A599F3041510671E88"),
                           bytes.fromhex("94EED9EE65337086"), None) is not None
    assert len(calls) == 3
    src = Path(ls.__file__).read_text()
    assert "sdmmac != " not in src


def test_dev_tag_attach_seeds_the_counter(client):
    # a virtual chip tapped while unregistered, then attached through the simulator: the old URL stays a replay
    client.post("/api/dev/tag", json={"uid": "04ABABABABABAB"})
    tap = client.post("/api/dev/tap", json={"uid": "04ABABABABABAB"}).json()
    assert client.get(tap["url"] + "&format=json").json()["verdict"] == "UNREGISTERED"
    t = client.post("/api/dev/tag", json={"uid": "04ABABABABABAB", "serial": "SN-2026-000002"}).json()
    assert t["sealLastCounter"] == tap["ctr"]
    assert client.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()["verdict"] == "REPLAY"


def test_wording():
    assert strings.NOT_OPENED == "Seal responding · no break recorded"
    assert strings.ORIGIN_DOCUMENTED == "Registered by a partner"
