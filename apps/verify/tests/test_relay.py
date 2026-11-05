"""Public-record relay (docs/public-record.md §9): queueing, caps, the shape allowlist, sending and confirming through a fake
RPC (no network: every sent transaction is recorded and decoded), the API contract and the event invariants. Keys: the
documented TEST scan key and freshly generated ephemeral keypairs only."""
import hashlib
import json
import logging
import sqlite3
import struct
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from fv import proof, relayer
from fv.chain import ACCOUNT_DISC, RpcError, decode_holder_config, decode_holding, pda_holding, pda_passport, pda_seal
from fv.config import Settings, parse_keypair, settings_from_env
from fv.db import get_seal_by_uid, transaction
from fv.enums import ActorKind, Cluster, Grade, Purpose
from fv.reconcile import reconcile_once
from fv.views import scan_by
from tests.conftest import ADMIN, PROGRAM_ID, TEST_SEED_HEX, FakeRpc

SERIAL = "SN-2026-000001"
LOCAL_RPC = "http://127.0.0.1:8899"
REAL_RELAY_ONCE = relayer.relay_once
PID = Pubkey.from_string(PROGRAM_ID)
SCAN_PUB = proof.public_key(bytes.fromhex(TEST_SEED_HEX))
FEE = relayer.fee_estimate(200, 150_000)          # 75th percentile of the fake's fees [0, 100, 200, 300] = 200


# ---------- chain accounts (the program side of what fv.chain decodes) ----------

def passport_account(serial: str, *, grade: int = 0, scan_count: int = 0, void: bool = False, asset: Pubkey | None = None) -> bytes:
    pp = pda_passport(PID, proof.serial_hash(serial))
    return (ACCOUNT_DISC["Passport"] + proof.serial_hash(serial) + bytes(32) + bytes(asset or pda_holding(PID, pp)) + bytes(32)
            + bytes([grade]) + struct.pack("<I", scan_count) + bytes([1, int(void)]) + struct.pack("<q", 0) + bytes([255]))


def seal_account(serial: str, uid_hash: bytes, *, last_counter: int = 0, dead: bool = False) -> bytes:
    pp = pda_passport(PID, proof.serial_hash(serial))
    return (ACCOUNT_DISC["Seal"] + bytes(pp) + bytes([1]) + uid_hash + struct.pack("<I", last_counter) + bytes([int(dead)])
            + struct.pack("<q", 0) + bytes([255]))


def holding_account(passport: Pubkey) -> bytes:
    return (ACCOUNT_DISC["Holding"] + bytes(passport) + bytes([2]) + struct.pack("<I", 0) + bytes(64) + struct.pack("<I", 0)
            + bytes([0]) + bytes(32) + bytes([0]) + struct.pack("<q", 0) + bytes([0]) + bytes(32) + struct.pack("<q", 0)
            + bytes([255]) + bytes(32))


def holder_config_account(cluster_tag: int) -> bytes:
    return (ACCOUNT_DISC["HolderConfig"] + bytes(128) + bytes([cluster_tag]) + struct.pack("<qq", 259_200, 604_800) + bytes([0])
            + struct.pack("<q", 0) + bytes([255]) + bytes(64))


SEAL_COUNTER_OFFSET = 8 + 32 + 1 + 32


class FakeRelayRpc:
    """The relay's RPC: planted accounts; every sendTransaction is recorded (decoded with solders) and, unless land=False,
    lands at once (confirmed, the seal counter advances as record_scan_v2 would)."""

    def __init__(self):
        self.accounts: dict[str, bytes] = {}
        self.sent: list[Transaction] = []
        self.statuses: dict[str, dict] = {}
        self.fees_paid: dict[str, int] = {}
        self.block_height = 1000
        self.last_valid = 1150
        self.balance = 10**9
        self.prio = [0, 100, 200, 300]
        self.land = True
        self.land_then_fail = False               # the tx lands but the send call fails on the transport
        self.lost_answer = False                  # the node takes the tx (it lands once settled) but its answer is lost
        self.fail: dict[str, list[Exception]] = {}
        self.calls: list[str] = []

    def _call(self, name: str) -> None:
        self.calls.append(name)
        queue = self.fail.get(name)
        if queue:
            raise queue.pop(0)

    def get_recent_prioritization_fees(self, accounts):
        self._call("get_recent_prioritization_fees")
        return list(self.prio)

    def get_multiple_accounts(self, keys):
        self._call("get_multiple_accounts")
        return [self.accounts.get(str(k)) for k in keys]

    def get_account_info(self, key):
        self._call("get_account_info")
        return self.accounts.get(str(key))

    def get_latest_blockhash(self):
        self._call("get_latest_blockhash")
        return str(Hash.new_unique()), self.last_valid

    def send_transaction(self, raw: bytes) -> str:
        self._call("send_transaction")
        tx = Transaction.from_bytes(raw)
        self.sent.append(tx)
        if (self.land or self.land_then_fail) and not self.lost_answer:
            self.settle(tx)
        if self.land_then_fail or self.lost_answer:
            raise RpcError("sendTransaction: timed out")
        return str(tx.signatures[0])

    def settle(self, tx: Transaction, err=None, fee: int = FEE - 3) -> None:
        sig = str(tx.signatures[0])
        self.statuses[sig] = {"slot": 1, "confirmations": None, "err": err, "confirmationStatus": "confirmed"}
        self.fees_paid[sig] = fee
        if err is None:
            m = proof.parse_message_v2(proof.parse_ed25519_ix_data(bytes(tx.message.instructions[2].data))["msg"])
            seal = str(pda_seal(PID, m["uid_hash"]))
            d = bytearray(self.accounts[seal])
            d[SEAL_COUNTER_OFFSET:SEAL_COUNTER_OFFSET + 4] = struct.pack("<I", m["counter"])
            self.accounts[seal] = bytes(d)

    def get_signature_statuses(self, sigs):
        self._call("get_signature_statuses")
        return [self.statuses.get(s) for s in sigs]

    def get_transaction(self, sig):
        self._call("get_transaction")
        return {"meta": {"fee": self.fees_paid[sig], "err": None}} if sig in self.statuses else None

    def get_block_height(self, commitment="finalized"):
        self._call("get_block_height")
        return self.block_height

    def get_balance(self, pubkey):
        self._call("get_balance")
        return self.balance

    # what the reconcile job reads besides the relay calls
    def get_program_accounts(self, program_id, *, data_size=None):
        return []

    def get_signatures_for_address(self, pubkey, limit=5):
        return []


def plant_chain(fake: FakeRelayRpc, uid_hex: str, *, serial: str = SERIAL, cluster_tag: int = Cluster.LOCALNET, **seal_kw) -> None:
    uh = proof.uid_hash(bytes.fromhex(uid_hex))
    pp = pda_passport(PID, proof.serial_hash(serial))
    fake.accounts[str(pp)] = passport_account(serial)
    fake.accounts[str(pda_seal(PID, uh))] = seal_account(serial, uh, **seal_kw)
    fake.accounts[str(pda_holding(PID, pp))] = holding_account(pp)
    fake.accounts[str(relayer.pda_holder_config(PID))] = holder_config_account(cluster_tag)


# ---------- fixtures and helpers ----------

def _relay_settings(settings):
    settings.program_id = PROGRAM_ID
    settings.cluster = "localnet"
    settings.solana_rpc = LOCAL_RPC                 # the simulator may relay only to a local validator
    settings.relay_enabled = True
    settings.relayer_keypair = Keypair()            # ephemeral fee payer
    settings.relay_interval_s = 30.0
    return settings


@pytest.fixture()
def relay_client(settings, monkeypatch):
    """Relay on (localnet, FakeRelayRpc). The background loop runs a recorder instead of relay_once; tests drive cycles
    themselves with run(c, now)."""
    from fv.main import create_app
    _relay_settings(settings)
    loop_calls: list = []
    monkeypatch.setattr(relayer, "relay_once", lambda *a, **k: loop_calls.append(time.monotonic()) or {})
    app = create_app(settings)
    app.state.rpc = FakeRpc()
    fake = FakeRelayRpc()
    app.state.relay_rpc = fake
    with TestClient(app) as c:
        c.fake, c.loop_calls, c.settings, c.db, c.state = fake, loop_calls, settings, app.state.db, app.state.relay
        yield c


def run(c, now):
    return REAL_RELAY_ONCE(c.db, c.settings, c.fake, c.state, now=now)


def attach(c, serial: str = SERIAL) -> str:
    uid = c.post("/api/dev/tag", json={"serial": serial, "kind": 1}).json()["uid"]
    if hasattr(c, "fake"):
        plant_chain(c.fake, uid, serial=serial)
    return uid


