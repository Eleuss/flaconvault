"""2. message bytes + signature, 3. grade rule + heat mask, 4. canonical bundle — all against docs/vectors.json."""
import json

from nacl.signing import VerifyKey

from fv import proof
from fv.enums import VALID


def _msg(i: dict) -> bytes:
    return proof.build_message(serial_hash=proof.serial_hash(i["serial"]), uid_hash=proof.uid_hash(bytes.fromhex(i["uidHex"])),
                               counter=i["counter"], tamper=i["tamper"], uv=i["uv"], hum=i["hum"], heat=i["heat"], fill=i["fill"],
                               media_hash=bytes.fromhex(i["mediaHashHex"]), nonce=bytes.fromhex(i["nonceHex"]), ts=i["ts"])


def test_constants(vectors):
    c = vectors["constants"]
    assert proof.MSG_PREFIX == c["MSG_PREFIX"].encode() and proof.MSG_LEN == c["MSG_LEN"]
    assert proof.BUNDLE_SCHEMA == c["BUNDLE_SCHEMA"] and proof.HEAT_DECISIVE_INDEX == c["HEAT_DECISIVE_INDEX"]


def test_hash_fixtures(vectors):
    for h in vectors["hashes"]["serial"]:
        assert proof.serial_hash(h["serial"]).hex() == h["sha256Hex"]
    for h in vectors["hashes"]["uid"]:
        assert proof.uid_hash(bytes.fromhex(h["uidHex"])).hex() == h["sha256Hex"]
    for h in vectors["hashes"]["binding"]:
        assert proof.binding_hash(h["serial"], h["batchCode"], proof.uid_hash(bytes.fromhex(h["firstSealUidHex"]))).hex() == h["sha256Hex"]


def test_server_test_key(vectors):
    k = vectors["serverTestKey"]
    assert proof.public_key(bytes.fromhex(k["seedHex"])).hex() == k["pubkeyHex"]


def test_message_bytes_and_signature(vectors):
    seed = bytes.fromhex(vectors["serverTestKey"]["seedHex"])
    pub = bytes.fromhex(vectors["serverTestKey"]["pubkeyHex"])
    for s in vectors["scans"]:
        i = s["input"]
        msg = _msg(i)
        assert len(msg) == proof.MSG_LEN
        assert msg.hex() == s["msgHex"], s["name"]
        assert proof.serial_hash(i["serial"]).hex() == s["serialHashHex"]
        assert proof.uid_hash(bytes.fromhex(i["uidHex"])).hex() == s["uidHashHex"]
        sig = proof.sign(seed, msg)
        assert sig.hex() == s["sigHex"], s["name"]
        VerifyKey(pub).verify(msg, sig)                     # raises on failure
        assert proof.verify(pub, msg, sig) and not proof.verify(pub, msg[:-1] + bytes([msg[-1] ^ 1]), sig)
        p = proof.parse_message(msg)
        assert p["counter"] == i["counter"] and p["fill"] == i["fill"] and p["ts"] == i["ts"] and p["heat"] == i["heat"]


def test_grade_rule_vs_grades_table(vectors):
    for g in vectors["grades"]:
        grade, review = proof.compute_grade(verdict=g["verdict"], tamper=g["tamper"], heat=g["heat"], hum=g["hum"],
                                            fill=g["fill"], seal_dead=g["sealDead"])
        assert (grade, review) == (g["grade"], g["reviewRecommended"]), g


def test_grade_and_heat_mask_vs_scans(vectors):
    for s in vectors["scans"]:
        i = s["input"]
        grade, review = proof.compute_grade(verdict=VALID, tamper=i["tamper"], heat=i["heat"], hum=i["hum"], fill=i["fill"])
        assert (grade, review) == (s["grade"], s["reviewRecommended"]), s["name"]
        assert proof.heat_levels_to_mask(i["heatLevels"]) == s["heatMask"]
        assert proof.mask_to_heat_levels(s["heatMask"]) == i["heatLevels"]
        assert i["heat"] in (2, 3) or i["heat"] == i["heatLevels"][proof.HEAT_DECISIVE_INDEX]


def test_canonical_bundle_rebuilt_from_input(vectors):
    seed = bytes.fromhex(vectors["serverTestKey"]["seedHex"])
    for s in vectors["scans"]:
        i = s["input"]
        ref = json.loads(s["bundleCanonical"])
        sig = proof.sign(seed, _msg(i))
        media = bytes.fromhex(i["mediaHashHex"])
        bundle = proof.build_bundle(
            serial=i["serial"], serial_hash_b=proof.serial_hash(i["serial"]), uid_hash_b=proof.uid_hash(bytes.fromhex(i["uidHex"])),
            counter=i["counter"], seal_kind={"BOX": 0, "NECK": 1}[ref["seal"]["kind"]], tamper=i["tamper"], heat=i["heat"],
            hum=i["hum"], uv=i["uv"], heat_levels=i["heatLevels"], fill=i["fill"], country=ref["location"]["country"],
            city=ref["location"]["city"], media_hash_b=media if i["tier"] >= 2 else None, media_ar=None,
            nonce_b=bytes.fromhex(i["nonceHex"]), issued_at=ref["session"]["issuedAt"], platform=ref["device"]["platform"],
            role=i["role"], tier=i["tier"], attester=ref["attester"]["pubkey"], key_id=1, verdict=VALID, server_ts=i["ts"],
            sig_b=sig, bundle_ts=ref["ts"])
        canonical = proof.canonical_json(bundle)
        assert canonical == s["bundleCanonical"], s["name"]
        assert proof.bundle_hash(canonical).hex() == s["bundleHashHex"]
        # re-canonicalising the reference gives the same bytes (no whitespace, sorted keys, non-ASCII verbatim)
        assert proof.canonical_json(ref) == s["bundleCanonical"]
