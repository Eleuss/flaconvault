import base64
import hashlib
import json
import os
import struct
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
DOCS = REPO / "docs"
VECTORS = json.loads((DOCS / "vectors.json").read_text(encoding="utf-8"))
TEST_SEED_HEX = VECTORS["serverTestKey"]["seedHex"]

# fv.main builds a module-level app from the environment at import time.
os.environ.setdefault("FV_SERVER_ED25519_SEED", TEST_SEED_HEX)
# Tests send hundreds of requests from one client address; the limiter itself is tested with its own low limits.
os.environ.setdefault("FV_RATE_LIMIT_PER_MIN", "1000000")
os.environ.setdefault("FV_REPORT_LIMIT_PER_HOUR", "1000000")

import fv.routes_api  # noqa: E402
import fv.txverify  # noqa: E402

# the production values, captured before the autouse fixture below patches them for speed
ORIG_TX_RETRY_DELAYS = fv.txverify.TX_RETRY_DELAYS
ORIG_MEDIA_MAX_BYTES = fv.routes_api.MEDIA_MAX_BYTES


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
    monkeypatch.setattr(fv.txverify, "TX_RETRY_DELAYS", (0.0, 0.0, 0.0))
    monkeypatch.setattr(fv.txverify, "MISS_CACHE_TTL_S", 0.0)


def sig(tag: str) -> str:
    """A well-formed transaction signature (base58 of 64 bytes), distinct per tag."""
    from fv.txverify import b58encode
    d = hashlib.sha256(tag.encode()).digest()
    return b58encode(d + hashlib.sha256(d).digest())


def post_media(client, *, files=None, nonce: str | None = None):
    """POST /api/media under a fresh session nonce (or the given one)."""
    n = nonce or client.post("/api/session", json={}).json()["nonce"]
    return client.post("/api/media", data={"nonce": n}, files=files)


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
ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111"
SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111"
DEFAULT_ASSET = "4FQoaiZa5NGcjJK5qzZ2VnXFa8MBM7TZEtyruU2wu6ck"


def fake_key(name: str) -> str:
    from solders.pubkey import Pubkey
    return str(Pubkey.from_bytes(hashlib.sha256(f"fake:{name}".encode()).digest()))


def make_tx(sig: str, *, signers: list[str], instructions: list[tuple], err=None,
            block_time: int | None = 1790000000, loaded: bool = False, inner: bool = False,
            logs: list[str] | None = None) -> dict:
    """
    A getTransaction result ("json" encoding) as the RPC returns it. `instructions` = [(program id, anchor ix name,
    [account pubkeys][, borsh args])]. loaded=True moves every non-signer key into v0 loadedAddresses (address lookup
    table); inner=True runs the instructions as CPIs below a wrapper instruction of another program.
    """
    from fv.txverify import anchor_discriminator, b58encode
    static = list(signers)
    lut: list[str] = []
    for program, _name, accounts, *_ in instructions:
        for k in (program, *accounts):
            if k not in static and k not in lut:
                (lut if loaded else static).append(k)
    keys = static + lut

    def data(name, rest):
        args = rest[0] if rest else b"\x00" * 8
        return b58encode((anchor_discriminator(name) if name else b"") + args)

    ixs = [{"programIdIndex": keys.index(program), "accounts": [keys.index(a) for a in accounts],
            "data": data(name, rest), "stackHeight": None}
           for program, name, accounts, *rest in instructions]
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
                 "loadedAddresses": {"writable": lut, "readonly": []}, "logMessages": list(logs or [])},
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


def order_pda(serial: str, seller: str) -> str:
    from solders.pubkey import Pubkey
    from fv.chain import pda_order
    return str(pda_order(ESCROW_ID, Pubkey.from_string(passport_pda(serial)), seller))


# ---------- Borsh encoders for accounts, events and logs (the program side of what txverify decodes) ----------