def t_tap(c, uid):
    """A sticker tap landing on /t → (tapId, token)."""
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    r = c.get(f"/t?{urlparse(tap['url']).query}", follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    return int(q["tap"][0]), q.get("k", [None])[0]


def nonce(c) -> str:
    return c.post("/api/session", json={}).json()["nonce"]


def body(c, *, tap=None, tap_id=None, token=None, anchor="relay", **over):
    b = {"nonce": nonce(c), "role": 0, "tier": 1, "indicators": {"heat": 0, "humidity": 0, "uv": 3},
         "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "platform": "IOS_WEB"}
    if anchor is not None:
        b["anchor"] = anchor
    if tap is not None:
        b.update(uid=tap["uid"], ctr=tap["ctrHex"], cmac=tap["cmac"])
    if tap_id is not None:
        b.update(tapId=tap_id, tapToken=token)
    b.update(over)
    return b


def rows(c) -> list[dict]:
    with c.app.state.db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM relay_tx ORDER BY id").fetchall()]


def event(c, event_id: int) -> dict:
    with c.app.state.db.connect() as conn:
        return dict(conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone())


def budget(c, now) -> int:
    with c.app.state.db.connect() as conn:
        return relayer.spent_today(conn, now)


def sent_counter(tx: Transaction) -> int:
    return proof.parse_message_v2(proof.parse_ed25519_ix_data(bytes(tx.message.instructions[2].data))["msg"])["counter"]


# ---------- kill switch ----------

def test_kill_switch_is_off_unless_set(client, monkeypatch):
    assert Settings(server_seed_hex=TEST_SEED_HEX).relay_enabled is False
    for value in (None, "", "  ", "false", "0"):
        if value is None:
            monkeypatch.delenv("FV_RELAY_ENABLED", raising=False)
        else:
            monkeypatch.setenv("FV_RELAY_ENABLED", value)
        assert settings_from_env().relay_enabled is False, value
    monkeypatch.setenv("FV_RELAY_ENABLED", "true")
    assert settings_from_env().relay_enabled is True

    # relay off: the TAP row is still built and signed, but fails relay_off; the tap shows it
    uid = attach(client)
    tap_id, token = t_tap(client, uid)
    (row,) = rows(client)
    assert row["status"] == "failed" and row["reason"] == "relay_off" and len(bytes.fromhex(row["msg_hex"])) == 256
    assert proof.verify(SCAN_PUB, bytes.fromhex(row["msg_hex"]), bytes.fromhex(row["server_sig"]))
    rec = client.get(f"/api/tap/{tap_id}").json()["record"]
    assert rec["state"] == "failed" and rec["reason"] == "relay_off" and rec["purpose"] == "TAP" and rec["txSig"] is None
    # a relay CHECK with the relay off: an off-chain scan right away (confirmed, no tx), never failed
    v = client.post("/api/verify", json=body(client, tap_id=tap_id, token=token)).json()
    assert v["verdict"] == "VALID" and v["record"]["state"] == "failed" and v["record"]["reason"] == "relay_off"
    ev = event(client, v["eventId"])
    assert ev["status"] == "confirmed" and ev["tx_sig"] is None
    # relay_once does nothing and touches no RPC
    fake = FakeRelayRpc()
    s = client.app.state.settings
    assert REAL_RELAY_ONCE(client.app.state.db, s, fake, relayer.RelayState(), now=time.time() + 300) == {"enabled": False}
    assert fake.calls == [] and fake.sent == []


def test_loop_runs_only_with_the_relay_on(settings, monkeypatch):
    from fv.main import create_app
    calls: list = []
    monkeypatch.setattr(relayer, "relay_once", lambda *a, **k: calls.append(1) or {})
    with TestClient(create_app(settings)):                       # relay off (default)
        time.sleep(0.3)
    assert calls == []
    _relay_settings(settings)
    app = create_app(settings)
    app.state.relay_rpc = FakeRelayRpc()
    with TestClient(app):
        for _ in range(50):
            if calls:
                break
            time.sleep(0.05)
    assert calls, "the relay loop starts with FV_RELAY_ENABLED=true and FV_PROGRAM_ID"


def test_a_queued_check_wakes_the_loop(relay_client):
    c = relay_client
    for _ in range(50):
        if c.loop_calls:
            break
        time.sleep(0.05)
    first = len(c.loop_calls)
    assert first >= 1                                             # the first cycle at start
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    assert c.post("/api/verify", json=body(c, tap=tap)).json()["record"]["state"] == "pending"
    for _ in range(60):
        if len(c.loop_calls) > first:
            break
        time.sleep(0.05)
    assert len(c.loop_calls) > first, "woken long before FV_RELAY_INTERVAL_S (30 s here)"


# ---------- TAP: queued, sent, recorded ----------

def test_tap_is_queued_after_the_adopt_window_sent_and_recorded(relay_client):
    c = relay_client
    before = c.get(f"/api/passport/{SERIAL}").json()
    uid = attach(c)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    ts = row["created_at"]
    uh = proof.uid_hash(bytes.fromhex(uid)).hex()
    assert row["status"] == "queued" and row["purpose"] == Purpose.TAP and row["actor_kind"] == ActorKind.NONE
    assert row["ref"] == f"{uh}:1" and row["due_at"] == ts + 185 and row["deadline_at"] == ts + 570
    m = proof.parse_message_v2(bytes.fromhex(row["msg_hex"]))
    assert (m["tier"], m["fill"], m["purpose"], m["actor_kind"], m["cluster_tag"], m["ts"]) == (0, 255, Purpose.TAP, 0, 3, ts)
    assert m["program_id"] == bytes(PID) and m["counter"] == 1 and m["media_hash"] == bytes(32)
    rec = c.get(f"/api/tap/{tap_id}").json()["record"]
    assert rec == {"state": "pending", "purpose": "TAP", "eventId": row["event_id"], "dueAt": ts + 185, "txSig": None,
                   "reason": None, "cluster": "LOCALNET"}
    # the sighting does not show the signed bytes while the TAP is not recorded
    sighting = [e for e in c.get(f"/api/passport/{SERIAL}").json()["events"] if e["id"] == row["event_id"]][0]
    assert "msgHex" not in sighting["payload"] and sighting["scanBy"] == "VISITOR" and sighting["purpose"] is None

    assert run(c, ts + 10)["sent"] == {} and c.fake.sent == []       # not due before the adopt window has passed
    out = run(c, ts + 186)
    assert out["sent"] == {"sent": 1} and len(c.fake.sent) == 1
    (row,) = rows(c)
    assert row["status"] == "sending" and row["sig"] == str(c.fake.sent[0].signatures[0]) and row["attempts"] == 1
    assert row["last_valid_height"] == c.fake.last_valid and row["lamports"] == FEE and budget(c, ts + 186) == FEE

    balance_reads = c.fake.calls.count("get_balance")
    out = run(c, ts + 188)                                           # landed: confirmed on the next cycle
    assert out["confirm"]["recorded"] == 1 and c.fake.sent[1:] == []
    (row,) = rows(c)
    assert row["status"] == "recorded" and row["lamports"] == FEE - 3 and budget(c, ts + 188) == FEE - 3
    ev = event(c, row["event_id"])
    p = json.loads(ev["payload_json"])
    assert ev["status"] == "confirmed" and ev["tx_sig"] == row["sig"]
    assert p["anchor"] == "relay" and p["purpose"] == "TAP" and p["actorKind"] == "NONE" and p["msgHex"] == row["msg_hex"]
    assert p["bundleV2"]["purpose"] == "TAP" and p["bundleHash"] == "0x" + proof.bundle_hash(row["bundle_json"]).hex()
    assert m["bundle_hash"] == proof.bundle_hash(row["bundle_json"])
    after = c.get(f"/api/passport/{SERIAL}").json()
    assert after["stats"]["onChainScanCount"] == before["stats"]["onChainScanCount"] + 1   # the chain counts it too
    assert (after["grade"], after["void"], after["latest"]) == (before["grade"], before["void"], before["latest"])
    shown = [e for e in after["events"] if e["id"] == row["event_id"]][0]
    assert shown["txSig"] == row["sig"] and shown["purpose"] == "TAP" and shown["scanBy"] == "VISITOR"
    rec = c.get(f"/api/tap/{tap_id}").json()["record"]
    assert rec["state"] == "recorded" and rec["txSig"] == row["sig"] and rec["dueAt"] is None
    assert c.fake.calls.count("get_balance") == balance_reads + 1     # re-read after a recorded row (2 s after the last)
    run(c, ts + 189)
    assert c.fake.calls.count("get_balance") == balance_reads + 1     # otherwise at most every 60 s


def test_t_json_carries_the_record(relay_client):
    c = relay_client
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    j = c.get(f"/t?{urlparse(tap['url']).query}&format=json").json()
    assert j["verdict"] == "VALID" and j["tapToken"] and j["record"]["state"] == "pending" and j["record"]["purpose"] == "TAP"
    assert c.get("/t?uid=zz&ctr=1&cmac=00&format=json").json()["record"] is None


def test_relay_transaction_has_exactly_the_allowlisted_shape(relay_client):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    run(c, row["due_at"])
    (tx,) = c.fake.sent
    relayer_pk = c.settings.relayer_keypair.pubkey()
    msg = tx.message
    tx.verify()                                                       # signed by the fee payer
    assert msg.header.num_required_signatures == 1 and msg.account_keys[0] == relayer_pk and len(tx.signatures) == 1
    ixs = list(msg.instructions)
    keys = list(msg.account_keys)
    assert [keys[ix.program_id_index] for ix in ixs] == [relayer.COMPUTE_BUDGET_PROGRAM, relayer.COMPUTE_BUDGET_PROGRAM,
                                                          relayer.ED25519_PROGRAM, PID]
    assert bytes(ixs[0].data) == b"\x02" + struct.pack("<I", 150_000) and not bytes(ixs[0].accounts)
    assert bytes(ixs[1].data) == b"\x03" + struct.pack("<Q", 200) and not bytes(ixs[1].accounts)
    server_msg, server_sig = bytes.fromhex(row["msg_hex"]), bytes.fromhex(row["server_sig"])
    assert bytes(ixs[2].data) == proof.ed25519_ix_data(SCAN_PUB, server_sig, server_msg) and not bytes(ixs[2].accounts)
    assert proof.verify(SCAN_PUB, server_msg, server_sig) and server_msg[:7] == b"FVSCAN2"
    assert bytes(ixs[3].data) == hashlib.sha256(b"global:record_scan_v2").digest()[:8] + bytes([1])
    m = proof.parse_message_v2(server_msg)
    pp = pda_passport(PID, m["serial_hash"])
    expected = [relayer.pda_registry(PID), relayer.pda_holder_config(PID), pp, pda_seal(PID, m["uid_hash"]),
                pda_holding(PID, pp), relayer.SYSVAR_INSTRUCTIONS, PID, PID, relayer.pda_event_authority(PID), PID]
    assert [keys[a] for a in bytes(ixs[3].accounts)] == expected
    writable = {keys[i] for i in range(len(keys)) if relayer._writable(msg, i)}
    assert writable == {relayer_pk, pp, pda_seal(PID, m["uid_hash"]), pda_holding(PID, pp)}
    assert all(relayer_pk != keys[a] for ix in ixs for a in bytes(ix.accounts))
    assert relayer.check_relay_shape(msg, relayer_pk, SCAN_PUB, PROGRAM_ID, Cluster.LOCALNET, 10_000) == server_msg


def _shape_parts():
    """A valid relay message's instructions (ephemeral relayer) for the allowlist tests."""
    seed = bytes.fromhex(TEST_SEED_HEX)
    kw = dict(seed=seed, key_id=1, program_id=bytes(PID), cluster_tag=Cluster.LOCALNET, serial=SERIAL,
              uid_hash_b=proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")), seal_kind=1, counter=7, purpose=Purpose.TAP,
              actor_kind=ActorKind.NONE, actor=proof.ZERO32, tier=0, role=0, site_id=0, tamper=3, heat=3, hum=3, uv=3,
              heat_levels=0, fill=proof.FILL_NONE, country=None, media_hash_b=proof.ZERO32, nonce_b=b"\x07" * 32,
              issued_at=1, ts=1)
    _b, _h, msg, sig = proof.build_scan_v2(**kw)
    m = proof.parse_message_v2(msg)
    metas = [AccountMeta(pk, False, role in relayer.RECORD_SCAN_V2_WRITABLE)
             for role, pk in relayer.record_scan_v2_accounts(PID, m["serial_hash"], m["uid_hash"])]
    ed = Instruction(relayer.ED25519_PROGRAM, proof.ed25519_ix_data(SCAN_PUB, sig, msg), [])
    rs = Instruction(PID, relayer.RECORD_SCAN_V2_DISC + b"\x01", metas)
    return kw, [set_compute_unit_limit(150_000), set_compute_unit_price(5), ed, rs], metas


def test_check_relay_shape_refuses_everything_else():
    kp = Keypair()
    kw, good, metas = _shape_parts()
    check = lambda ixs, payer=kp.pubkey(), tag=Cluster.LOCALNET: relayer.check_relay_shape(  # noqa: E731
        Message.new_with_blockhash(ixs, payer, Hash.default()), kp.pubkey(), SCAN_PUB, PROGRAM_ID, tag, 10_000)
    assert check(good)[:7] == b"FVSCAN2"
    cb_limit, cb_price, ed, rs = good
    other = Keypair()
    other_seed = bytes(other)[:32]
    _b, _h, msg, _sig = proof.build_scan_v2(**kw)
    foreign_ed = Instruction(relayer.ED25519_PROGRAM,
                             proof.ed25519_ix_data(proof.public_key(other_seed), proof.sign(other_seed, msg), msg), [])
    v1_msg = b"FVSCAN1" + bytes(145)
    v1_ed = Instruction(relayer.ED25519_PROGRAM, proof.ed25519_ix_data(SCAN_PUB, proof.sign(kw["seed"], v1_msg), v1_msg), [])
    _b, _h, devnet_msg, devnet_sig = proof.build_scan_v2(**{**kw, "cluster_tag": Cluster.DEVNET})
    devnet_ed = Instruction(relayer.ED25519_PROGRAM, proof.ed25519_ix_data(SCAN_PUB, devnet_sig, devnet_msg), [])
    bad_sig_ed = Instruction(relayer.ED25519_PROGRAM, proof.ed25519_ix_data(SCAN_PUB, bytes(64), msg), [])
    with_relayer = Instruction(PID, relayer.RECORD_SCAN_V2_DISC + b"\x01", metas + [AccountMeta(kp.pubkey(), False, False)])
    extra_writable = Instruction(PID, relayer.RECORD_SCAN_V2_DISC + b"\x01", [AccountMeta(metas[0].pubkey, False, True), *metas[1:]])
    signer_actor = Instruction(PID, relayer.RECORD_SCAN_V2_DISC + b"\x01",
                               [*metas[:6], AccountMeta(other.pubkey(), True, False), *metas[7:]])
    cases = {
        "extra instruction": [cb_limit, cb_price, ed, rs, cb_limit],
        "reordered": [cb_price, cb_limit, ed, rs],
        "missing compute budget": [ed, rs, cb_limit, cb_price],
        "wrong program": [cb_limit, cb_price, ed, Instruction(Pubkey.new_unique(), bytes(rs.data), metas)],
        "wrong discriminator": [cb_limit, cb_price, ed, Instruction(PID, hashlib.sha256(b"global:record_scan").digest()[:8] + b"\x01", metas)],
        "relayer in an account list": [cb_limit, cb_price, ed, with_relayer],
        "an extra writable": [cb_limit, cb_price, ed, extra_writable],
        "a second signer": [cb_limit, cb_price, ed, signer_actor],
        "wrong Ed25519 key": [cb_limit, cb_price, foreign_ed, rs],
        "bad signature": [cb_limit, cb_price, bad_sig_ed, rs],
        "152-byte message": [cb_limit, cb_price, v1_ed, rs],
        "price above the ceiling": [cb_limit, set_compute_unit_price(10_001), ed, rs],
        "Ed25519 with accounts": [cb_limit, cb_price, Instruction(relayer.ED25519_PROGRAM, bytes(ed.data),
                                                                 [AccountMeta(metas[0].pubkey, False, False)]), rs],
        "a system transfer": [cb_limit, cb_price, ed, Instruction(Pubkey.from_string("11111111111111111111111111111111"),
                                                                  bytes(12), [AccountMeta(metas[2].pubkey, False, True)])],
    }
    for name, ixs in cases.items():
        with pytest.raises(relayer.RelayShapeError):
            check(ixs)
            pytest.fail(name)
    with pytest.raises(relayer.RelayShapeError):
        check([cb_limit, cb_price, devnet_ed, rs])                     # message bound to another cluster
    with pytest.raises(relayer.RelayShapeError):
        check(good, payer=other.pubkey())                              # another fee payer
    with pytest.raises(relayer.RelayShapeError):
        check(good, tag=Cluster.DEVNET)                                # configured for another cluster


def test_built_transaction_parses_back_to_the_allowed_shape(relay_client):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    tx = relayer.build_relay_tx(c.settings, row, str(Hash.new_unique()), 42)
    again = Transaction.from_bytes(bytes(tx))
    again.verify()
    assert relayer.check_relay_shape(again.message, c.settings.relayer_keypair.pubkey(), SCAN_PUB, PROGRAM_ID,
                                     Cluster.LOCALNET, 42).hex() == row["msg_hex"]


def test_the_allowlist_runs_before_the_relayer_signs(relay_client, monkeypatch):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    signed: list = []
    real = relayer.Transaction
    monkeypatch.setattr(relayer, "Transaction", lambda *a: signed.append(a) or real(*a))
    with pytest.raises(relayer.RelayShapeError, match="ceiling"):                 # a message the allowlist refuses
        relayer.build_relay_tx(c.settings, row, str(Hash.new_unique()), c.settings.relay_max_priority_microlamports + 1)
    assert signed == [], "the relayer key signed nothing"
    relayer.build_relay_tx(c.settings, row, str(Hash.new_unique()), 7)
    assert len(signed) == 1


def test_a_row_is_sent_with_the_key_that_signed_it_after_a_key_rotation(relay_client):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    assert row["server_pubkey"] == SCAN_PUB.hex() and row["key_id"] == 1
    # ops rotate the scan key (new seed, key id 2) while the old key stays valid in the Registry for an overlap
    other_seed = bytes(Keypair())[:32]
    c.settings.server_seed_hex, c.settings.server_key_id = other_seed.hex(), 2
    tx = relayer.build_relay_tx(c.settings, row, str(Hash.new_unique()), 5)
    ed = proof.parse_ed25519_ix_data(bytes(tx.message.instructions[2].data), message_len=proof.MSG2_LEN)
    assert ed["pubkey"] == SCAN_PUB and bytes(tx.message.instructions[3].data)[8] == 1   # key A and its key id 1
    assert relayer.check_relay_shape(tx.message, c.settings.relayer_keypair.pubkey(), SCAN_PUB, PROGRAM_ID, Cluster.LOCALNET,
                                     10_000).hex() == row["msg_hex"]
    run(c, row["due_at"])
    run(c, row["due_at"] + 1)
    assert rows(c)[0]["status"] == "recorded" and len(c.fake.sent) == 1
    # a row of an earlier P1 build without the column falls back to the current key
    assert relayer.row_pubkey(c.settings, {**row, "server_pubkey": None}) == proof.public_key(other_seed)


# ---------- caps ----------

def _queue(conn, settings, seal, counter, purpose, *, actor_kind=ActorKind.NONE, now=None, actor=proof.ZERO32):
    ts = int(now or time.time())
    if purpose == Purpose.TAP:
        from fv.routes_tag import tap_fields
        fields = tap_fields(ts)
    else:
        fields = {"tier": 1, "role": 0, "site_id": 0, "tamper": 3, "heat": 3, "hum": 3, "uv": 3, "heat_levels": 0, "fill": 92,
                  "country": None, "media_hash_b": proof.ZERO32, "nonce_b": bytes(32), "issued_at": ts}
    signed = relayer.sign_scan(settings, seal=seal, counter=counter, purpose=purpose, actor_kind=actor_kind, ts=ts,
                               fields=fields, actor=actor)
    with transaction(conn):
        return relayer.queue_scan(conn, settings, event=None, seal=seal, counter=counter, purpose=purpose, actor_kind=actor_kind,
                                  ts=ts, due_at=ts, signed=signed, now=ts)


def test_visitor_caps_per_seal_and_rolling_day(relay_client):
    c = relay_client
    s = c.settings
    a, b = attach(c), attach(c)
    with c.db.connect() as conn:
        seal_a, seal_b = get_seal_by_uid(conn, a), get_seal_by_uid(conn, b)
        t0 = int(time.time())
        taps = [_queue(conn, s, seal_a, n, Purpose.TAP, now=t0) for n in (1, 2, 3, 4)]
        assert [r["status"] for r in taps] == ["queued", "queued", "queued", "over_cap"] and taps[3]["reason"] == "seal_daily"
        checks = [_queue(conn, s, seal_a, n, Purpose.CHECK, now=t0) for n in (5, 6)]
        assert [(r["status"], r["reason"]) for r in checks] == [("queued", None), ("over_cap", "seal_daily")]
        assert _queue(conn, s, seal_b, 1, Purpose.TAP, now=t0)["status"] == "queued"        # seals are independent
        # replaced and failed rows do not count
        conn.execute("UPDATE relay_tx SET status='replaced' WHERE id=?", (taps[0]["id"],))
        assert _queue(conn, s, seal_a, 7, Purpose.TAP, now=t0)["status"] == "queued"
        conn.execute("UPDATE relay_tx SET status='failed', reason='expired' WHERE id=?", (taps[1]["id"],))
        assert _queue(conn, s, seal_a, 8, Purpose.TAP, now=t0)["status"] == "queued"
        assert _queue(conn, s, seal_a, 9, Purpose.TAP, now=t0)["status"] == "over_cap"
        # 24 h later the window has rolled on
        assert _queue(conn, s, seal_a, 10, Purpose.TAP, now=t0 + 86_401)["status"] == "queued"
        assert _queue(conn, s, seal_a, 11, Purpose.CHECK, now=t0 + 86_401)["status"] == "queued"
        # holder purposes are not capped (they still need a fresh counter)
        holder = [_queue(conn, s, seal_a, n, Purpose.CHECK, actor_kind=ActorKind.HOLDER, actor=b"\x05" * 32, now=t0)
                  for n in (12, 13, 14)]
        assert [r["status"] for r in holder] == ["queued"] * 3
    assert relayer.VISITOR_TAPS_PER_SEAL_24H == 3 and relayer.VISITOR_CHECKS_PER_SEAL_24H == 1   # code constants (D16)


def test_no_row_for_a_void_passport_or_a_dead_seal(relay_client):
    c = relay_client
    uid = attach(c)
    with c.db.connect() as conn:
        seal = get_seal_by_uid(conn, uid)
        assert relayer.relayable(conn, seal)
        assert not relayer.relayable(conn, {**seal, "dead": 1}) and not relayer.relayable(conn, {**seal, "kind": 2})
        conn.execute("UPDATE passports SET void=1 WHERE serial=?", (SERIAL,))
        assert _queue(conn, c.settings, seal, 1, Purpose.TAP) is None
    assert rows(c) == []


def test_one_live_row_per_seal_and_counter(relay_client):
    c = relay_client
    uid = attach(c)
    with c.db.connect() as conn:
        seal = get_seal_by_uid(conn, uid)
        first = _queue(conn, c.settings, seal, 3, Purpose.TAP)
        with pytest.raises(sqlite3.IntegrityError):
            _queue(conn, c.settings, seal, 3, Purpose.CHECK)
        relayer.replace_tap(conn, first, int(time.time()))           # once replaced, the counter may take a CHECK
        assert _queue(conn, c.settings, seal, 3, Purpose.CHECK)["status"] == "queued"


# ---------- sending: retries, idempotency, outcomes ----------

def test_resend_only_after_the_blockhash_expired(relay_client):
    c = relay_client
    c.fake.land = False
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    now = row["due_at"]
    run(c, now)
    assert len(c.fake.sent) == 1 and rows(c)[0]["status"] == "sending"
    run(c, now + 2)                                                    # unknown, blockhash still valid: wait
    run(c, now + 4)
    assert len(c.fake.sent) == 1 and rows(c)[0]["status"] == "sending" and budget(c, now) == FEE
    c.fake.block_height = c.fake.last_valid + 1                         # the first attempt can never land now
    c.fake.last_valid += 1000
    out = run(c, now + 6)
    assert out["confirm"]["requeued"] == 1 and len(c.fake.sent) == 2    # re-sent with a new blockhash
    first, second = (str(t.signatures[0]) for t in c.fake.sent)
    assert first != second and rows(c)[0]["sig"] == second and rows(c)[0]["attempts"] == 2
    assert budget(c, now) == FEE                                        # the first estimate was refunded
    c.fake.settle(c.fake.sent[1])
    run(c, now + 8)
    assert rows(c)[0]["status"] == "recorded" and rows(c)[0]["sig"] == second


def test_a_landed_attempt_is_detected_after_a_lost_send_answer(relay_client):
    c = relay_client
    c.fake.land, c.fake.land_then_fail = False, True
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    assert run(c, row["due_at"])["sent"] == {"unknown": 1}
    assert rows(c)[0]["status"] == "sending" and c.state.last_error == "send_unknown"
    run(c, row["due_at"] + 2)
    assert rows(c)[0]["status"] == "recorded" and len(c.fake.sent) == 1   # never sent twice


@pytest.mark.parametrize("plant,reason", [
    (lambda f, uid: plant_chain(f, uid, last_counter=5), "counter_used"),
    (lambda f, uid: plant_chain(f, uid, dead=True), "rejected"),
    (lambda f, uid: (plant_chain(f, uid), f.accounts.pop(str(pda_passport(PID, proof.serial_hash(SERIAL))))), "not_on_chain"),
    (lambda f, uid: (plant_chain(f, uid), f.accounts.pop(str(pda_holding(PID, pda_passport(PID, proof.serial_hash(SERIAL)))))),
     "no_holding"),
])
def test_accounts_decide_before_anything_is_sent(relay_client, plant, reason):
    c = relay_client
    uid = attach(c)
    plant(c.fake, uid)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    run(c, row["due_at"])
    assert c.fake.sent == [] and (rows(c)[0]["status"], rows(c)[0]["reason"]) == ("failed", reason)
    assert c.get(f"/api/tap/{tap_id}").json()["record"]["state"] == "failed" and budget(c, row["due_at"]) == 0


def test_rpc_errors_retry_with_backoff(relay_client):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    now = row["due_at"]
    c.fake.fail["get_latest_blockhash"] = [RpcError("getLatestBlockhash: timed out")]
    assert run(c, now)["sent"] == {"retry": 1}
    r = rows(c)[0]
    assert r["status"] == "queued" and r["attempts"] == 1 and r["due_at"] == now + 2 and c.fake.sent == []
    assert run(c, now + 1)["sent"] == {}                                # backing off
    c.fake.fail["get_multiple_accounts"] = [RpcError("getMultipleAccounts: HTTP 429")]
    run(c, now + 2)
    assert rows(c)[0]["due_at"] == now + 2 + 4                          # 2, 4, 8, 16, 30 s
    # a node error that is not a program error (blockhash not found): not sent, retried, estimate refunded
    c.fake.fail["send_transaction"] = [RpcError("x", error={"code": -32002, "message": "Transaction simulation failed",
                                                             "data": {"err": "BlockhashNotFound", "logs": []}})]
    run(c, now + 6)
    r = rows(c)[0]
    assert r["status"] == "queued" and r["sig"] is None and budget(c, now) == 0 and r["due_at"] == now + 6 + 8
    run(c, now + 14)
    assert rows(c)[0]["status"] == "sending" and len(c.fake.sent) == 1    # the refused attempt never left the node


def test_preflight_program_error_rejects_the_row(relay_client):
    c = relay_client
    uid = attach(c)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    c.fake.fail["send_transaction"] = [RpcError("x", error={
        "code": -32002, "message": "Transaction simulation failed: Error processing Instruction 3: custom program error",
        "data": {"err": {"InstructionError": [3, {"Custom": 6047}]}, "logs": []}})]
    assert run(c, row["due_at"])["sent"] == {"rejected": 1}
    r = rows(c)[0]
    assert (r["status"], r["reason"], r["lamports"], r["sig"]) == ("failed", "rejected", 0, None) and budget(c, row["due_at"]) == 0
    assert event(c, r["event_id"])["tx_sig"] is None and c.get(f"/api/tap/{tap_id}").json()["record"]["reason"] == "rejected"


def test_landed_with_an_error_is_rejected_and_paid(relay_client):
    c = relay_client
    c.fake.land = False
    uid = attach(c)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    run(c, row["due_at"])
    c.fake.settle(c.fake.sent[0], err={"InstructionError": [3, {"Custom": 6020}]}, fee=10_007)
    assert run(c, row["due_at"] + 2)["confirm"]["rejected"] == 1
    r = rows(c)[0]
    assert (r["status"], r["reason"], r["lamports"], r["sig"]) == ("failed", "rejected", 10_007, str(c.fake.sent[0].signatures[0]))
    assert budget(c, row["due_at"]) == 10_007 and event(c, r["event_id"])["tx_sig"] is None   # the fee was paid
    rec = c.get(f"/api/tap/{tap_id}").json()["record"]
    assert rec["state"] == "failed" and rec["txSig"] is None and len(c.fake.sent) == 1


def test_fallback_rpc():
    class Down:
        def get_balance(self, pk):
            raise RpcError("getBalance: connection refused")

        def send_transaction(self, raw):
            raise RpcError("x", error={"code": -32002, "data": {"err": {"InstructionError": [3, {"Custom": 6000}]}}})

    class Up:
        def __init__(self):
            self.calls = []

        def get_balance(self, pk):
            self.calls.append("get_balance")
            return 7

        def send_transaction(self, raw):
            self.calls.append("send_transaction")
            return "sig"

    up = Up()
    rpc = relayer.FallbackRpc(Down(), up)
    assert rpc.get_balance("x") == 7 and up.calls == ["get_balance"]
    with pytest.raises(RpcError):
        rpc.send_transaction(b"")                                    # a program error is the same everywhere
    assert up.calls == ["get_balance"]
    with pytest.raises(RpcError):
        relayer.FallbackRpc(Down()).get_balance("x")                   # no fallback configured

    # sendTransaction after a primary *transport* error: the primary may have forwarded it, so whatever the fallback
    # answers (BlockhashNotFound from a node that is behind, a program error once the first copy landed) is an unknown
    # outcome (no `error`), never "not sent"; AlreadyProcessed is passed on as it is (also unknown for process_row)
    class Lost:
        def send_transaction(self, raw):
            raise RpcError("sendTransaction: timed out")

    def failing(error):
        class Fallback:
            def send_transaction(self, raw):
                raise RpcError("x", error=error)
        return Fallback()

    for error in ({"code": -32002, "data": {"err": "BlockhashNotFound"}}, {"code": -32005, "message": "Node is behind"},
                  {"code": -32002, "data": {"err": {"InstructionError": [3, {"Custom": 6020}]}}}):
        with pytest.raises(RpcError) as got:
            relayer.FallbackRpc(Lost(), failing(error)).send_transaction(b"")
        assert got.value.error is None, error
    already = {"code": -32002, "data": {"err": "AlreadyProcessed"}}
    with pytest.raises(RpcError) as got:
        relayer.FallbackRpc(Lost(), failing(already)).send_transaction(b"")
    assert got.value.error == already
    # a primary that *answered* with a node error did not take it: the fallback's answer stands
    with pytest.raises(RpcError) as got:
        relayer.FallbackRpc(failing({"code": -32005}), failing({"code": -32002, "data": {"err": "BlockhashNotFound"}})).send_transaction(b"")
    assert got.value.error["data"]["err"] == "BlockhashNotFound"


def test_a_send_lost_on_the_primary_is_never_sent_twice_whatever_the_fallback_says(relay_client):
    c = relay_client
    c.fake.land, c.fake.lost_answer = False, True                  # the primary takes the tx, its answer times out

    class BehindFallback:
        """Every call answered like the primary, except sendTransaction: BlockhashNotFound (a node that is behind)."""
        def __getattr__(self, name):
            return getattr(c.fake, name)

        def send_transaction(self, raw):
            raise RpcError("x", error={"code": -32002, "message": "Transaction simulation failed",
                                       "data": {"err": "BlockhashNotFound", "logs": []}})

    rpc = relayer.FallbackRpc(c.fake, BehindFallback())
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    assert REAL_RELAY_ONCE(c.db, c.settings, rpc, c.state, now=row["due_at"])["sent"] == {"unknown": 1}
    r = rows(c)[0]
    assert r["status"] == "sending" and r["sig"] == str(c.fake.sent[0].signatures[0]) and c.state.last_error == "send_unknown"
    assert budget(c, row["due_at"]) == FEE                                      # the estimate stays charged
    REAL_RELAY_ONCE(c.db, c.settings, rpc, c.state, now=row["due_at"] + 2)       # not known yet, blockhash valid: wait
    assert rows(c)[0]["status"] == "sending" and len(c.fake.sent) == 1
    c.fake.settle(c.fake.sent[0])                                              # the first copy landed
    REAL_RELAY_ONCE(c.db, c.settings, rpc, c.state, now=row["due_at"] + 4)
    r = rows(c)[0]
    assert r["status"] == "recorded" and r["sig"] == str(c.fake.sent[0].signatures[0]) and len(c.fake.sent) == 1
    assert event(c, r["event_id"])["tx_sig"] == r["sig"] and budget(c, row["due_at"]) == FEE - 3


def test_daily_budget_cap(relay_client):
    c = relay_client
    c.settings.relay_daily_lamports = FEE - 1
    uid = attach(c)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    run(c, row["due_at"])
    assert c.fake.sent == [] and (rows(c)[0]["status"], rows(c)[0]["reason"]) == ("over_cap", "budget")
    rec = c.get(f"/api/tap/{tap_id}").json()["record"]
    assert rec["state"] == "over_cap" and rec["reason"] == "budget"
    with c.db.connect() as conn:                                        # spent up: health says not ok
        conn.execute("INSERT INTO relay_budget(day, lamports) VALUES(?, ?)", (relayer._day(time.time()), FEE))
    assert c.get("/health").json()["relay"] == {"enabled": True, "ok": False}


def test_low_balance_alert(relay_client, caplog):
    c = relay_client
    attach(c)
    now = time.time()
    run(c, now)
    assert c.get("/health").json()["relay"] == {"enabled": True, "ok": True}
    c.fake.balance = 1
    caplog.set_level(logging.WARNING, logger="fv.relayer")
    run(c, now + 61)
    assert c.state.balance == 1 and c.get("/health").json()["relay"]["ok"] is False
    status = c.get("/api/admin/status", headers=ADMIN).json()["relay"]
    assert status["lowBalance"] is True and status["balanceLamports"] == 1
    run(c, now + 122)                                                   # checked again, but warned at most hourly
    assert c.fake.calls.count("get_balance") == 3
    assert sum("below FV_RELAY_LOW_BALANCE_LAMPORTS" in r.message for r in caplog.records) == 1


def test_deadline_expires_queued_rows(relay_client):
    c = relay_client
    uid = attach(c)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    out = run(c, row["deadline_at"] + 1)
    assert out["expired"] == 1 and c.fake.sent == []
    assert (rows(c)[0]["status"], rows(c)[0]["reason"]) == ("failed", "expired")
    assert c.get(f"/api/tap/{tap_id}").json()["record"]["reason"] == "expired"


def test_the_deadline_is_checked_at_the_claim_not_at_the_cycle_start(relay_client):
    c = relay_client
    uid = attach(c)
    tap_id, _ = t_tap(c, uid)
    (row,) = rows(c)
    start = row["due_at"]
    with c.db.connect() as conn:
        conn.execute("UPDATE relay_tx SET deadline_at=? WHERE id=?", (start + 1, row["id"]))
    clock = [float(start)]
    real_blockhash = c.fake.get_latest_blockhash

    def slow_blockhash():                                              # the RPC calls of this row take 5 s
        clock[0] += 5
        return real_blockhash()
    c.fake.get_latest_blockhash = slow_blockhash
    out = REAL_RELAY_ONCE(c.db, c.settings, c.fake, c.state, now=start, clock=lambda: clock[0])
    assert out["sent"] == {"expired": 1} and "send_transaction" not in c.fake.calls and c.fake.sent == []
    r = rows(c)[0]
    assert (r["status"], r["reason"], r["sig"], r["lamports"]) == ("failed", "expired", None, 0) and budget(c, start) == 0
    assert c.get(f"/api/tap/{tap_id}").json()["record"]["reason"] == "expired"


def test_a_due_check_does_not_override_the_backoff_of_the_row_before_it(relay_client):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)                                                       # counter 1: TAP, due in 185 s
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    assert c.post("/api/verify", json=body(c, tap=tap)).json()["record"]["state"] == "pending"   # counter 2: CHECK, due now
    tap_row, check_row = rows(c)
    now0 = check_row["due_at"]
    c.fake.fail["get_multiple_accounts"] = [RpcError("getMultipleAccounts: HTTP 503")] * 20
    tried = []
    for dt in range(0, 30, 2):                                          # a cycle every 2 s
        before = c.fake.calls.count("get_multiple_accounts")
        run(c, now0 + dt)
        if c.fake.calls.count("get_multiple_accounts") > before:
            tried.append(dt)
    assert tried == [0, 2, 6, 14]                                       # pulled forward once, then 2, 4, 8 s of backoff
    head = rows(c)[0]
    assert head["counter"] == 1 and head["attempts"] == 4 and head["due_at"] == now0 + 14 + 16
    assert rows(c)[1]["attempts"] == 0 and c.fake.sent == []            # the CHECK waits behind it
    c.fake.fail["get_multiple_accounts"] = []                           # the RPC is back
    run(c, now0 + 30)
    run(c, now0 + 32)
    run(c, now0 + 34)
    assert [sent_counter(t) for t in c.fake.sent] == [1, 2] and [r["status"] for r in rows(c)] == ["recorded", "recorded"]


def test_nothing_is_sent_before_holder_config_is_read_and_a_cluster_mismatch_stops(relay_client):
    c = relay_client
    uid = attach(c)
    hc = str(relayer.pda_holder_config(PID))
    held = c.fake.accounts.pop(hc)
    t_tap(c, uid)
    (row,) = rows(c)
    assert run(c, row["due_at"])["waiting"] == "holder_config" and c.fake.sent == []
    assert run(c, row["due_at"] + 30)["waiting"] == "holder_config"     # retried at most every 60 s
    assert c.fake.calls.count("get_account_info") == 1
    c.fake.accounts[hc] = holder_config_account(Cluster.DEVNET)         # another cluster's config
    out = run(c, row["due_at"] + 61)
    assert out["clusterMismatch"] == 1 and c.fake.sent == []
    assert (rows(c)[0]["status"], rows(c)[0]["reason"]) == ("failed", "cluster_mismatch")
    assert c.get("/api/admin/status", headers=ADMIN).json()["relay"]["holderConfigCluster"] == "DEVNET"
    assert decode_holder_config(held)["clusterTag"] == Cluster.LOCALNET
    assert decode_holding(holding_account(Pubkey.new_unique()))["state"] == 2


def test_counters_of_a_seal_land_in_order(relay_client):
    c = relay_client
    uid = attach(c)
    t_tap(c, uid)                                                       # counter 1: TAP, due in 185 s
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    assert c.post("/api/verify", json=body(c, tap=tap)).json()["record"]["state"] == "pending"   # counter 2: CHECK, due now
    tap_row, check_row = rows(c)
    assert (tap_row["counter"], check_row["counter"]) == (1, 2) and check_row["due_at"] < tap_row["due_at"]
    run(c, check_row["due_at"])
    assert [sent_counter(t) for t in c.fake.sent] == [1]                # the due CHECK pulls the TAP forward
    run(c, check_row["due_at"] + 1)                                    # TAP recorded, then the CHECK goes
    assert [sent_counter(t) for t in c.fake.sent] == [1, 2]
    run(c, check_row["due_at"] + 2)
    assert [r["status"] for r in rows(c)] == ["recorded", "recorded"]


# ---------- adoption ----------

def test_check_replaces_the_queued_tap_of_the_adopted_tap(relay_client):
    c = relay_client
    before = c.get(f"/api/passport/{SERIAL}").json()
    uid = attach(c)
    tap_id, token = t_tap(c, uid)
    v = c.post("/api/verify", json=body(c, tap_id=tap_id, token=token, tier=1, indicators={"heat": 1, "humidity": 1, "uv": 3},
                                         heatLevels=[1, 1, 1, 1, 1, 0], fill=30)).json()
    assert v["verdict"] == "VALID" and v["counter"] == 1
    tap_row, check_row = rows(c)
    assert (tap_row["status"], tap_row["purpose"]) == ("replaced", Purpose.TAP)
    assert (check_row["status"], check_row["purpose"], check_row["ref"]) == ("queued", Purpose.CHECK, tap_row["ref"])
    assert check_row["due_at"] == check_row["created_at"] and check_row["event_id"] == v["eventId"]
    assert c.get(f"/api/tap/{tap_id}").json()["record"]["purpose"] == "CHECK"
    run(c, check_row["due_at"])
    run(c, check_row["due_at"] + 1)
    ev = event(c, v["eventId"])
    assert ev["status"] == "confirmed" and ev["tx_sig"] == rows(c)[1]["sig"]
    after = c.get(f"/api/passport/{SERIAL}").json()
    # a visitor CHECK that read heat + humidity TRIGGERED and fill 30: evidence only, the passport stays as it was
    assert (after["grade"], after["void"], after["latest"]) == (before["grade"], before["void"], before["latest"])
    ids = [e["id"] for e in after["events"]]
    assert tap_row["event_id"] not in ids and v["eventId"] in ids     # the sighting of the replaced TAP is gone
    shown = [e for e in after["events"] if e["id"] == v["eventId"]][0]
    assert shown["scanBy"] == "VISITOR" and shown["purpose"] == "CHECK" and shown["payload"]["confirmed"]["source"] == "fvscan2"
    assert shown["payload"]["msgHex"] == check_row["msg_hex"]          # public once recorded


def test_check_over_cap_keeps_the_tap(relay_client):
    c = relay_client
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    assert c.post("/api/verify", json=body(c, tap=tap)).json()["record"]["state"] == "pending"   # the seal's one CHECK
    tap_id, token = t_tap(c, uid)
    v = c.post("/api/verify", json=body(c, tap_id=tap_id, token=token)).json()
    assert v["verdict"] == "VALID" and v["record"]["state"] == "over_cap" and v["record"]["reason"] == "seal_daily"
    first_check, tap_row, check_row = rows(c)
    assert tap_row["status"] == "queued" and check_row["status"] == "over_cap" and tap_row["ref"] == check_row["ref"]
    ev = event(c, v["eventId"])
    assert ev["status"] == "confirmed" and ev["tx_sig"] is None        # kept off chain, never failed
    assert c.get(f"/api/tap/{tap_id}").json()["record"]["purpose"] == "TAP"   # the tap's live row is its TAP
    ids = [e["id"] for e in c.get(f"/api/passport/{SERIAL}").json()["events"]]
    assert tap_row["event_id"] in ids                                  # the TAP was not replaced: its sighting stays
    # the TAP then never makes it (here: its deadline passes): the CHECK is the one entry of that tap
    run(c, tap_row["deadline_at"] + 1)
    assert (rows(c)[1]["status"], rows(c)[1]["reason"]) == ("failed", "expired")
    events = c.get(f"/api/passport/{SERIAL}").json()["events"]
    assert tap_row["event_id"] not in [e["id"] for e in events] and v["eventId"] in [e["id"] for e in events]


def test_adoption_after_the_tap_was_sent_is_a_replay(relay_client):
    c = relay_client
    uid = attach(c)
    tap_id, token = t_tap(c, uid)
    (row,) = rows(c)
    c.fake.land = False
    run(c, row["due_at"])                                              # sent (relay clock), still inside the adopt window
    assert rows(c)[0]["status"] == "sending"
    b = body(c, tap_id=tap_id, token=token)
    v = c.post("/api/verify", json=b).json()
    assert v["verdict"] == "REPLAY" and v["serverSig"] is None and v["record"] is None and v["grade"] == Grade.VOID
    with c.db.connect() as conn:                                       # nothing consumed: nonce, adoption
        assert conn.execute("SELECT used_at FROM nonces WHERE nonce_hex=?", (b["nonce"][2:],)).fetchone()[0] is None
        assert conn.execute("SELECT adopted_at FROM taps WHERE id=?", (tap_id,)).fetchone()[0] is None
    assert len(rows(c)) == 1
    w = c.post("/api/verify", json=body(c, tap_id=tap_id, token=token, anchor="wallet")).json()
    assert w["verdict"] == "REPLAY"                                    # the wallet path too


def test_a_relay_check_adopting_a_tap_shows_it_once_with_the_relay_off(client):
    """FV_RELAY_ENABLED unset (the production default): the /t TAP row fails relay_off at once, so the CHECK replaces
    nothing; the sighting of the same tap is dropped all the same, as the v1 path does."""
    before = client.get(f"/api/passport/{SERIAL}").json()
    uid = attach(client)
    tap_id, token = t_tap(client, uid)
    (tap_row,) = rows(client)
    assert (tap_row["status"], tap_row["reason"]) == ("failed", "relay_off")
    v = client.post("/api/verify", json=body(client, tap_id=tap_id, token=token)).json()
    assert v["verdict"] == "VALID" and v["record"]["state"] == "failed"
    after = client.get(f"/api/passport/{SERIAL}").json()
    uh = "0x" + proof.uid_hash(bytes.fromhex(uid)).hex()
    same_tap = [e for e in after["events"] if e["type"] == 2 and e["sealUidHash"] == uh and e["payload"].get("counter") == v["counter"]]
    assert [e["id"] for e in same_tap] == [v["eventId"]]                # one tap, one entry
    assert after["stats"]["scanCount"] == before["stats"]["scanCount"] + 1


def test_wallet_adoption_replaces_the_tap(relay_client):
    c = relay_client
    uid = attach(c)
    tap_id, token = t_tap(c, uid)
    v = c.post("/api/verify", json=body(c, tap_id=tap_id, token=token, anchor=None)).json()
    assert v["verdict"] == "VALID" and len(bytes.fromhex(v["msgHex"])) == 152 and v["anchor"] == "wallet"
    assert v["purpose"] is None and v["actorKind"] is None and v["record"] is None and v["cluster"] == "LOCALNET"
    (row,) = rows(c)
    assert row["status"] == "replaced"
    run(c, row["due_at"])
    assert c.fake.sent == []


# ---------- API contract ----------

def test_relay_answer_and_bundle(relay_client):
    c = relay_client
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    attester = str(Keypair().pubkey())
    v = c.post("/api/verify", json=body(c, tap=tap, tier=2, role=1, mediaHash="0x" + "ab" * 32, note="kept private",
                                         location={"country": "de", "city": "Wickede"}, attester=attester)).json()
    assert v["verdict"] == "VALID" and v["anchor"] == "relay" and v["purpose"] == "CHECK" and v["actorKind"] == "NONE"
    assert v["cluster"] == "LOCALNET" and v["resumeToken"]
    rec = v["record"]
    assert rec["state"] == "pending" and rec["purpose"] == "CHECK" and rec["eventId"] == v["eventId"] and rec["dueAt"]
    msg = bytes.fromhex(v["msgHex"])
    assert len(msg) == 256 and msg[:7] == b"FVSCAN2"
    assert proof.verify(bytes.fromhex(v["serverPubkey"]), msg, bytes.fromhex(v["serverSig"][2:]))
    m = proof.parse_message_v2(msg)
    assert (m["purpose"], m["actor_kind"], m["tier"], m["role"], m["fill"], m["cluster_tag"]) == (1, 0, 2, 1, 92, 3)
    assert m["media_hash"] == b"\xab" * 32
    canonical = proof.canonical_json(v["bundle"])
    assert set(v["bundle"]) == set(proof.BUNDLE2_KEYS) and v["bundle"]["schema"] == proof.BUNDLE2_SCHEMA
    for private in ("kept private", "Wickede", "IOS_WEB", attester, "platform", "note", "city"):
        assert private not in canonical, private
    assert v["bundle"]["location"] == {"country": "DE"} and v["bundle"]["actor"] == {"kind": "NONE", "id": None}
    assert proof.bundle_hash(canonical) == m["bundle_hash"] and v["bundleHash"] == "0x" + m["bundle_hash"].hex()
    # the detail stays in SQLite only
    p = json.loads(event(c, v["eventId"])["payload_json"])
    assert p["visual"]["note"] == "kept private" and p["location"]["city"] == "Wickede" and p["device"]["platform"] == "IOS_WEB"
    assert p["attester"]["pubkey"] == attester and p["anchor"] == "relay" and p["bundleV2"] == v["bundle"]
    assert event(c, v["eventId"])["city"] is None                       # not even in the events.city column
    # while not recorded, nobody else sees the signed FVSCAN2
    shown = [e for e in c.get(f"/api/passport/{SERIAL}").json()["events"] if e["id"] == v["eventId"]][0]
    assert "msgHex" not in shown["payload"] and shown["payload"]["server"]["sig"] is None
    assert shown["payload"]["bundleV2"]["session"]["nonce"] is None and shown["status"] == "pending"

    def private_detail_hidden(shown):
        text = json.dumps(shown)
        for private in ("kept private", "Wickede", "IOS_WEB", attester):
            assert private not in text, private
        assert shown["location"] == {"country": "DE", "city": None} and shown["payload"]["location"] == {"country": "DE"}
        assert "device" not in shown["payload"] and "pubkey" not in shown["payload"]["attester"]
        assert "note" not in shown["payload"]["visual"] and shown["scanBy"] == "VISITOR"
    private_detail_hidden(shown)
    # the resume link is for wallet scans only; the record endpoint reads the state with the same token
    assert c.get(f"/api/verify/{v['eventId']}?token={v['resumeToken']}").status_code == 404
    r = c.get(f"/api/verify/{v['eventId']}/record?token={v['resumeToken']}")
    assert r.status_code == 200 and r.json() == {"eventId": v["eventId"], "record": rec}
    for bad in (f"/api/verify/{v['eventId']}/record?token=wrong", f"/api/verify/{v['eventId']}/record",
                f"/api/verify/999999/record?token={v['resumeToken']}"):
        assert c.get(bad).json()["detail"] == "record_not_found"
    # a relay scan is never confirmed with a wallet tx
    assert c.post("/api/events", json={"eventId": v["eventId"], "txSig": "1" * 88}).status_code == 422
    # recorded → the record says so, with the transaction
    run(c, rec["dueAt"])
    run(c, rec["dueAt"] + 1)
    got = c.get(f"/api/verify/{v['eventId']}/record?token={v['resumeToken']}").json()["record"]
    assert got["state"] == "recorded" and got["txSig"] == rows(c)[0]["sig"] and got["dueAt"] is None and got["reason"] is None
    shown = [e for e in c.get(f"/api/passport/{SERIAL}").json()["events"] if e["id"] == v["eventId"]][0]
    assert shown["status"] == "confirmed" and shown["payload"]["msgHex"] == v["msgHex"]       # public once recorded
    private_detail_hidden(shown)


def test_requests_refused_before_the_tap_is_used(relay_client):
    c = relay_client
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    cases = [
        (dict(ticket="anything"), 403, "ticket_invalid"),
        (dict(ticket=""), 403, "ticket_invalid"),
        (dict(purpose="LIST"), 403, "ticket_required"),
        (dict(purpose="RECEIPT"), 403, "ticket_required"),
        (dict(purpose="TAP"), 422, "purpose_invalid"),
        (dict(purpose="SELL"), 422, "purpose_invalid"),
        (dict(anchor="wallet", purpose="LIST"), 422, "purpose_invalid"),
        (dict(anchor="wallet", ticket="t"), 403, "ticket_invalid"),
        (dict(tier=3, mediaHash="0x" + "ab" * 32), 422, "relay_not_for_certified"),
        (dict(role=3, tier=2, mediaHash="0x" + "ab" * 32), 422, "relay_not_for_certified"),
        (dict(tier=0, indicators={"heat": 3, "humidity": 3, "uv": 3}, heatLevels=[0] * 6), 422, "scan_fields_invalid"),
    ]
    for over, status, detail in cases:
        r = c.post("/api/verify", json=body(c, tap=tap, **over))
        assert (r.status_code, r.json().get("detail")) == (status, detail), over
    assert c.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()["verdict"] == "VALID"
    assert rows(c) == []
    v = c.post("/api/verify", json=body(c, tap=tap, purpose="CHECK")).json()
    assert v["verdict"] == "VALID" and v["record"]["state"] == "pending"


def test_wallet_anchor_is_refused_for_a_pass_held_in_an_account(relay_client):
    c = relay_client
    uid = attach(c)
    holding = pda_holding(PID, pda_passport(PID, proof.serial_hash(SERIAL)))
    with c.db.connect() as conn:
        conn.execute("UPDATE passports SET asset=? WHERE serial=?", (str(holding), SERIAL))
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    r = c.post("/api/verify", json=body(c, tap=tap, anchor="wallet"))
    assert r.status_code == 409 and r.json()["detail"] == "wallet_anchor_not_allowed"
    assert c.post("/api/preview", json={"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"]}).json()["verdict"] == "VALID"
    v = c.post("/api/verify", json=body(c, tap=tap)).json()             # the public record path takes it
    assert v["verdict"] == "VALID" and v["anchor"] == "relay"
    w = c.post("/api/verify", json=body(c, tap=c.post("/api/dev/tap", json={"uid": uid}).json(), anchor="wallet"))
    assert w.status_code == 409
    # a wallet scan of a pass not held in an account has no record endpoint
    with c.db.connect() as conn:
        conn.execute("UPDATE passports SET asset=NULL WHERE serial=?", (SERIAL,))
    wv = c.post("/api/verify", json=body(c, tap=c.post("/api/dev/tap", json={"uid": uid}).json(), anchor="wallet")).json()
    assert wv["verdict"] == "VALID"
    assert c.get(f"/api/verify/{wv['eventId']}/record?token={wv['resumeToken']}").json()["detail"] == "record_not_found"
    assert c.get(f"/api/verify/{wv['eventId']}?token={wv['resumeToken']}").json()["anchor"] == "wallet"


