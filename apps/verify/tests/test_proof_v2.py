"""FVSCAN2 (public record, docs/public-record.md §3–5): proof.py v2 builders byte-identical to packages/proof (docs/vectors.json
v2.*) and to the hard-coded §5 example."""
import hashlib

import pytest

from fv import proof
from fv.chain import (ACCOUNT_DISC, pda_event_authority, pda_holder_config, pda_holding, pda_passport, pda_registry, pda_seal)
from fv.enums import ActorKind, Cluster, Grade, HoldingState, Purpose
from tests.conftest import VECTORS

TEST_SEED = bytes.fromhex(VECTORS["serverTestKey"]["seedHex"])   # the documented TEST key, never registered on a cluster


def _inputs(v2: dict, s: dict) -> dict:
    i = s["input"]
    return dict(program_id=bytes.fromhex(v2["programIdHex"]), cluster_tag=v2["clusterTag"], serial=i["serial"],
                uid_hash_b=proof.uid_hash(bytes.fromhex(i["uidHex"])), seal_kind=i["sealKind"], counter=i["counter"],
                purpose=i["purpose"], actor_kind=i["actorKind"], actor=bytes.fromhex(i["actorHex"]), tier=i["tier"],
                role=i["role"], site_id=i["siteId"], tamper=i["tamper"], heat=i["heat"], hum=i["hum"], uv=i["uv"],
                heat_levels=proof.heat_levels_to_mask(i["heatLevels"]), fill=i["fill"], country=i["country"],
                media_hash_b=bytes.fromhex(i["mediaHashHex"]), nonce_b=bytes.fromhex(i["nonceHex"]), issued_at=i["issuedAt"],
                ts=i["ts"])


def test_constants_and_enums(vectors, enums_doc):
    c = vectors["constants"]
    assert proof.MSG2_PREFIX.decode() == c["MSG2_PREFIX"] and proof.MSG2_LEN == c["MSG2_LEN"] == 256
    assert proof.SCAN_HEAD_PREFIX.decode() == c["SCAN_HEAD_PREFIX"] and proof.COMMITMENT_PREFIX.decode() == c["COMMITMENT_PREFIX"]
    assert proof.FILL_NONE == c["FILL_NONE"] == 255 and proof.BUNDLE2_SCHEMA == c["BUNDLE2_SCHEMA"]
    assert c["PDA_SEEDS"]["holder_config"] == "holder_config" and c["PDA_SEEDS"]["holding"] == "holding"
    assert Purpose.as_dict() == enums_doc["purpose"] and ActorKind.as_dict() == enums_doc["actor_kind"]
    assert Cluster.as_dict() == enums_doc["cluster"] and HoldingState.as_dict() == enums_doc["holding_state"]
    assert Purpose.TAP == 0 and Purpose.BIRTH == 6 and ActorKind.RECIPIENT == 4 and Cluster.DEVNET == 2 and Cluster.LOCALNET == 3


def test_offsets_table_matches_the_layout():
    o = proof.MSG2_OFFSETS
    assert o["program_id"] == len(proof.MSG2_PREFIX) == 7 and o["ts"] + 8 == proof.MSG2_LEN
    widths = {"program_id": 32, "cluster_tag": 1, "serial_hash": 32, "uid_hash": 32, "counter": 4, "tier": 1, "role": 1,
              "tamper": 1, "uv": 1, "hum": 1, "heat": 1, "heat_levels": 1, "fill": 1, "site_id": 2, "purpose": 1,
              "actor_kind": 1, "actor": 32, "media_hash": 32, "bundle_hash": 32, "nonce": 32, "ts": 8}
    order = sorted(widths, key=o.get)
    for a, b in zip(order, order[1:]):
        assert o[a] + widths[a] == o[b], (a, b)


