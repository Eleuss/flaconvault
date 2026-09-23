import json
import os
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
DOCS = REPO / "docs"
VECTORS = json.loads((DOCS / "vectors.json").read_text(encoding="utf-8"))
TEST_SEED_HEX = VECTORS["serverTestKey"]["seedHex"]

# fv.main builds a module-level app from the environment at import time.
os.environ.setdefault("FV_SERVER_ED25519_SEED", TEST_SEED_HEX)


@pytest.fixture(scope="session")
def vectors() -> dict:
    return VECTORS


@pytest.fixture(scope="session")
def enums_doc() -> dict:
    return json.loads((DOCS / "enums.json").read_text(encoding="utf-8"))


@pytest.fixture()
def settings(tmp_path):
    from fv.config import Settings
    return Settings(server_seed_hex=TEST_SEED_HEX, db_path=tmp_path / "test.db", media_dir=tmp_path / "media",
                    dev_simulator=True, nonce_ttl_s=90, seed_path=DOCS / "seed" / "passports.json",
                    web_url="http://web.test", verifier_host="http://verify.test",
                    reconcile_interval_s=0)   # never start the background loop in tests


@pytest.fixture()
def client(settings):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    app = create_app(settings)
    with TestClient(app) as c:   # runs lifespan → schema + seed
        yield c


PROGRAM_ID = "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL"


class FakeRpc:
    """In-memory stand-in for fv.chain.Rpc — tests never hit the network."""

    def __init__(self):
        self.accounts: dict[str, bytes] = {}
        self.signatures: dict[str, list[str]] = {}
        self.calls: list[str] = []

    def get_account_info(self, pubkey):
        self.calls.append("getAccountInfo")
        return self.accounts.get(str(pubkey))

    def get_multiple_accounts(self, pubkeys):
        self.calls.append("getMultipleAccounts")
        return [self.accounts.get(str(p)) for p in pubkeys]

    def get_signatures_for_address(self, pubkey, limit=5):
        self.calls.append("getSignaturesForAddress")
        return self.signatures.get(str(pubkey), [])[:limit]


@pytest.fixture()
def chain_client(settings):
    """Client with FV_PROGRAM_ID set and a FakeRpc injected (background loop disabled)."""
    from fastapi.testclient import TestClient
    from fv.main import create_app
    settings.program_id = PROGRAM_ID
    app = create_app(settings)
    app.state.rpc = FakeRpc()
    with TestClient(app) as c:
        yield c