def test_check_on_a_void_passport_stays_off_chain(relay_client):
    c = relay_client
    uid = attach(c)
    with c.db.connect() as conn:
        conn.execute("UPDATE passports SET void=1, grade=4 WHERE serial=?", (SERIAL,))
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    v = c.post("/api/verify", json=body(c, tap=tap)).json()
    assert v["verdict"] == "VALID" and v["record"] is None and rows(c) == []
    assert event(c, v["eventId"])["status"] == "confirmed"
    assert c.get(f"/api/verify/{v['eventId']}/record?token={v['resumeToken']}").json() == {"eventId": v["eventId"], "record": None}


def test_scan_by_labels():
    partners = {"P1"}
    def r(actor=None):
        return {"actor_pubkey": actor}
    assert scan_by(r(), {"actorKind": "NONE", "indicators": {}}, partners) == "VISITOR"
    assert scan_by(r(), {"actorKind": "HOLDER"}, partners) == "HOLDER" and scan_by(r(), {"actorKind": "WALLET"}, None) == "HOLDER"
    assert scan_by(r(), {"actorKind": "PARTNER"}, None) == "PARTNER" and scan_by(r(), {"actorKind": "RECIPIENT"}, None) == "RECIPIENT"
    assert scan_by(r(), {"tier": 0, "counter": 3}, partners) == "VISITOR"                              # a /t sighting
    v1 = {"indicators": {"heat": 0}, "attester": {"pubkey": "W", "tier": 2}}
    assert scan_by(r("W"), v1, partners) == "VISITOR"                                                   # an owner's own wallet
    assert scan_by(r("P1"), v1, partners) == "PARTNER"                                                  # a registry partner
    assert scan_by(r("W"), {**v1, "chain": {"tier": 3}}, partners) == "PARTNER"                          # verified tier ≥ 3
    assert scan_by(r("X"), {**v1, "attester": {"pubkey": "W", "tier": 4}}, partners) == "VISITOR"        # a claim by someone else