def test_every_v2_vector_reproduces(vectors):
    v2 = vectors["v2"]
    seed = bytes.fromhex(vectors["serverTestKey"]["seedHex"])
    pub = bytes.fromhex(vectors["serverTestKey"]["pubkeyHex"])
    head = proof.SCAN_HEAD_ZERO
    assert head.hex() == v2["scanHead"]["initialHex"]
    for s in v2["scans"]:
        bundle, b_hash, msg, sig = proof.build_scan_v2(seed=seed, key_id=vectors["serverTestKey"]["keyId"], **_inputs(v2, s))
        assert proof.canonical_json(bundle) == s["bundleCanonical"], s["name"]
        assert b_hash.hex() == s["bundleHashHex"] and msg.hex() == s["msgHex"] and len(msg) == 256, s["name"]
        assert hashlib.sha256(msg).hexdigest() == s["msgSha256Hex"] and sig.hex() == s["sigHex"] and proof.verify(pub, msg, sig)
        ix = proof.ed25519_ix_data(pub, sig, msg)
        assert ix.hex() == s["ed25519IxHex"] and len(ix) == 368
        assert proof.parse_ed25519_ix_data(ix) == {"pubkey": pub, "sig": sig, "msg": msg}
        head = proof.fold_scan_head(head, msg)
        assert head.hex() == s["headAfterHex"], s["name"]
        assert tuple(sorted(bundle)) == tuple(sorted(proof.BUNDLE2_KEYS))
        # round trip: parse → build gives the same bytes
        m = proof.parse_message_v2(msg)
        assert proof.build_message_v2(**m) == msg
        assert m["heat_levels"] == s["heatMask"] and m["fill"] == s["input"]["fill"] and m["purpose"] == s["input"]["purpose"]
    assert head.hex() == v2["scanHead"]["finalHex"] and len(v2["scans"]) == v2["scanHead"]["count"]


def test_grade_rule_v2_follows_the_vectors(vectors):
    grade, void = Grade.A, False
    for s in vectors["v2"]["scans"]:
        i = s["input"]
        assert proof.actor_changes_grade(i["actorKind"]) == s["affectsGrade"], s["name"]
        if s["affectsGrade"]:
            grade, void = proof.passport_after_scan_v2(grade, void, tamper=i["tamper"], heat=i["heat"], hum=i["hum"], fill=i["fill"])
        assert (grade, void) == (s["gradeAfter"], s["voidAfter"]), s["name"]
    # FILL_NONE (no reading) keeps A/B/D, still applies C and VOID
    assert proof.passport_after_scan_v2(Grade.D, False, tamper=3, heat=3, hum=3, fill=proof.FILL_NONE) == (Grade.D, False)
    assert proof.passport_after_scan_v2(Grade.B, False, tamper=3, heat=1, hum=3, fill=proof.FILL_NONE) == (Grade.C, False)
    assert proof.passport_after_scan_v2(Grade.B, False, tamper=1, heat=3, hum=3, fill=proof.FILL_NONE) == (Grade.VOID, True)


