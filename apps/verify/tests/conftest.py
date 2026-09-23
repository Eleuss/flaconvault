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
                    web_url="http://web.test", verifier_host="http://verify.test")


@pytest.fixture()
def client(settings):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    app = create_app(settings)
    with TestClient(app) as c:   # runs lifespan → schema + seed
        yield c