def test_passport_events_carry_scan_by_and_purpose(client):
    events = client.get(f"/api/passport/{SERIAL}").json()["events"]
    scans = [e for e in events if e["type"] == 2]
    assert scans and all(e["scanBy"] in ("VISITOR", "HOLDER", "PARTNER", "RECIPIENT") and e["purpose"] is None for e in scans)
    assert all("scanBy" not in e and "purpose" not in e for e in events if e["type"] != 2)


def test_health_and_admin_status_hold_no_secret(relay_client):
    c = relay_client
    c.settings.holder_keypair, c.settings.issuer_keypair = Keypair(), Keypair()
    h = c.get("/health").json()
    assert h["ok"] is True and h["cluster"] == "localnet" and h["relay"] == {"enabled": True, "ok": False}   # config not read yet
    attach(c)
    run(c, time.time())
    assert c.get("/health").json()["relay"] == {"enabled": True, "ok": True}
    st = c.get("/api/admin/status", headers=ADMIN).json()["relay"]
    assert st["enabled"] is True and st["cluster"] == "LOCALNET" and st["holderConfigCluster"] == "LOCALNET"
    assert st["relayer"] == str(c.settings.relayer_keypair.pubkey()) and st["holderKey"] == str(c.settings.holder_keypair.pubkey())
    assert st["issuerKey"] == str(c.settings.issuer_keypair.pubkey()) and st["balanceLamports"] == 10**9
    assert st["dailyCapLamports"] == 10_000_000 and {"queued", "sending", "recorded24h", "overCap24h", "failed24h",
                                                     "spentTodayLamports", "lowBalance", "lastError"} <= set(st)
    assert c.get("/api/admin/status").status_code == 403
    texts = c.get("/health").text + c.get("/api/admin/status", headers=ADMIN).text
    assert str(c.settings.relayer_keypair.pubkey()) not in c.get("/health").text
    for kp in (c.settings.relayer_keypair, c.settings.holder_keypair, c.settings.issuer_keypair):
        secret = bytes(kp)
        for form in (str(kp), secret.hex(), secret[:32].hex(), json.dumps(list(secret)), json.dumps(list(secret))[:40]):
            assert form not in texts


