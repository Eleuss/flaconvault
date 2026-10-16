"""Verifier operations repairs (second review round): confirmation order and the grade (M6), the reconcile job's
creating signature (S8/M10), the Arweave queue (S8/S15), purge-seed and the leftover-seed warning (M1/M2), the
simulator escape hatch (M11) and the escrow counters after close_order (S10)."""
from tests.conftest import sig
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

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from fv import proof  # noqa: E402
from fv.config import Settings, is_local_rpc  # noqa: E402
from fv.main import create_app  # noqa: E402
from tests.conftest import PROGRAM_ID, TEST_SEED_HEX, FakeRpc, registry_pda  # noqa: E402
from tests.test_chain import registry_bytes  # noqa: E402

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

from tests.conftest import SYSTEM_PROGRAM, fake_key  # noqa: E402
from tests.test_reconcile import _account_for, _scan  # noqa: E402
from tests.test_reconcile_robust import _event, _reconcile, _scan_pda  # noqa: E402

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
