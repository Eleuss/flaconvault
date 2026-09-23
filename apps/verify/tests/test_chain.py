"""PDA derivation against the local validator's known values; account decoders on hand-built bytes."""
import struct

import pytest
from solders.pubkey import Pubkey

from fv import proof
from fv.chain import (DecodeError, PASSPORT_LEN, SCAN_PROOF_LEN, SEAL_LEN, decode_passport, decode_registry,
                      decode_scan_proof, decode_seal, pda_passport, pda_registry, pda_scan, pda_seal)
from tests.conftest import PROGRAM_ID

ASSET = Pubkey.from_string("4FQoaiZa5NGcjJK5qzZ2VnXFa8MBM7TZEtyruU2wu6ck")
ISSUER = Pubkey.from_string("PxPGKQsGTYE2ti3awtEae4Yjk64NF2tcxQN1oDchhyR")
SELLER = Pubkey.from_string("7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2")
DISC = b"\xd1" * 8


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
    return (DISC + bytes(seal) + struct.pack("<I", counter) + bytes([tier, role, tamper, uv, hum, heat, heat_mask, fill])
            + struct.pack("<H", site_id) + media_hash + bundle_hash + bytes(attester) + bytes([key_id]) + struct.pack("<q", ts) + bytes([bump]))


def passport_bytes(*, serial_hash=b"\x01" * 32, binding_hash=b"\x02" * 32, asset=ASSET, issuer=ISSUER, grade=2, scan_count=14,
                   seal_count=1, void=False, created_at=1789459200, bump=253) -> bytes:
    return (DISC + serial_hash + binding_hash + bytes(asset) + bytes(issuer) + bytes([grade]) + struct.pack("<I", scan_count)
            + bytes([seal_count, int(void)]) + struct.pack("<q", created_at) + bytes([bump]))


def seal_bytes(*, passport=ASSET, kind=1, uid_hash=b"\x03" * 32, last_counter=14, dead=False, attached_at=1789459500, bump=252) -> bytes:
    return DISC + bytes(passport) + bytes([kind]) + uid_hash + struct.pack("<I", last_counter) + bytes([int(dead)]) + struct.pack("<q", attached_at) + bytes([bump])


def registry_bytes(*, authority=ISSUER, keys=(), partners=(), sites=()) -> bytes:
    out = DISC + bytes(authority) + struct.pack("<I", len(keys))
    for k in keys:
        out += bytes([k["keyId"]]) + bytes.fromhex(k["pubkeyHex"]) + struct.pack("<qq", k["validFrom"], k["validTo"])
    out += struct.pack("<I", len(partners)) + b"".join(bytes(p) for p in partners)
    out += struct.pack("<I", len(sites))
    for sid, label in sites:
        out += struct.pack("<H", sid) + label.encode("utf-8").ljust(32, b"\x00")
    return out + b"\xff"   # bump / trailing space must be tolerated


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
