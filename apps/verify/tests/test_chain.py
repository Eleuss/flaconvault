"""PDA derivation against the local validator's known values; account decoders on hand-built bytes."""
import struct

import pytest
from solders.pubkey import Pubkey

from fv import proof
from fv.chain import (ACCOUNT_DISC, ORDER_LEN, DecodeError, PASSPORT_LEN, SCAN_PROOF_LEN, SEAL_LEN, decode_order, decode_passport,
                      decode_registry, decode_scan_proof, decode_seal, is_account, pda_passport, pda_registry, pda_scan, pda_seal)
from tests.conftest import PROGRAM_ID

ASSET = Pubkey.from_string("4FQoaiZa5NGcjJK5qzZ2VnXFa8MBM7TZEtyruU2wu6ck")
ISSUER = Pubkey.from_string("PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR")
SELLER = Pubkey.from_string("7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2")
BUYER = Pubkey.from_string("9QmaNdyTfApH7LZZNsrp4xJAqkChViZwVc5TDGgeHkx1")
FOREIGN_DISC = b"\xd1" * 8


def test_pda_fixtures_from_local_validator():
    assert str(pda_passport(PROGRAM_ID, proof.serial_hash("SN-2026-000001"))) == "5ewvSxUE88xsHkJvdx385KbjcJDs5FrArSptgnSnTwAT"
    assert str(pda_seal(PROGRAM_ID, proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")))) == "Hnhdd1ppPTq1Ek22VhSErfz8urfLu9w43ANovzytCxCY"
    reg = pda_registry(PROGRAM_ID)
    assert isinstance(reg, Pubkey) and reg == pda_registry(Pubkey.from_string(PROGRAM_ID))
    seal = pda_seal(PROGRAM_ID, proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")))
    s14, s15 = pda_scan(PROGRAM_ID, seal, 14), pda_scan(PROGRAM_ID, seal, 15)
    assert s14 != s15 and s14 == Pubkey.find_program_address([b"scan", bytes(seal), (14).to_bytes(4, "little")], Pubkey.from_string(PROGRAM_ID))[0]


def scan_proof_bytes(*, seal: Pubkey, counter=14, tier=2, role=1, tamper=3, uv=3, hum=0, heat=0, heat_mask=3, fill=92, site_id=0,
                     media_hash=b"\x11" * 32, bundle_hash=b"\x22" * 32, attester=SELLER, key_id=1, ts=1790000012, bump=254) -> bytes:
    return (ACCOUNT_DISC["ScanProof"] + bytes(seal) + struct.pack("<I", counter) + bytes([tier, role, tamper, uv, hum, heat, heat_mask, fill])
            + struct.pack("<H", site_id) + media_hash + bundle_hash + bytes(attester) + bytes([key_id]) + struct.pack("<q", ts) + bytes([bump]))


def passport_bytes(*, serial_hash=b"\x01" * 32, binding_hash=b"\x02" * 32, asset=ASSET, issuer=ISSUER, grade=2, scan_count=14,
                   seal_count=1, void=False, created_at=1789459200, bump=253) -> bytes:
    return (ACCOUNT_DISC["Passport"] + serial_hash + binding_hash + bytes(asset) + bytes(issuer) + bytes([grade]) + struct.pack("<I", scan_count)
            + bytes([seal_count, int(void)]) + struct.pack("<q", created_at) + bytes([bump]))


def seal_bytes(*, passport=ASSET, kind=1, uid_hash=b"\x03" * 32, last_counter=14, dead=False, attached_at=1789459500, bump=252) -> bytes:
    return ACCOUNT_DISC["Seal"] + bytes(passport) + bytes([kind]) + uid_hash + struct.pack("<I", last_counter) + bytes([int(dead)]) + struct.pack("<q", attached_at) + bytes([bump])


def registry_bytes(*, authority=ISSUER, keys=(), partners=(), sites=()) -> bytes:
    out = ACCOUNT_DISC["Registry"] + bytes(authority) + struct.pack("<I", len(keys))
    for k in keys:
        out += bytes([k["keyId"]]) + bytes.fromhex(k["pubkeyHex"]) + struct.pack("<qq", k["validFrom"], k["validTo"])
    out += struct.pack("<I", len(partners)) + b"".join(bytes(p) for p in partners)
    out += struct.pack("<I", len(sites))
    for sid, label in sites:
        out += struct.pack("<H", sid) + label.encode("utf-8").ljust(32, b"\x00")
    return out + b"\xff"   # bump / trailing space must be tolerated


def order_bytes(*, passport=ASSET, seller=SELLER, buyer=None, asset=ASSET, price=480_000_000, state=0, listed_at=1790000000,
                reserved_at=0, shipped_at=0, seller_scan=None, buyer_scan=None, dispute_after_s=604800, asset_deposited=False,
                bump=255, vault_bump=0) -> bytes:
    zero = bytes(32)
    return (ACCOUNT_DISC["Order"] + bytes(passport) + bytes(seller) + (bytes(buyer) if buyer else zero) + bytes(asset)
            + struct.pack("<QB", price, state) + struct.pack("<qqq", listed_at, reserved_at, shipped_at)
            + (bytes(seller_scan) if seller_scan else zero) + (bytes(buyer_scan) if buyer_scan else zero)
            + struct.pack("<q", dispute_after_s) + bytes([int(asset_deposited), bump, vault_bump]))


def test_decode_scan_proof():
    seal = pda_seal(PROGRAM_ID, proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")))
    data = scan_proof_bytes(seal=seal)
    assert len(data) == SCAN_PROOF_LEN
    d = decode_scan_proof(data)
    assert d == {"seal": str(seal), "counter": 14, "tier": 2, "role": 1, "tamper": 3, "uv": 3, "hum": 0, "heat": 0, "heatLevelsMask": 3,
                 "fill": 92, "siteId": 0, "mediaHash": "11" * 32, "bundleHash": "22" * 32, "attester": str(SELLER), "serverKeyId": 1,
                 "ts": 1790000012, "bump": 254}
    with pytest.raises(DecodeError):
        decode_scan_proof(data[:-10])


def test_decode_passport_and_seal():
    p = decode_passport(passport_bytes())
    assert len(passport_bytes()) == PASSPORT_LEN
    assert p["serialHash"] == "01" * 32 and p["asset"] == str(ASSET) and p["issuer"] == str(ISSUER) and p["grade"] == 2
    assert p["scanCount"] == 14 and p["sealCount"] == 1 and p["void"] is False and p["createdAt"] == 1789459200 and p["bump"] == 253
    assert decode_passport(passport_bytes(void=True, grade=4))["void"] is True
    s = decode_seal(seal_bytes())
    assert len(seal_bytes()) == SEAL_LEN
    assert s == {"passport": str(ASSET), "kind": 1, "uidHash": "03" * 32, "lastCounter": 14, "dead": False, "attachedAt": 1789459500, "bump": 252}
    assert decode_seal(seal_bytes(dead=True, last_counter=99))["dead"] is True
    with pytest.raises(DecodeError):
        decode_seal(seal_bytes()[:20])


def test_decode_registry():
    key = {"keyId": 1, "pubkeyHex": "8ddafff75fe35b174d24fca867f796bc253e32363a456f3486214f01c457ee01", "validFrom": 1789000000, "validTo": 1900000000}
    data = registry_bytes(keys=[key], partners=[ISSUER, SELLER], sites=[(1, "Parfümerie X, Düsseldorf"), (2, "FlaconVault Vault, Wickede")])
    r = decode_registry(data)
    assert r["authority"] == str(ISSUER) and r["serverKeys"] == [key] and r["partners"] == [str(ISSUER), str(SELLER)]
    assert r["sites"] == [{"siteId": 1, "label": "Parfümerie X, Düsseldorf"}, {"siteId": 2, "label": "FlaconVault Vault, Wickede"}]
    assert decode_registry(registry_bytes()) == {"authority": str(ISSUER), "serverKeys": [], "partners": [], "sites": []}


def test_discriminators_match_the_idls():
    import json
    from pathlib import Path
    idl_dir = Path(__file__).resolve().parents[3] / "packages" / "proof" / "src" / "idl"
    for program in ("flacon", "escrow"):
        for acct in json.loads((idl_dir / f"{program}.json").read_text(encoding="utf-8"))["accounts"]:
            assert ACCOUNT_DISC[acct["name"]] == bytes(acct["discriminator"]), acct["name"]


def test_decoders_reject_empty_short_and_foreign_accounts():
    """A SOL transfer to a PDA creates a system-owned account without data; that must never decode as a ScanProof."""
    seal = pda_seal(PROGRAM_ID, proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")))
    good = scan_proof_bytes(seal=seal)
    for bad in (b"", b"\x00" * 7, FOREIGN_DISC + good[8:], passport_bytes()):
        with pytest.raises(DecodeError):
            decode_scan_proof(bad)
        assert not is_account(bad, "ScanProof")
    with pytest.raises(DecodeError):
        decode_scan_proof(None)
    assert is_account(good, "ScanProof") and not is_account(None, "ScanProof")
    with pytest.raises(DecodeError, match="foreign discriminator"):
        decode_passport(seal_bytes())
    with pytest.raises(DecodeError):
        decode_seal(FOREIGN_DISC + seal_bytes()[8:])
    with pytest.raises(DecodeError):
        decode_registry(b"")


def test_decode_order():
    data = order_bytes(buyer=BUYER, state=5, price=1_500_000, reserved_at=1790000100)
    assert len(data) == ORDER_LEN
    o = decode_order(data)
    assert o["passport"] == str(ASSET) and o["seller"] == str(SELLER) and o["buyer"] == str(BUYER) and o["price"] == 1_500_000
    assert o["state"] == 5 and o["stateName"] == "RELEASED" and o["reservedAt"] == 1790000100 and o["disputeAfterS"] == 604800
    assert o["sellerScan"] == "11111111111111111111111111111111" and o["assetDeposited"] is False and o["bump"] == 255
    assert decode_order(order_bytes())["buyer"] is None                       # Pubkey::default() until reserved
    with pytest.raises(DecodeError):
        decode_order(order_bytes()[:100])


def test_rpc_signature_statuses_and_program_accounts(monkeypatch):
    import base64
    import httpx
    from fv.chain import Rpc

    class Resp:
        def __init__(self, body): self._b = body
        def raise_for_status(self): pass
        def json(self): return self._b

    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append(json)
        if json["method"] == "getSignatureStatuses":
            sigs = json["params"][0]
            assert json["params"][1] == {"searchTransactionHistory": True} and len(sigs) <= 256
            return Resp({"result": {"value": [{"slot": 1, "err": None, "confirmationStatus": "finalized"} if s.startswith("2") else None
                                              for s in sigs]}})
        if json["method"] == "getProgramAccounts":
            assert json["params"][1]["filters"] == [{"dataSize": ORDER_LEN}]
            return Resp({"result": [{"pubkey": "Order1", "account": {"data": [base64.b64encode(order_bytes()).decode(), "base64"]}},
                                    {"pubkey": "Order2", "account": {"data": None}}]})
        raise AssertionError(json["method"])

    monkeypatch.setattr(httpx, "post", fake_post)
    rpc = Rpc("http://127.0.0.1:8899")
    sigs = ["2" * 88] * 300 + ["3" * 88, "not-a-signature", ""]
    st = rpc.get_signature_statuses(sigs)
    assert len(st) == len(sigs) and all(s is not None for s in st[:300]) and st[300:] == [None, None, None]
    status_calls = [c for c in calls if c["method"] == "getSignatureStatuses"]
    assert [len(c["params"][0]) for c in status_calls] == [256, 45]          # malformed signatures never reach the RPC
    assert rpc.get_program_accounts("9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL", data_size=ORDER_LEN) == [("Order1", order_bytes())]
