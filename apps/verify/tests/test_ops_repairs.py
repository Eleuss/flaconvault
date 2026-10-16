"""Verifier operations repairs (second review round): confirmation order and the grade (M6), the reconcile job's
creating signature (S8/M10), the Arweave queue (S8/S15), purge-seed and the leftover-seed warning (M1/M2), the
simulator escape hatch (M11) and the escrow counters after close_order (S10)."""
import io

import pytest
from fastapi.testclient import TestClient

import fv.arweave as aw
import fv.reconcile as rc
from fv import proof
from fv.config import Settings, is_local_rpc
from fv.main import create_app
from tests.conftest import (ADMIN, ESCROW_ID, PROGRAM_ID, SYSTEM_PROGRAM, TEST_SEED_HEX, FakeRpc, encode_event, fake_key,
                            order_bytes, order_pda, passport_pda, post_media, program_logs, registry_pda, sig)
from tests.test_chain import registry_bytes
from tests.test_purge_seed import REAL_ISSUER, SEED_PARTNER, _chain_like_production
from tests.test_reconcile import _account_for, _scan
from tests.test_reconcile_robust import _event, _reconcile, _scan_pda
from tests.test_stats_grade import MEDIA, SERIAL, _confirm, _verify


# ---------- M6: the grade does not depend on the order in which confirmations arrive ----------

def test_an_older_c_scan_confirmed_after_a_newer_clean_scan_still_lowers_the_grade(chain_client):
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 0
    hot = _verify(c, tag["uid"], tier=2, mediaHash=MEDIA, indicators={"heat": 1, "humidity": 0, "uv": 3},
                  heatLevels=[1, 1, 1, 1, 1, 0], fill=95)
    plain = _verify(c, tag["uid"])                         # signed after the hot one (newer ts / id), grades A
    assert (hot["grade"], plain["grade"]) == (2, 0)
    _confirm(c, plain, sig("m6-plain"))                    # the newer clean scan is confirmed first ...
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 0
    _confirm(c, hot, sig("m6-hot"))                        # ... the older C arrives late (lost / retried confirm POST)
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["grade"] == 2 and p["void"] is False


# ---------- M11: the simulator escape hatch and the registered signing key ----------


REAL_MASTER = "00112233445566778899aabbccddeeff"      # obviously fake test value, non-zero


def test_local_rpc_detection():
    for url in ("http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899", "http://validator.localhost:8899",
                "http://127.0.0.2:8899"):
        assert is_local_rpc(url), url
    for url in ("https://api.devnet.solana.com", "http://127.0.0.1.evil.test:8899", "http://localhost.evil.test",
                "https://rpc.example.test/?u=127.0.0.1", "", "not a url"):
        assert not is_local_rpc(url), url


def test_allow_sim_with_real_keys_only_against_a_local_validator():
    def s(**kw) -> Settings:
        return Settings(server_seed_hex="11" * 32, key_mode="sdmbackend", master_key_hex=REAL_MASTER, dev_simulator=True,
                        allow_sim_with_real_keys=True, **kw)
    s().check_startup()                                                          # no program id: nothing to anchor on
    s(program_id=PROGRAM_ID, solana_rpc="http://127.0.0.1:8899").check_startup()  # local test validator
    with pytest.raises(RuntimeError, match="only accepted against a local validator"):
        s(program_id=PROGRAM_ID, solana_rpc="https://api.devnet.solana.com").check_startup()
    with pytest.raises(RuntimeError, match="only accepted against a local validator"):
        s(program_id=PROGRAM_ID).check_startup()                                  # the default RPC is public devnet
    # the refusal without the flag no longer recommends the flag as the way out
    with pytest.raises(RuntimeError) as exc:
        Settings(server_seed_hex="11" * 32, key_mode="sdmbackend", master_key_hex=REAL_MASTER, dev_simulator=True).check_startup()
    assert "only for tests against a local validator" in str(exc.value) and "never together with the production" in str(exc.value)


def _registry_with(pub_hex: str, valid_to: int = 0) -> bytes:
    return registry_bytes(keys=[{"keyId": 1, "pubkeyHex": pub_hex, "validFrom": 0, "validTo": valid_to}])


def _app(settings, rpc):
    app = create_app(settings)
    app.state.rpc = rpc
    return app


