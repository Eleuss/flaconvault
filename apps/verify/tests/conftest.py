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


ADMIN_TOKEN = "test-admin-token"
ADMIN = {"x-admin-token": ADMIN_TOKEN}


@pytest.fixture(autouse=True)
def _fast_tx_retries(monkeypatch):
    """getTransaction retries sleep ≈ 4 s in production; tests keep the 3 retries but not the waiting."""
    import fv.txverify
    monkeypatch.setattr(fv.txverify, "TX_RETRY_DELAYS", (0.0, 0.0, 0.0))


@pytest.fixture()
def settings(tmp_path):
    from fv.config import Settings
    return Settings(server_seed_hex=TEST_SEED_HEX, db_path=tmp_path / "test.db", media_dir=tmp_path / "media",
                    dev_simulator=True, nonce_ttl_s=90, seed_path=DOCS / "seed" / "passports.json",
                    web_url="http://web.test", verifier_host="http://verify.test", admin_token=ADMIN_TOKEN,
                    reconcile_interval_s=0)   # never start the background loop in tests


@pytest.fixture()
def client(settings):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    app = create_app(settings)
    with TestClient(app) as c:   # runs lifespan → schema + seed
        yield c


PROGRAM_ID = "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL"
ESCROW_ID = "9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL"
SYSTEM_PROGRAM = "11111111111111111111111111111111"


def make_tx(sig: str, *, signers: list[str], instructions: list[tuple[str, str, list[str]]], err=None,
            block_time: int | None = 1790000000, loaded: bool = False, inner: bool = False) -> dict:
    """
    A getTransaction result ("json" encoding) as the RPC returns it. `instructions` = [(program id, anchor ix name,
    [account pubkeys])]. loaded=True moves every non-signer key into v0 loadedAddresses (address lookup table);
    inner=True runs the instructions as CPIs below a wrapper instruction of another program.
    """
    from fv.txverify import anchor_discriminator, b58encode
    static = list(signers)
    lut: list[str] = []
    for program, _name, accounts in instructions:
        for k in (program, *accounts):
            if k not in static and k not in lut:
                (lut if loaded else static).append(k)
    keys = static + lut
    ixs = [{"programIdIndex": keys.index(program), "accounts": [keys.index(a) for a in accounts],
            "data": b58encode(anchor_discriminator(name) + b"\x00" * 8), "stackHeight": None}
           for program, name, accounts in instructions]
    inner_ixs = []
    if inner:
        if SYSTEM_PROGRAM not in keys:
            static.append(SYSTEM_PROGRAM)
            keys = static + lut
            ixs = [{**ix, "programIdIndex": keys.index(instructions[i][0]),
                    "accounts": [keys.index(a) for a in instructions[i][2]]} for i, ix in enumerate(ixs)]
        inner_ixs = [{"index": 0, "instructions": [{**ix, "stackHeight": 2} for ix in ixs]}]
        ixs = [{"programIdIndex": keys.index(SYSTEM_PROGRAM), "accounts": [], "data": "", "stackHeight": None}]
    return {
        "slot": 4242, "blockTime": block_time, "version": 0 if loaded else "legacy",
        "meta": {"err": err, "fee": 5000, "innerInstructions": inner_ixs,
                 "loadedAddresses": {"writable": lut, "readonly": []}, "logMessages": []},
        "transaction": {"signatures": [sig], "message": {
            "accountKeys": static, "header": {"numRequiredSignatures": len(signers), "numReadonlySignedAccounts": 0,
                                              "numReadonlyUnsignedAccounts": 1},
            "instructions": ixs, "recentBlockhash": "11111111111111111111111111111111"}},
    }


def passport_pda(serial: str) -> str:
    from fv import proof
    from fv.chain import pda_passport
    return str(pda_passport(PROGRAM_ID, proof.serial_hash(serial)))


def seal_pda(uid_hex: str) -> str:
    from fv import proof
    from fv.chain import pda_seal
    return str(pda_seal(PROGRAM_ID, proof.uid_hash(bytes.fromhex(uid_hex))))


def registry_pda() -> str:
    from fv.chain import pda_registry
    return str(pda_registry(PROGRAM_ID))