def _enc(layout: list[tuple[str, str]], values: dict) -> bytes:
    from solders.pubkey import Pubkey
    out = b""
    for name, kind in layout:
        v = values[name]
        out += {"pk": lambda x: bytes(Pubkey.from_string(x)), "u8": lambda x: bytes([x]), "u16": lambda x: struct.pack("<H", x),
                "u32": lambda x: struct.pack("<I", x), "u64": lambda x: struct.pack("<Q", x), "i64": lambda x: struct.pack("<q", x),
                "b": lambda x: bytes([1 if x else 0]), "h32": lambda x: bytes.fromhex(x)}[kind](v)
    return out


def encode_event(name: str, **values) -> bytes:
    from fv.txverify import _EVENT_LAYOUTS, event_discriminator
    layout = _EVENT_LAYOUTS[name]
    defaults = {"pk": fake_key("x"), "u8": 0, "u16": 0, "u32": 0, "u64": 0, "i64": 1790000000, "b": False, "h32": "00" * 32}
    full = {n: values.get(n, defaults[k]) for n, k in layout}
    return event_discriminator(name) + _enc(layout, full)


def program_logs(program: str, *events: bytes, depth: int = 1) -> list[str]:
    """The log lines of one invocation of `program` that emitted `events` (Anchor `emit!` → sol_log_data)."""
    return ([f"Program {program} invoke [{depth}]", f"Program log: Instruction: X"]
            + [f"Program data: {base64.b64encode(e).decode()}" for e in events]
            + [f"Program {program} consumed 1000 of 200000 compute units", f"Program {program} success"])


def order_bytes(*, serial: str, seller: str, buyer: str = SYSTEM_PROGRAM, asset: str = DEFAULT_ASSET, price: int = 480_000_000,
                state: int = 0, seller_scan: str = SYSTEM_PROGRAM, buyer_scan: str = SYSTEM_PROGRAM) -> bytes:
    from fv.txverify import ORDER_DISC
    from solders.pubkey import Pubkey
    pk = lambda s: bytes(Pubkey.from_string(s))  # noqa: E731
    return (ORDER_DISC + pk(passport_pda(serial)) + pk(seller) + pk(buyer) + pk(asset) + struct.pack("<Q", price) + bytes([state])
            + struct.pack("<qqq", 1790000000, 0, 0) + pk(seller_scan) + pk(buyer_scan) + struct.pack("<q", 604800)
            + bytes([0, 255, 254]))