SERVER_PUB = proof.public_key(bytes.fromhex(TEST_SEED_HEX)).hex()


def test_simulator_refuses_a_signing_key_that_is_registered_on_the_cluster(settings):
    settings.program_id = PROGRAM_ID                                              # public devnet RPC (the default)
    rpc = FakeRpc()
    rpc.accounts[registry_pda()] = _registry_with(SERVER_PUB)                     # key 1, never expires
    with pytest.raises(RuntimeError, match="registered server key 1"):
        with TestClient(_app(settings, rpc)):
            pass
    # an expired registration, another key, or a local validator: the simulator starts
    for data, rpc_url in ((_registry_with(SERVER_PUB, valid_to=1_000_000), settings.solana_rpc),
                          (_registry_with("ab" * 32), settings.solana_rpc),
                          (_registry_with(SERVER_PUB), "http://127.0.0.1:8899")):
        settings.solana_rpc = rpc_url
        rpc.accounts[registry_pda()] = data
        with TestClient(_app(settings, rpc)) as c:
            assert c.get("/health").json()["simulator"] is True
    # the simulator off (production): the registered key is the point, no check
    settings.solana_rpc = "https://api.devnet.solana.com"
    settings.dev_simulator, settings.key_mode, settings.master_key_hex = False, "sdmbackend", REAL_MASTER
    rpc.accounts[registry_pda()] = _registry_with(SERVER_PUB)
    with TestClient(_app(settings, rpc)):
        pass


def test_simulator_key_check_falls_back_to_the_cached_registry(settings, caplog):
    from fv.chain import RpcError
    from fv.db import Database, set_chain_state

    class DownRpc(FakeRpc):
        def get_account_info(self, pubkey):
            raise RpcError("getAccountInfo: 429 Too Many Requests")

    settings.program_id = PROGRAM_ID
    db = Database(settings.db_path)
    db.init()
    caplog.set_level("ERROR", logger="fv")
    with TestClient(_app(settings, DownRpc())):                                   # nothing cached: starts, but says so
        pass
    assert any("NOT checked" in r.getMessage() for r in caplog.records)
    with db.connect() as conn:                                                    # what the reconcile job stored earlier
        set_chain_state(conn, "registry", {"programId": PROGRAM_ID, "serverKeys": [
            {"keyId": 1, "pubkeyHex": SERVER_PUB, "validFrom": 0, "validTo": 0}], "partners": [], "sites": []}, 1)
    with pytest.raises(RuntimeError, match="registered server key 1"):
        with TestClient(_app(settings, DownRpc())):
            pass
    with db.connect() as conn:                                                    # a cache of another program does not count
        set_chain_state(conn, "registry", {"programId": "11111111111111111111111111111111", "serverKeys": [
            {"keyId": 1, "pubkeyHex": SERVER_PUB, "validFrom": 0, "validTo": 0}]}, 1)
    with TestClient(_app(settings, DownRpc())):
        pass


# ---------- S8 / M10: the creating signature the reconcile job stores is verified ----------


ATTACKER = fake_key("prefunder")


def _transfer(rpc, s: str, to: str) -> str:
    """A plain SOL transfer (System Program) to `to`: what pre-funds or dusts a predictable PDA."""
    return rpc.add_tx(s, signers=[ATTACKER], instructions=[(SYSTEM_PROGRAM, "", [ATTACKER, to], b"\x02\x00\x00\x00" + b"\x40" * 8)])


def _anchored(c, **over):
    """A signed scan whose ScanProof exists on chain (the client's confirm POST never arrived)."""
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _scan(c, tag["uid"], **over)
    c.rpc.accounts[_scan_pda(v)] = _account_for(v)
    return v


def test_a_prefunding_transfer_is_never_stored_as_the_scans_signature(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _anchored(c)
    attester = v["bundle"]["attester"]["pubkey"]
    # the attacker funded scanPda(seal, counter) before record_scan created it: the transfer is the OLDER signature
    _transfer(rpc, sig("prefund"), _scan_pda(v))
    rpc.scan_tx(sig("creator"), v, attester)
    rpc.signatures[_scan_pda(v)] = [sig("creator"), sig("prefund")]            # newest first
    assert _reconcile(c)["confirmed"] == 1
    e = _event(c, v["eventId"])
    assert e["status"] == "confirmed" and e["txSig"] == sig("creator")
    # the client's late confirm with the real record_scan is an idempotent 200, not 409 event_confirmed
    r = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("creator"), "actor": attester})
    assert r.status_code == 200 and r.json()["txSig"] == sig("creator")