def test_secrets_never_reach_logs_or_repr(relay_client, caplog):
    c = relay_client
    caplog.set_level(logging.DEBUG)
    uid = attach(c)
    t_tap(c, uid)
    (row,) = rows(c)
    c.fake.fail["send_transaction"] = [RpcError("sendTransaction: https://rpc.example/?api-key=placeholder-key-123 refused")]
    run(c, row["due_at"])
    run(c, row["due_at"] + 1)
    kp = c.settings.relayer_keypair
    for form in (str(kp), bytes(kp).hex(), json.dumps(list(bytes(kp))), "placeholder-key-123"):
        assert form not in caplog.text
    raw = json.dumps(list(bytes(Keypair())))
    s = Settings(server_seed_hex=TEST_SEED_HEX, relayer_key_json=raw)
    assert s.relayer_keypair is not None and s.relayer_key_json == "" and raw not in repr(s) and raw[:30] not in repr(s)


# ---------- reconcile ----------

def test_reconcile_skips_relay_scans_and_confirms_sent_rows(relay_client):
    c = relay_client
    c.settings.reconcile_timeout_s = 50
    before = c.get(f"/api/passport/{SERIAL}").json()
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    v = c.post("/api/verify", json=body(c, tap=tap)).json()
    ev = event(c, v["eventId"])
    reconcile_once(c.db, c.settings, c.fake, ts=ev["ts"] + 100)        # v1 would time it out: relay scans are not checked
    assert event(c, v["eventId"])["status"] == "pending" and rows(c)[0]["status"] == "queued"
    run(c, ev["ts"] + 101)                                             # sent; landed
    assert rows(c)[0]["status"] == "sending"
    summary = reconcile_once(c.db, c.settings, c.fake, ts=ev["ts"] + 102)
    assert summary["relay"]["confirm"]["recorded"] == 1 and rows(c)[0]["status"] == "recorded"
    ev = event(c, v["eventId"])
    assert ev["status"] == "confirmed" and ev["tx_sig"] == rows(c)[0]["sig"]
    after = c.get(f"/api/passport/{SERIAL}").json()
    assert (after["grade"], after["void"], after["latest"]) == (before["grade"], before["void"], before["latest"])
    assert after["stats"]["onChainScanCount"] == before["stats"]["onChainScanCount"] + 1