class FakeRpc:
    """In-memory stand-in for fv.chain.Rpc — tests never hit the network."""

    def __init__(self):
        self.accounts: dict[str, bytes] = {}
        self.signatures: dict[str, list[str]] = {}
        self.txs: dict[str, dict] = {}
        self.tx_misses: dict[str, int] = {}     # sig → lookups that return null before the tx becomes visible
        self.calls: list[str] = []

    def get_transaction(self, sig):
        self.calls.append("getTransaction")
        if self.tx_misses.get(sig, 0) > 0:
            self.tx_misses[sig] -= 1
            return None
        return self.txs.get(sig)

    # ---- transaction builders for the flacon / escrow instructions the web sends ----

    def add_tx(self, sig: str, **kw) -> str:
        self.txs[sig] = make_tx(sig, **kw)
        return sig

    def mint_tx(self, sig: str, serial: str, issuer: str, **kw) -> str:
        return self.add_tx(sig, signers=[issuer], instructions=[
            (PROGRAM_ID, "mint_passport", [registry_pda(), passport_pda(serial), issuer, SYSTEM_PROGRAM])], **kw)

    def attach_tx(self, sig: str, serial: str, uid_hex: str, signer: str, **kw) -> str:
        return self.add_tx(sig, signers=[signer], instructions=[
            (PROGRAM_ID, "attach_seal", [registry_pda(), passport_pda(serial), seal_pda(uid_hex), signer, SYSTEM_PROGRAM])], **kw)

    def dead_tx(self, sig: str, serial: str, uid_hex: str, signer: str, **kw) -> str:
        return self.add_tx(sig, signers=[signer], instructions=[
            (PROGRAM_ID, "mark_seal_dead", [registry_pda(), passport_pda(serial), seal_pda(uid_hex), signer])], **kw)

    def scan_tx(self, sig: str, v: dict, attester: str, *, counter: int | None = None, **kw) -> str:
        """record_scan for a /api/verify response `v` (Ed25519 verify ix + record_scan, as the web builds it)."""
        from fv.chain import pda_passport, pda_scan, pda_seal
        seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
        scan = pda_scan(PROGRAM_ID, seal, v["counter"] if counter is None else counter)
        passport = pda_passport(PROGRAM_ID, bytes.fromhex(v["serialHash"][2:]))
        ed25519 = "Ed25519SigVerify111111111111111111111111111"
        sysvar_ix = "Sysvar1nstructions1111111111111111111111111"
        return self.add_tx(sig, signers=[attester], instructions=[
            (ed25519, "", []),
            (PROGRAM_ID, "record_scan", [registry_pda(), str(passport), str(seal), str(scan), attester, sysvar_ix, SYSTEM_PROGRAM])],
            **kw)

    def escrow_tx(self, sig: str, ix: str, serial: str, actor: str, *, seller: str | None = None, **kw) -> str:
        """escrow instruction touching the Order PDA of (passport, seller); `list` also carries the passport PDA."""
        from solders.pubkey import Pubkey
        from fv.chain import pda_order
        seller = seller or actor
        order = str(pda_order(ESCROW_ID, Pubkey.from_string(passport_pda(serial)), seller))
        accounts = {"list": ["Config1111111111111111111111111111111111111", passport_pda(serial), order, actor, SYSTEM_PROGRAM],
                    "ship": [order, actor], "reserve": [order, actor], "record_receipt_scan": [order, actor],
                    "release": [order, actor], "dispute": [order, actor]}[ix]
        return self.add_tx(sig, signers=[actor], instructions=[(ESCROW_ID, ix, accounts)], **kw)

    def get_account_info(self, pubkey):
        self.calls.append("getAccountInfo")
        return self.accounts.get(str(pubkey))

    def get_multiple_accounts(self, pubkeys):
        self.calls.append("getMultipleAccounts")
        return [self.accounts.get(str(p)) for p in pubkeys]

    def get_signatures_for_address(self, pubkey, limit=5):
        self.calls.append("getSignaturesForAddress")
        return self.signatures.get(str(pubkey), [])[:limit]

    def get_program_accounts(self, program_id, *, data_size=None):
        """Accounts planted in `rpc.program_accounts` ({pubkey: data}, e.g. escrow Orders)."""
        self.calls.append("getProgramAccounts")
        planted = getattr(self, "program_accounts", {})
        return [(pk, d) for pk, d in planted.items() if data_size is None or len(d) == data_size]

    def get_signature_statuses(self, signatures):
        """A signature exists on chain iff a transaction was planted for it (rpc.txs)."""
        self.calls.append("getSignatureStatuses")
        return [{"slot": 4242, "err": None, "confirmationStatus": "finalized"} if s in self.txs else None for s in signatures]


@pytest.fixture()
def chain_client(settings):
    """Client with FV_PROGRAM_ID set and a FakeRpc injected (background loop disabled)."""
    from fastapi.testclient import TestClient
    from fv.main import create_app
    settings.program_id = PROGRAM_ID
    app = create_app(settings)
    app.state.rpc = FakeRpc()
    with TestClient(app) as c:
        c.rpc = app.state.rpc
        yield c


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Tests never reach a real RPC (devnet!): fv.chain.Rpc posts through httpx.post, which fails loudly here unless a
    test patches it itself."""
    import httpx

    def blocked(url, *a, **k):
        raise AssertionError(f"network access in a test: POST {url}")
    monkeypatch.setattr(httpx, "post", blocked)