def test_no_qualifying_signature_leaves_the_tx_empty_until_the_client_fills_it(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _anchored(c)
    attester = v["bundle"]["attester"]["pubkey"]
    other = _anchored(c)                                                       # a record_scan of another ScanProof
    rpc.scan_tx(sig("other-scan"), other, attester)
    for i in range(3):                                                         # dust after the creation fills the window
        _transfer(rpc, sig(f"dust{i}"), _scan_pda(v))
    rpc.signatures[_scan_pda(v)] = [sig("dust2"), sig("dust1"), sig("dust0"), sig("other-scan"), "U" * 88]   # U: unreadable
    assert _reconcile(c)["confirmed"] >= 1
    e = _event(c, v["eventId"])
    assert e["status"] == "confirmed" and e["txSig"] is None                   # no explorer link to a plain transfer
    rpc.scan_tx(sig("real"), v, attester)                                      # the client posts the real one later
    r = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("real"), "actor": attester})
    assert r.status_code == 200 and _event(c, v["eventId"])["txSig"] == sig("real")
    # a transfer is refused as the confirmation of the (now signed) event
    _transfer(rpc, sig("late-dust"), _scan_pda(v))
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("late-dust"), "actor": attester}).status_code == 409


def test_a_recovered_failed_scan_never_keeps_the_clients_failed_tx(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _anchored(c)
    with c.app.state.db.connect() as conn:                                     # what _confirm_event does on tx_failed
        conn.execute("UPDATE events SET status='failed', tx_sig=? WHERE id=?", ("F" * 88, v["eventId"]))
    _transfer(rpc, sig("only-transfer"), _scan_pda(v))
    rpc.signatures[_scan_pda(v)] = [sig("only-transfer")]
    s = _reconcile(c)
    assert s["recovered"] == 1
    e = _event(c, v["eventId"])
    assert e["status"] == "confirmed" and e["txSig"] is None


def test_a_record_scan_signed_by_someone_else_is_not_the_creator(chain_client):
    """The ScanProof's attester is record_scan's signer: a tx naming the PDA with another signer cannot be the creator."""
    c, rpc = chain_client, chain_client.rpc
    v = _anchored(c)
    rpc.scan_tx(sig("foreign"), v, ATTACKER)                                  # e.g. a failed front-run that the RPC lists
    rpc.signatures[_scan_pda(v)] = [sig("foreign")]
    _reconcile(c)
    assert _event(c, v["eventId"])["txSig"] is None


# ---------- S8 / S15: the Arweave queue never blocks on one row, and no request uploads ----------


FRAMES = [b"\xff\xd8ops-frame-1" * 40, b"\xff\xd8ops-frame-2" * 40]


class SelectiveSidecar:
    """`node upload.mjs` stand-in that refuses the uploads `refuse(tags)` returns an ArweaveError for."""

    def __init__(self, refuse=lambda tags: None):
        self.calls: list[dict] = []
        self.refuse = refuse

    def __call__(self, args, settings):
        tags = dict(a.split("=", 1) for i, a in enumerate(args) if i and args[i - 1] == "--tag")
        self.calls.append(tags)
        err = self.refuse(tags)
        if err:
            raise err
        id_ = f"OPS{len(self.calls):03d}" + "y" * 37
        return {"id": id_, "url": f"https://gateway.irys.xyz/{id_}", "ar": f"ar://{id_}", "bytes": 1}


def _unpaid_media(tags):
    if tags.get("App-Type") in ("seal-frames", "seal-frame-preview"):     # paid uploads fail, ~2 KB bundles are free
        return aw.ArweaveError("irys-sidecar: insufficient Irys balance: have 0 SOL", "insufficient_balance")
    return None


@pytest.fixture()
def ar_on(chain_client, settings, monkeypatch):
    aw.reset_status()
    settings.arweave, settings.irys_key = True, "default"
    yield chain_client
    aw.reset_status()


def _confirmed(c, uid, s, *, media: bool):
    """A scan confirmed through POST /api/events (with uploaded media under its session nonce, or tier 1 without)."""
    nonce = c.post("/api/session", json={}).json()["nonce"]
    over = {"nonce": nonce, "tier": 1, "mediaHash": None}
    if media:
        files = [("files", (f"f{i}.jpg", io.BytesIO(b + s.encode()), "image/jpeg")) for i, b in enumerate(FRAMES)]
        over.update(tier=2, mediaHash=post_media(c, files=files, nonce=nonce).json()["sha256"])
    v = _scan(c, uid, **over)
    c.rpc.scan_tx(sig(s), v, v["bundle"]["attester"]["pubkey"])
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig(s)}).json()["status"] == "confirmed"
    return v