def test_reconcile_expires_relay_rows_with_the_relay_off(client):
    uid = attach(client)
    s = client.app.state.settings
    with client.app.state.db.connect() as conn:                        # a row queued while the relay was still on
        seal = get_seal_by_uid(conn, uid)
        s.relay_enabled = True
        row = _queue(conn, s, seal, 99, Purpose.CHECK)
        s.relay_enabled = False
    assert row["status"] == "queued"
    out = reconcile_once(client.app.state.db, s, FakeRpc(), ts=row["deadline_at"] + 1)
    assert out["relay"] == {"expired": 1}
    with client.app.state.db.connect() as conn:
        assert tuple(conn.execute("SELECT status, reason FROM relay_tx WHERE id=?", (row["id"],)).fetchone()) == ("failed", "expired")


def test_arweave_queue_skips_relay_scans(relay_client):
    from fv.db import arweave_queue
    c = relay_client
    uid = attach(c)
    tap = c.post("/api/dev/tap", json={"uid": uid}).json()
    v = c.post("/api/verify", json=body(c, tap=tap, tier=2, mediaHash="0x" + "cd" * 32)).json()
    run(c, v["record"]["dueAt"])
    run(c, v["record"]["dueAt"] + 1)
    assert event(c, v["eventId"])["status"] == "confirmed"
    with c.db.connect() as conn:
        assert v["eventId"] not in [e["id"] for e in arweave_queue(conn, int(time.time()) + 10, 100)]


