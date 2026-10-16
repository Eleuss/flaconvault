"""Startup guards (forgeable key configurations) and when the demo seed is loaded — M1, M11."""
import json

import pytest
from fastapi.testclient import TestClient
from nacl.signing import VerifyKey

from fv import proof
from fv.config import Settings, settings_from_env
from fv.main import create_app
from fv.seed import SEED_KEY_ID, main as seed_main, run_seed
from tests.conftest import TEST_SEED_HEX

REAL_MASTER = "00112233445566778899aabbccddeeff"      # obviously fake test value, non-zero


def _s(**kw) -> Settings:
    return Settings(server_seed_hex="11" * 32, **kw)


def test_factory_keys_without_simulator_refuse_to_start():
    with pytest.raises(RuntimeError, match="FV_KEY_MODE=factory with FV_DEV_SIMULATOR off"):
        _s(key_mode="factory", master_key_hex="01" * 16, dev_simulator=False).check_startup()
    # the default key mode is factory, so a deployment that forgets FV_KEY_MODE cannot start either
    with pytest.raises(RuntimeError, match="FV_KEY_MODE=factory"):
        _s(master_key_hex="01" * 16).check_startup()
    # both problems are named at once (zero master key and factory mode)
    with pytest.raises(RuntimeError) as exc:
        _s().check_startup()
    assert "all zeros" in str(exc.value) and "FV_KEY_MODE=factory" in str(exc.value)


def test_real_key_modes_start_without_simulator():
    for mode in ("sdmbackend", "diversified"):
        _s(key_mode=mode, master_key_hex=REAL_MASTER, dev_simulator=False).check_startup()
    with pytest.raises(RuntimeError, match="all zeros"):
        _s(key_mode="sdmbackend", dev_simulator=False).check_startup()


def test_simulator_refuses_real_key_modes_unless_explicitly_allowed():
    _s(key_mode="factory", dev_simulator=True).check_startup()
    _s(key_mode="factory", master_key_hex=REAL_MASTER, dev_simulator=True).check_startup()   # factory ignores the master key
    for mode in ("sdmbackend", "diversified"):
        with pytest.raises(RuntimeError, match=f"FV_DEV_SIMULATOR=true with FV_KEY_MODE={mode}"):
            _s(key_mode=mode, master_key_hex=REAL_MASTER, dev_simulator=True).check_startup()
        _s(key_mode=mode, master_key_hex=REAL_MASTER, dev_simulator=True, allow_sim_with_real_keys=True).check_startup()


def test_lifespan_refuses_factory_mode_in_production(settings):
    settings.dev_simulator = False
    settings.master_key_hex = REAL_MASTER
    with pytest.raises(RuntimeError, match="anyone can forge"):
        with TestClient(create_app(settings)):
            pass


def test_env_flags(monkeypatch):
    monkeypatch.setenv("FV_SERVER_ED25519_SEED", "11" * 32)
    for k in ("FV_SEED_DEMO", "FV_ALLOW_SIM_WITH_REAL_KEYS", "FV_DEV_SIMULATOR"):
        monkeypatch.delenv(k, raising=False)
    s = settings_from_env()
    assert s.seed_demo is False and s.allow_sim_with_real_keys is False and s.seed_enabled is False
    monkeypatch.setenv("FV_SEED_DEMO", "true")
    monkeypatch.setenv("FV_ALLOW_SIM_WITH_REAL_KEYS", "1")
    s = settings_from_env()
    assert s.seed_demo is True and s.allow_sim_with_real_keys is True and s.seed_enabled is True


def _production(settings) -> Settings:
    settings.dev_simulator = False
    settings.key_mode = "sdmbackend"
    settings.master_key_hex = REAL_MASTER
    return settings


def test_production_does_not_seed_an_empty_database(settings):
    with TestClient(create_app(_production(settings))) as c:
        assert c.get("/api/passports").json() == []
        with c.app.state.db.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM attesters").fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM sim_tags").fetchone()[0] == 0


def test_explicit_demo_seed_without_simulator_writes_no_virtual_tags(settings):
    settings = _production(settings)
    settings.seed_demo = True
    with TestClient(create_app(settings)) as c:
        assert [p["serial"] for p in c.get("/api/passports").json()] == ["SN-2026-000001", "SN-2026-000002", "SN-2026-000003"]
        with c.app.state.db.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM sim_tags").fetchone()[0] == 0   # no keys derived from the real master


def _seed_scans(conn) -> list[dict]:
    return [json.loads(r[0]) for r in conn.execute("SELECT payload_json FROM events WHERE type=2").fetchall()
            if "msgHex" in json.loads(r[0])]


def test_seed_scans_are_signed_with_a_throwaway_key(settings):
    from fv.db import Database
    db = Database(settings.db_path)
    throwaway = bytes(range(32))
    counts = run_seed(db, settings, signing_seed=throwaway)
    assert counts["signingPubkeyHex"] == proof.public_key(throwaway).hex()
    server_pub = proof.public_key(bytes.fromhex(TEST_SEED_HEX))
    with db.connect() as conn:
        scans = _seed_scans(conn)
        assert len(scans) >= 10
        for p in scans:
            msg, sig = bytes.fromhex(p["msgHex"]), bytes.fromhex(p["server"]["sig"][2:])
            VerifyKey(proof.public_key(throwaway)).verify(msg, sig)          # the throwaway key signed it ...
            assert not proof.verify(server_pub, msg, sig)                    # ... never the server key
            assert p["server"]["keyId"] == SEED_KEY_ID == 0 and p["seed"] is True
        # every seeded row is marked as demo data
        assert all(json.loads(r[0]).get("seed") is True for r in conn.execute("SELECT payload_json FROM events").fetchall())
    # without a fixed key every run uses a fresh random one
    a = run_seed(db, settings, wipe=True)["signingPubkeyHex"]
    b = run_seed(db, settings, wipe=True)["signingPubkeyHex"]
    assert a != b and server_pub.hex() not in (a, b)
    with pytest.raises(ValueError, match="never be signed"):
        run_seed(db, settings, wipe=True, signing_seed=bytes.fromhex(TEST_SEED_HEX))


def test_seed_cli_refuses_on_production_settings(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("FV_SERVER_ED25519_SEED", "11" * 32)
    monkeypatch.setenv("FV_DB_PATH", str(tmp_path / "prod.db"))
    monkeypatch.setenv("FV_DEV_SIMULATOR", "false")
    monkeypatch.delenv("FV_SEED_DEMO", raising=False)
    assert seed_main([]) == 2
    assert "refusing to seed" in capsys.readouterr().err and not (tmp_path / "prod.db").exists()


def test_production_start_warns_about_leftover_seed_rows(settings, caplog):
    """A production database that an older build auto-seeded: startup points the operator at purge-seed."""
    from fv.db import Database
    from fv.seed import count_seed_rows
    db = Database(settings.db_path)
    run_seed(db, settings)
    with db.connect() as conn:
        conn.execute("UPDATE events SET payload_json=json_remove(payload_json, '$.seed')")    # what old builds wrote
        assert count_seed_rows(conn, settings.seed_path) >= 20                                # found by the fake txSigs
    caplog.set_level("WARNING", logger="fv")
    with TestClient(create_app(_production(settings))):
        pass
    assert any("purge-seed" in r.getMessage() for r in caplog.records)