def _ar(c, v):
    e = _event(c, v["eventId"])
    return e["arBundle"], e["arMedia"]


def test_unpayable_media_never_blocks_the_bundles(ar_on, monkeypatch):
    c = ar_on
    sidecar = SelectiveSidecar(_unpaid_media)
    monkeypatch.setattr(aw, "_run_sidecar", sidecar)
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    older = _confirmed(c, tag["uid"], "hol-old", media=False)
    newer = _confirmed(c, tag["uid"], "hol-new", media=True)                 # the newest row of the queue
    assert sidecar.calls == []                                               # confirm requests never upload
    s = _reconcile(c)["arweave"]
    assert s == {"attempted": 2, "archived": 2, "failed": 0, "mediaFailed": 1, "skipped": None}
    assert _ar(c, newer)[0].startswith("ar://OPS") and _ar(c, newer)[1] is None   # bundle archived, media not (yet)
    assert _ar(c, older)[0].startswith("ar://OPS")
    real_now = rc.now
    for k in range(1, 4):                                                    # later cycles: only the media is retried
        monkeypatch.setattr(rc, "now", lambda k=k: real_now() + k * aw.ROW_BACKOFF_MAX_S)
        n = len(sidecar.calls)
        s = _reconcile(c)["arweave"]
        assert s["attempted"] == 1 and s["mediaFailed"] == 1 and s["skipped"] is None
        assert [t["App-Type"] for t in sidecar.calls[n:]] == ["seal-frames"]  # never the archived bundles again
    # the balance gets topped up: the media goes through, nothing is left
    sidecar.refuse = lambda tags: None
    monkeypatch.setattr(rc, "now", lambda: real_now() + 5 * aw.ROW_BACKOFF_MAX_S)
    assert _reconcile(c)["arweave"]["mediaFailed"] == 0
    assert _ar(c, newer)[1].startswith("https://gateway.irys.xyz/OPS")
    monkeypatch.setattr(rc, "now", lambda: real_now() + 6 * aw.ROW_BACKOFF_MAX_S)
    assert _reconcile(c)["arweave"]["attempted"] == 0


def test_a_row_that_keeps_failing_goes_to_the_back_of_the_queue(ar_on, monkeypatch, settings):
    c = ar_on
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    bad = _confirmed(c, tag["uid"], "bad", media=False)
    bad_hash = bad["bundleHash"][2:]
    sidecar = SelectiveSidecar(lambda t: aw.ArweaveError("irys: 400 bad request") if t.get("FV-Bundle-Hash") == bad_hash
                               else None)
    monkeypatch.setattr(aw, "_run_sidecar", sidecar)
    good = _confirmed(c, tag["uid"], "good", media=False)
    with c.app.state.db.connect() as conn:
        t0 = 1_800_000_000
        assert aw.backfill(conn, settings, limit=1, now_ts=t0)["archived"] == 1            # newest first: good
        assert aw.backfill(conn, settings, limit=5, now_ts=t0)["failed"] == 1              # bad fails, recorded
        q = conn.execute("SELECT attempts, last_error FROM arweave_queue WHERE event_id=?", (bad["eventId"],)).fetchone()
        assert tuple(q) == (1, "upload_failed")
        assert aw.backfill(conn, settings, limit=5, now_ts=t0 + 1)["attempted"] == 0       # not due yet
    newest = _confirmed(c, tag["uid"], "newest", media=False)
    with c.app.state.db.connect() as conn:
        due = t0 + aw.row_backoff_s(1)
        assert aw.backfill(conn, settings, limit=1, now_ts=due) == {"attempted": 1, "archived": 1, "failed": 0,
                                                                     "mediaFailed": 0, "skipped": None}
    assert _ar(c, newest)[0] and _ar(c, good)[0] and _ar(c, bad)[0] is None   # the fresh row went before the failing one
    assert aw.row_backoff_s(1) < aw.row_backoff_s(2) < aw.row_backoff_s(30) == aw.ROW_BACKOFF_MAX_S