# ---------- startup refusals (§9.1) ----------

def _kp_json(kp: Keypair | None = None) -> str:
    return json.dumps(list(bytes(kp or Keypair())))


def test_startup_refusals():
    base = dict(server_seed_hex=TEST_SEED_HEX, program_id=PROGRAM_ID)

    def problems(**kw) -> list[str]:
        return Settings(**{**base, **kw}).relay_problems()

    ok_relay = dict(relay_enabled=True, relayer_key_json=_kp_json(), cluster="devnet")
    assert problems(**ok_relay) == []
    assert any("without FV_RELAYER_KEY" in p for p in problems(relay_enabled=True))
    assert any("without FV_PROGRAM_ID" in p for p in problems(**{**ok_relay, "program_id": ""}))
    secret_text = "[1, 2, 3, super-secret"
    got = problems(relayer_key_json=secret_text)
    assert any(p.startswith("FV_RELAYER_KEY is not a Solana keypair") for p in got) and all("super-secret" not in p for p in got)
    a, b = Keypair(), Keypair()
    mismatched = json.dumps(list(bytes(a)[:32] + bytes(b)[32:]))
    assert any("FV_HOLDER_KEY is not" in p for p in problems(holder_key_json=mismatched))
    assert any("FV_ISSUER_KEY is not" in p for p in problems(issuer_key_json=json.dumps(list(range(63)))))
    same = _kp_json()
    assert any("same key" in p for p in problems(relayer_key_json=same, issuer_key_json=same))
    scan_kp = Keypair.from_seed(bytes.fromhex(TEST_SEED_HEX))
    assert any("FV_RELAYER_KEY and FV_SERVER_ED25519_SEED" in p for p in problems(relayer_key_json=_kp_json(scan_kp)))
    assert any("FV_CLUSTER must be" in p for p in problems(cluster="testnet"))
    assert any("localnet with a non-local" in p for p in problems(cluster="localnet"))
    assert any("localnet with a non-local" in p
               for p in problems(cluster="localnet", solana_rpc=LOCAL_RPC, solana_rpc_fallback="https://api.devnet.solana.com"))
    assert problems(cluster="localnet", solana_rpc=LOCAL_RPC) == []
    assert any("against a local RPC" in p for p in problems(**ok_relay, solana_rpc=LOCAL_RPC))
    assert any("mainnet with FV_DEV_SIMULATOR" in p for p in problems(cluster="mainnet", dev_simulator=True))
    assert any("FV_DEV_SIMULATOR=true against a shared cluster" in p for p in problems(**ok_relay, dev_simulator=True))
    assert problems(**{**ok_relay, "cluster": "localnet"}, dev_simulator=True, solana_rpc=LOCAL_RPC) == []
    # parse_keypair keeps only the keypair
    kp = Keypair()
    parsed, problem = parse_keypair(_kp_json(kp), "FV_RELAYER_KEY")
    assert problem is None and parsed.pubkey() == kp.pubkey()
    assert parse_keypair("", "FV_RELAYER_KEY") == (None, None)