def test_commitments_pdas_and_discriminators(vectors):
    v2 = vectors["v2"]
    for c in v2["commitments"]:
        got = proof.commitment(bytes.fromhex(c["passportHex"]), c["epoch"], bytes.fromhex(c["secretHex"]))
        assert got.hex() == c["commitmentHex"]
        assert bytes.fromhex(c["secretHex"]) == hashlib.sha256(c["secretLabel"].encode()).digest()
    pid = v2["programId"]
    passport = pda_passport(pid, proof.serial_hash("SN-2026-000001"))
    seal = pda_seal(pid, proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")))
    assert {"registry": str(pda_registry(pid)), "passport": str(passport), "seal": str(seal),
            "holderConfig": str(pda_holder_config(pid)), "holding": str(pda_holding(pid, passport)),
            "eventAuthority": str(pda_event_authority(pid))} == v2["pdas"]
    d = v2["discriminators"]
    from fv.relayer import RECORD_SCAN_V2_DISC
    assert RECORD_SCAN_V2_DISC.hex() == d["global:record_scan_v2"] == "047bf48d93f81ff1"
    assert ACCOUNT_DISC["HolderConfig"].hex() == d["account:HolderConfig"] and ACCOUNT_DISC["Holding"].hex() == d["account:Holding"]


def test_section5_example_hardcoded():
    """docs/public-record.md §5 — pinned here too, so a generator bug cannot move both sides at once."""
    seed = TEST_SEED
    pid = bytes.fromhex("626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29")
    bundle, b_hash, msg, sig = proof.build_scan_v2(
        seed=seed, key_id=1, program_id=pid, cluster_tag=Cluster.DEVNET, serial="SN-2026-000001",
        uid_hash_b=proof.uid_hash(bytes.fromhex("04A1B2C3D4E5F6")), seal_kind=1, counter=2, purpose=Purpose.TAP,
        actor_kind=ActorKind.NONE, actor=proof.ZERO32, tier=0, role=0, site_id=0, tamper=3, heat=3, hum=3, uv=3, heat_levels=0,
        fill=proof.FILL_NONE, country=None, media_hash_b=proof.ZERO32, nonce_b=hashlib.sha256(b"nonce-v2-2").digest(),
        issued_at=1790000200, ts=1790000200)
    assert proof.canonical_json(bundle) == (
        '{"actor":{"id":null,"kind":"NONE"},"attester":{"role":0,"siteId":0,"tier":0},"cluster":"DEVNET","counter":2,'
        '"fill":null,"heatLevels":[0,0,0,0,0,0],"indicators":{"heat":3,"humidity":3,"uv":3},"location":{"country":null},'
        '"media":[],"programId":"7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL","purpose":"TAP","schema":"flaconvault.scanbundle.v2",'
        '"seal":{"kind":"NECK","uidHash":"0x8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442"},'
        '"serial":"SN-2026-000001","serialHash":"0x4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583",'
        '"server":{"keyId":1,"ts":1790000200,"verdict":"VALID"},'
        '"session":{"issuedAt":1790000200,"nonce":"0x7901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9"},'
        '"tamper":3,"visual":{"loopIntact":null}}')
    assert b_hash.hex() == "f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c5"
    assert msg.hex() == (
        "46565343414e32626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29024c998d75c9a8c68768696a2e66ffc2f5"
        "a9ffca930654a86195d9ac73656bb5838150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f4420200000000000303"
        "030300ff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        "00000000000000000000000000000000f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c57901d90ad597c5f8"
        "487066b825a50787de157139840a90588212209db0c9b5a9483cb16a00000000")
    assert hashlib.sha256(msg).hexdigest() == "57bfd9ce941c81cc5366e6edf0d16527881074db75319eb5c72c47b1adef4bf4"
    assert sig.hex() == ("9cf4283eb2cf31048abbfd736186a3de9427f46aae760c9a8acc233225430b8d6d7822b905b2dce5d13c921770ae8ed6"
                         "3f2df2788ee2d4658e7c6e2d3d6e6c0f")
    assert proof.ed25519_ix_data(proof.public_key(seed), sig, msg)[:16].hex() == "01003000ffff1000ffff70000001ffff"
    head1 = proof.fold_scan_head(proof.ZERO32, bytes.fromhex(_birth_msg_hex()))
    assert hashlib.sha256(bytes.fromhex(_birth_msg_hex())).hexdigest() == "d1d5cabfaa2495705fa2cfd6dbd467639830ce5004998feeb845e9857a1cafa0"
    assert head1.hex() == "7d3c88a08935f19eb946f4f0efaa9c45da862bd5c052bb2fea3dcb74aeabbab7"
    assert proof.fold_scan_head(head1, msg).hex() == "6fcae69855734dc31f0eeef62edbe448fe3a0e2091b9c2208d55e6e5332565e7"
    passport = bytes.fromhex("4527566c42a505d1b5fab981cff855a485020dc5abe34b365ace5fd57c225ffc")
    secret0 = hashlib.sha256(b"flaconvault:test-holder-secret:0").digest()
    assert secret0.hex() == "9a529ee0b6ce1682b208fcb6554f1176705b04fb991134fbfe336c075bd7ce3f"
    assert proof.commitment(passport, 0, secret0).hex() == "24088cd63896f3d8f4e55b031307f84429c5e16a039d5f6fa1e4a0e983649fe5"
    secret1 = hashlib.sha256(b"flaconvault:test-holder-secret:1").digest()
    assert proof.commitment(passport, 1, secret1).hex() == "09b1c3a5ff50a1f70512c08f7159f65c510e4af74f4fa56b4959a9b0925411fd"


def _birth_msg_hex() -> str:
    return VECTORS["v2"]["scans"][0]["msgHex"]


def test_reject_corpus(vectors):
    """v2.rejects: each message breaks exactly one §3.4 rule; check_fields_v2 names the program's error."""
    rejects = vectors["v2"]["rejects"]
    assert len(rejects) >= 19
    for r in rejects:
        m = proof.parse_message_v2(bytes.fromhex(r["msgHex"]))
        with pytest.raises(proof.ScanFieldError) as e:
            proof.check_fields_v2(m)
        assert e.value.code == r["error"], r["name"]
        with pytest.raises(proof.ScanFieldError):
            proof.build_message_v2(**m)


def test_builder_rules_outside_the_corpus():
    base = proof.parse_message_v2(bytes.fromhex(_birth_msg_hex()))
    for over, code in (({"cluster_tag": 0}, "InvalidClusterTag"), ({"cluster_tag": 4}, "InvalidClusterTag"),
                       ({"counter": 0x01000000}, "CounterOutOfRange"), ({"site_id": 9}, None)):
        f = {**base, **over}
        if code is None:
            proof.check_fields_v2(f)                                   # a pro role may name a site …
            with pytest.raises(proof.ScanFieldError) as e:
                proof.check_fields_v2(f, known_sites={1})              # … that must be registered
            assert e.value.code == "UnknownSite"
            continue
        with pytest.raises(proof.ScanFieldError) as e:
            proof.check_fields_v2(f)
        assert e.value.code == code
    visitor = proof.parse_message_v2(bytes.fromhex(VECTORS["v2"]["scans"][1]["msgHex"]))
    with pytest.raises(proof.ScanFieldError) as e:
        proof.check_fields_v2({**visitor, "actor": b"\x01" * 32})
    assert e.value.code == "ActorMismatch"


def test_parsers_keep_the_two_domains_apart(vectors):
    s = vectors["v2"]["scans"][1]
    with pytest.raises(ValueError):
        proof.parse_message_v2(bytes.fromhex(s["msgHex"])[:152])
    v1 = bytes.fromhex(vectors["scans"][0]["msgHex"]) if "msgHex" in vectors["scans"][0] else b"FVSCAN1" + bytes(145)
    with pytest.raises(ValueError):
        proof.parse_message_v2(v1 + bytes(256 - len(v1)))              # FVSCAN1 padded to 256 bytes: wrong prefix
    with pytest.raises(ValueError):
        proof.parse_message(bytes.fromhex(s["msgHex"]))                 # v1 parser: only 152 bytes
    pub, sig = bytes(32), bytes(64)
    v1_ix = proof.ed25519_ix_data(pub, sig, b"FVSCAN1" + bytes(145))
    assert len(v1_ix) == 264
    with pytest.raises(ValueError, match="152 bytes, expected 256"):
        proof.parse_ed25519_ix_data(v1_ix)
    assert proof.parse_ed25519_ix_data(v1_ix, message_len=152)["msg"][:7] == b"FVSCAN1"
    ix = bytearray(bytes.fromhex(s["ed25519IxHex"]))
    ix[4:6] = (3).to_bytes(2, "little")                                  # signature in another instruction
    with pytest.raises(ValueError):
        proof.parse_ed25519_ix_data(bytes(ix))
    assert proof.parse_ed25519_ix_data(bytes(ix), own_index=3)["msg"].hex() == s["msgHex"]


def test_bundle_v2_keeps_private_detail_out():
    bundle = proof.build_bundle_v2(program_id=bytes(32), cluster_tag=Cluster.DEVNET, serial="SN-2026-000001",
                                   uid_hash_b=bytes(32), seal_kind=0, counter=5, purpose=Purpose.CHECK,
                                   actor_kind=ActorKind.NONE, actor=proof.ZERO32, tier=2, role=0, site_id=0, tamper=3,
                                   heat=0, hum=0, uv=3, heat_levels=3, fill=92, loop_intact=None, country="DE",
                                   media_hash_b=b"\x11" * 32, nonce_b=b"\x22" * 32, issued_at=1, key_id=1, server_ts=2)
    text = proof.canonical_json(bundle)
    for word in ("note", "city", "platform", "device", "pubkey", "logger", '"ar"', '"sig"'):
        assert word not in text, word
    assert bundle["media"] == [{"type": "SEAL_FRAMES", "sha256": "0x" + "11" * 32}] and bundle["actor"] == {"kind": "NONE", "id": None}
    assert set(bundle) == set(proof.BUNDLE2_KEYS) and "ts" not in bundle
    with pytest.raises(ValueError):
        proof.build_bundle_v2(**{**dict(program_id=bytes(32), cluster_tag=2, serial="SN-1", uid_hash_b=bytes(32), seal_kind=2,
                                        counter=1, purpose=0, actor_kind=0, actor=bytes(32), tier=0, role=0, site_id=0, tamper=3,
                                        heat=3, hum=3, uv=3, heat_levels=0, fill=255, loop_intact=None, country=None,
                                        media_hash_b=bytes(32), nonce_b=bytes(32), issued_at=1, key_id=1, server_ts=1)})