def test_a_global_failure_stops_the_cycle_and_backs_off(ar_on, monkeypatch):
    c = ar_on
    sidecar = SelectiveSidecar(lambda t: aw.ArweaveError("sidecar timed out after 60s", "timeout"))
    monkeypatch.setattr(aw, "_run_sidecar", sidecar)
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    for k in range(3):
        _confirmed(c, tag["uid"], f"down{k}", media=False)
    s = _reconcile(c)["arweave"]
    assert s["attempted"] == 1 and s["failed"] == 1 and len(sidecar.calls) == 1   # nothing else would get through either
    assert _reconcile(c)["arweave"]["skipped"] == "backoff" and len(sidecar.calls) == 1


def test_scans_the_reconcile_job_confirms_wait_while_arweave_is_in_backoff(ar_on, monkeypatch):
    c = ar_on
    sidecar = SelectiveSidecar()
    monkeypatch.setattr(aw, "_run_sidecar", sidecar)
    aw._record_error(aw.ArweaveError("sidecar timed out after 60s", "timeout"))   # Irys was down a moment ago
    v = _anchored(c)
    s = _reconcile(c)
    assert s["confirmed"] == 1 and s["arweave"]["skipped"] == "backoff" and sidecar.calls == []
    aw.reset_status()
    assert _reconcile(c)["arweave"]["archived"] == 1 and _ar(c, v)[0].startswith("ar://OPS")


# ---------- M1 with M2: purge-seed never leaves an on-chain passport without a MINT; the startup warning clears ----------

SN2 = "SN-2026-000002"                                  # seed-only rows, but the passport exists on devnet