def test_lifespan_refuses_an_incomplete_relay(settings):
    from fv.main import create_app
    settings.relay_enabled = True
    settings.program_id = PROGRAM_ID
    with pytest.raises(RuntimeError, match="without FV_RELAYER_KEY"):
        with TestClient(create_app(settings)):
            pass


def test_settings_from_env_reads_the_relay_variables(monkeypatch):
    kp = Keypair()
    env = {"FV_CLUSTER": "Mainnet", "FV_RELAY_ENABLED": "true", "FV_RELAYER_KEY": _kp_json(kp),
           "FV_SOLANA_RPC_FALLBACK": " https://fallback.example ", "FV_RELAY_DAILY_LAMPORTS": "123",
           "FV_RELAY_LOW_BALANCE_LAMPORTS": "45", "FV_RELAY_CU_LIMIT": "200000", "FV_RELAY_MAX_PRIORITY_MICROLAMPORTS": "7",
           "FV_RELAY_INTERVAL_S": "0.5"}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    s = settings_from_env()
    assert (s.cluster, s.cluster_tag, s.relay_enabled, s.relayer_pubkey) == ("mainnet", Cluster.MAINNET, True, str(kp.pubkey()))
    assert (s.solana_rpc_fallback, s.relay_daily_lamports, s.relay_low_balance_lamports, s.relay_cu_limit,
            s.relay_max_priority_microlamports, s.relay_interval_s) == ("https://fallback.example", 123, 45, 200_000, 7, 0.5)
    assert s.holder_pubkey is None and s.issuer_pubkey is None and s.v2_program_id == "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL"
    with pytest.raises(ValueError):
        Settings(server_seed_hex=TEST_SEED_HEX, relay_cu_limit=0)


# ---------- IDL parity (once the programs group regenerated packages/proof/src/idl/flacon.json) ----------

def test_record_scan_v2_accounts_match_the_idl():
    from tests.conftest import REPO
    idl = json.loads((REPO / "packages" / "proof" / "src" / "idl" / "flacon.json").read_text(encoding="utf-8"))
    ix = next((i for i in idl["instructions"] if i["name"] == "record_scan_v2"), None)
    if ix is None:
        pytest.skip("the IDL has no record_scan_v2 yet (regenerated by the programs group after anchor build)")
    assert bytes(ix["discriminator"]) == relayer.RECORD_SCAN_V2_DISC
    assert tuple(a["name"] for a in ix["accounts"]) == relayer.RECORD_SCAN_V2_ACCOUNTS
    assert {a["name"] for a in ix["accounts"] if a.get("writable")} == relayer.RECORD_SCAN_V2_WRITABLE
    assert {a["name"] for a in ix["accounts"] if a.get("signer")} <= {"actor_signer"}
    assert {a["name"] for a in ix["accounts"] if a.get("optional")} == {"actor_signer", "asset"}