def scan_proof_account(*, seal: str, counter: int, tier: int = 2, role: int = 1, heat: int = 0, hum: int = 0, fill: int = 92,
                       attester: str | None = None) -> bytes:
    from fv.txverify import SCAN_PROOF_DISC
    from solders.pubkey import Pubkey
    return (SCAN_PROOF_DISC + bytes(Pubkey.from_string(seal)) + struct.pack("<I", counter)
            + bytes([tier, role, 3, 3, hum, heat, 0, fill]) + struct.pack("<H", 0) + bytes(32) + bytes(32)
            + bytes(Pubkey.from_string(attester or fake_key("attester"))) + bytes([1]) + struct.pack("<q", 1790000000) + bytes([254]))


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

    # ---- transaction builders for the flacon / escrow instructions the web sends (IDL account order) ----

    def add_tx(self, sig: str, **kw) -> str:
        self.txs[sig] = make_tx(sig, **kw)
        return sig

    def mint_tx(self, sig: str, serial: str, issuer: str, *, asset: str = DEFAULT_ASSET, binding: bytes = b"\x0b" * 32,
                serial_for_args: str | None = None, **kw) -> str:
        from fv import proof
        from solders.pubkey import Pubkey
        args = proof.serial_hash(serial_for_args or serial) + binding + bytes(Pubkey.from_string(asset))
        return self.add_tx(sig, signers=[issuer], instructions=[
            (PROGRAM_ID, "mint_passport", [registry_pda(), passport_pda(serial), issuer, SYSTEM_PROGRAM], args)], **kw)

    def attach_tx(self, sig: str, serial: str, uid_hex: str, signer: str, *, kind: int = 1, **kw) -> str:
        from fv import proof
        args = proof.uid_hash(bytes.fromhex(uid_hex)) + bytes([kind])
        return self.add_tx(sig, signers=[signer], instructions=[
            (PROGRAM_ID, "attach_seal", [registry_pda(), passport_pda(serial), seal_pda(uid_hex), signer, SYSTEM_PROGRAM], args)], **kw)

    def dead_tx(self, sig: str, serial: str, uid_hex: str, signer: str, **kw) -> str:
        return self.add_tx(sig, signers=[signer], instructions=[
            (PROGRAM_ID, "mark_seal_dead", [registry_pda(), passport_pda(serial), seal_pda(uid_hex), signer], b"")], **kw)

    def scan_tx(self, sig: str, v: dict, attester: str, *, counter: int | None = None, tier: int | None = None,
                role: int | None = None, site_id: int = 0, **kw) -> str:
        """record_scan for a /api/verify response `v` (Ed25519 verify ix + record_scan, as the web builds it)."""
        from fv import proof
        from fv.chain import pda_passport, pda_scan, pda_seal
        seal = pda_seal(PROGRAM_ID, bytes.fromhex(v["uidHash"][2:]))
        ctr = v["counter"] if counter is None else counter
        scan = pda_scan(PROGRAM_ID, seal, ctr)
        passport = pda_passport(PROGRAM_ID, bytes.fromhex(v["serialHash"][2:]))
        m = proof.parse_message(bytes.fromhex(v["msgHex"]))
        att = (v.get("bundle") or {}).get("attester") or {}
        args = (struct.pack("<I", ctr)
                + bytes([att.get("tier", 1) if tier is None else tier, att.get("role", 0) if role is None else role,
                         m["tamper"], m["uv"], m["hum"], m["heat"], v["heatMask"], m["fill"]])
                + struct.pack("<H", site_id) + m["media_hash"] + bytes.fromhex(v["bundleHash"][2:]) + m["nonce"]
                + struct.pack("<q", m["ts"]) + bytes([v["keyId"]]))
        return self.add_tx(sig, signers=[attester], instructions=[
            (ED25519_PROGRAM, "", [], b""),
            (PROGRAM_ID, "record_scan", [registry_pda(), str(passport), str(seal), str(scan), attester, SYSVAR_IX, SYSTEM_PROGRAM], args)],
            **kw)

    def escrow_tx(self, sig: str, ix: str, serial: str, actor: str, *, seller: str | None = None, buyer: str | None = None,
                  price: int = 480_000_000, scan_proof: str | None = None, seal: str | None = None,
                  seller_scan: str | None = None, signers: list[str] | None = None, **kw) -> str:
        """An escrow instruction with the IDL account order; the Order PDA is (passport, seller)."""
        seller = seller or actor
        buyer = buyer or actor
        order = order_pda(serial, seller)
        f = fake_key
        accounts, args = {
            "list": ([f("config"), passport_pda(serial), order, actor, SYSTEM_PROGRAM], struct.pack("<Q", price)),
            "reserve": ([f("config"), order, actor, f("buyer_token"), f("usdc_mint"), f("vault"), f("token_program"), SYSTEM_PROGRAM], b""),
            "ship": ([order, actor], b""),
            "record_pre_ship_scan": ([order, actor, scan_proof or f("scan"), seal or f("seal")], b""),
            "record_receipt_scan": ([order, actor, scan_proof or f("scan"), seal or f("seal"), seller_scan or f("seller_scan")], b""),
            "release": ([f("config"), order, f("vault"), f("seller_token"), buyer, actor, ESCROW_ID, ESCROW_ID, f("token_program"),
                         SYSTEM_PROGRAM], b""),
            "dispute": ([f("config"), order, f("vault"), f("buyer_token"), buyer, seller, actor, ESCROW_ID, ESCROW_ID, ESCROW_ID,
                         f("token_program"), SYSTEM_PROGRAM], b""),
        }[ix]
        return self.add_tx(sig, signers=signers or [actor], instructions=[(ESCROW_ID, ix, accounts, args)], **kw)

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
        c.rpc = app.state.rpc
        yield c