def _purge(c, dry_run=False) -> dict:
    r = c.post(f"/api/admin/purge-seed?dry_run={'true' if dry_run else 'false'}", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def _replay_mint(c, actor: str, tag: str):
    c.rpc.mint_tx(sig(tag), SN2, actor)                                       # the issuer's public mint tx, replayed
    return c.post("/api/events", json={"serial": SN2, "type": "MINT", "txSig": sig(tag), "actor": actor,
                                       "payload": {"brand": "FAKE", "name": "COUNTERFEIT - do not buy", "batch": "X"}})


def test_after_a_purge_a_replayed_issuer_mint_cannot_rename_the_passport(chain_client):
    c = chain_client
    _chain_like_production(c)
    rep = _purge(c, dry_run=True)
    assert [m["serial"] for m in rep["mintFromChain"]] == [SN2]               # reported by the dry run ...
    assert c.get(f"/api/passport/{SN2}").json()["events"][0]["payload"].get("seed") is True   # ... which changes nothing
    _purge(c)
    before = c.get(f"/api/passport/{SN2}").json()
    assert (before["brand"], before["name"]) == ("Guerlain", "Shalimar Parfum (1970s)")
    r = _replay_mint(c, str(REAL_ISSUER), "replay-issuer")
    assert r.status_code == 200 and r.json()["payload"]["fromChain"] is True  # the stored MINT comes back
    after = c.get(f"/api/passport/{SN2}").json()
    assert (after["brand"], after["name"], after["batch"]) == (before["brand"], before["name"], before["batch"])
    assert [e["id"] for e in after["events"]] == [e["id"] for e in before["events"]]
    assert _replay_mint(c, SEED_PARTNER, "replay-stranger").json()["detail"] == "not_issuer"


def test_the_rebuilt_mint_carries_the_verified_creating_signature(chain_client):
    c, rpc = chain_client, chain_client.rpc
    _chain_like_production(c)
    pda = passport_pda(SN2)
    rpc.mint_tx(sig("real-mint"), SN2, str(REAL_ISSUER))
    rpc.mint_tx(sig("other-signer"), SN2, SEED_PARTNER)                      # not the on-chain issuer
    _transfer(rpc, sig("prefund-passport"), pda)
    rpc.signatures[pda] = [sig("real-mint"), sig("other-signer"), sig("prefund-passport")]   # newest first
    [m] = _purge(c)["applied"]["mintFromChain"]
    assert m["serial"] == SN2 and m["txSig"] == sig("real-mint") and m["issuer"] == str(REAL_ISSUER)
    [mint] = c.get(f"/api/passport/{SN2}").json()["events"]
    assert mint["txSig"] == sig("real-mint") and mint["actor"] == str(REAL_ISSUER)


def test_a_database_an_older_purge_left_without_a_mint_gets_one(chain_client):
    c = chain_client
    _chain_like_production(c)
    _purge(c)
    with c.app.state.db.connect() as conn:                                    # what the previous purge-seed build left
        conn.execute("DELETE FROM events WHERE serial=? AND type=0", (SN2,))
    rep = _purge(c)
    assert rep["events"]["delete"] == [] and rep["applied"]["events"] == 0
    assert [m["serial"] for m in rep["applied"]["mintFromChain"]] == [SN2]
    assert [e["type"] for e in c.get(f"/api/passport/{SN2}").json()["events"]] == [0]
    assert _purge(c)["applied"]["mintFromChain"] == []                         # once is enough


def test_the_leftover_seed_warning_clears_after_a_complete_purge(chain_client, settings, caplog):
    from fv.seed import count_seed_rows
    c = chain_client
    _chain_like_production(c)
    with c.app.state.db.connect() as conn:
        assert count_seed_rows(conn, settings.seed_path) > 20
    _purge(c)
    with c.app.state.db.connect() as conn:
        assert count_seed_rows(conn, settings.seed_path) == 0                  # the kept MINT (tx on chain) is not counted
        kept = conn.execute("SELECT json_extract(payload_json, '$.seedKept') FROM events WHERE tx_sig=?",
                            ("3jBaYVCd9Tyrruz6nqYPScHFHPoqD6P4Bx1vQDty1V2arYnRHczsfWo9QYfqU9vkUwraRAw56FYPwJKfCbthqAuo",)).fetchone()
        assert kept[0] == 1
    _purge(c)
    with c.app.state.db.connect() as conn:
        assert count_seed_rows(conn, settings.seed_path) == 0
    # a production restart on this database logs no purge-seed warning any more
    settings.dev_simulator, settings.key_mode, settings.master_key_hex = False, "sdmbackend", REAL_MASTER
    caplog.set_level("WARNING", logger="fv")
    caplog.clear()                                                             # ("purge-seed applied" of the runs above)
    app = create_app(settings)
    app.state.rpc = c.rpc
    with TestClient(app):
        pass
    assert not any("demo seed" in r.getMessage() for r in caplog.records)


def test_an_existing_passport_is_never_renamed_by_upsert(client):
    from fv.db import get_passport, transaction, upsert_passport
    with client.app.state.db.connect() as conn, transaction(conn):
        kw = dict(serial="SN-OPS-1", serial_hash="ab" * 32, asset=None, issuer=None, issuer_label=None, grade=0, void=False,
                  created_at=1)
        upsert_passport(conn, brand="Roja", name="Elysium", batch=None, **kw)
        upsert_passport(conn, brand="FAKE", name="COUNTERFEIT", batch="B1", **{**kw, "asset": "Asset111"})
        p = get_passport(conn, "SN-OPS-1")
        assert (p["brand"], p["name"], p["batch"], p["asset"]) == ("Roja", "Elysium", "B1", "Asset111")   # empty batch filled
        upsert_passport(conn, brand="FAKE", name="COUNTERFEIT", batch="B2", **kw)
        assert get_passport(conn, "SN-OPS-1")["batch"] == "B1"


# ---------- S10: escrow counters have one source, so closing an order never erases a dispute ----------

def _escrow_counts(c, pk):
    a = c.get(f"/api/attester/{pk}").json()
    return a["escrowsOk"], a["escrowsDisputed"]


def _dispute(c, s, seller, buyer):
    dis = encode_event("OrderDisputed", order=order_pda(SN2, seller), by=buyer, reason=2, refunded=480_000_000)
    c.rpc.escrow_tx(s, "dispute", SN2, buyer, seller=seller, buyer=buyer, logs=program_logs(ESCROW_ID, dis))
    e = c.post("/api/events", json={"serial": SN2, "type": "DISPUTE", "txSig": s, "actor": buyer}).json()
    assert e["status"] == "confirmed", e


def test_a_dispute_keeps_counting_after_the_seller_closes_the_order(chain_client):
    c, rpc = chain_client, chain_client.rpc
    seller, buyer = fake_key("closing-disputed-seller"), fake_key("disputing-buyer")
    order = order_pda(SN2, seller)
    rpc.program_accounts = {order: order_bytes(serial=SN2, seller=seller, buyer=buyer, state=4)}   # reconcile saw it shipped
    _reconcile(c)
    rpc.program_accounts = {}                         # dispute, then close_order before the next cycle: the account is gone
    _dispute(c, sig("cd1"), seller, buyer)
    assert _escrow_counts(c, seller) == (0, 1) and _escrow_counts(c, buyer) == (0, 1)
    for _ in range(2):                                # reconcile cycles with no Order account on chain
        _reconcile(c)
        assert _escrow_counts(c, seller) == (0, 1) and _escrow_counts(c, buyer) == (0, 1)


def test_a_dispute_of_an_order_reconcile_never_saw_counts_for_seller_and_buyer(chain_client):
    c = chain_client
    seller, buyer = fake_key("unseen-disputed-seller"), fake_key("unseen-buyer")
    _dispute(c, sig("ud1"), seller, buyer)            # no escrow_orders row, Order already closed
    _reconcile(c)
    assert _escrow_counts(c, seller) == (0, 1) and _escrow_counts(c, buyer) == (0, 1)


def test_a_transfer_an_older_reconcile_build_stored_is_replaced_by_the_verified_record_scan(chain_client):
    c, rpc = chain_client, chain_client.rpc
    v = _anchored(c)
    attester = v["bundle"]["attester"]["pubkey"]
    _reconcile(c)                                                             # confirmed (no signature found)
    with c.app.state.db.connect() as conn:                                    # what older builds stored: an unchecked guess
        conn.execute("""UPDATE events SET tx_sig=?, payload_json=json_remove(payload_json, '$.reconcile.signatureChecked')
                        WHERE id=?""", (sig("old-guess"), v["eventId"]))
    _transfer(rpc, sig("old-guess"), _scan_pda(v))
    # a transfer, a foreign signer or an unknown tx cannot replace it (and keep the 409 contract) ...
    _transfer(rpc, sig("old-guess-2"), _scan_pda(v))
    rpc.scan_tx(sig("foreign-2"), v, ATTACKER)
    for bad in (sig("old-guess-2"), sig("foreign-2")):
        assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": bad, "actor": attester}).status_code == 409
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("foreign-2"), "actor": ATTACKER}).status_code == 403
    assert _event(c, v["eventId"])["txSig"] == sig("old-guess")
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("unknown"), "actor": attester}).status_code == 409
    # ... the scan's own record_scan does, once; afterwards the verified tx is final
    rpc.scan_tx(sig("the-creator"), v, attester)
    r = c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("the-creator"), "actor": attester})
    assert r.status_code == 200 and r.json()["txSig"] == sig("the-creator")
    rpc.scan_tx(sig("another"), v, attester)
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("another"), "actor": attester}).status_code == 409
    assert _event(c, v["eventId"])["txSig"] == sig("the-creator")


def test_a_signature_the_client_filled_in_is_final(chain_client):
    """Confirmed by an older build without a signature; the client fills it in; nothing replaces it afterwards."""
    c, rpc = chain_client, chain_client.rpc
    v = _anchored(c)
    attester = v["bundle"]["attester"]["pubkey"]
    _reconcile(c)
    with c.app.state.db.connect() as conn:
        conn.execute("UPDATE events SET payload_json=json_remove(payload_json, '$.reconcile.signatureChecked') WHERE id=?",
                     (v["eventId"],))
    rpc.scan_tx(sig("fill"), v, attester)
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("fill"), "actor": attester}).status_code == 200
    rpc.scan_tx(sig("fill-2"), v, attester)
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("fill-2"), "actor": attester}).status_code == 409
