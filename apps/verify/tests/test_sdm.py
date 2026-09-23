"""1. SDM plain vectors (valid/invalid), simulator CMAC generation, AN12196 encrypted reference via libsdm.
   7. AN10922 key diversification + FV_KEY_MODE switch."""
import binascii

import pytest

from fv import sdm
from fv.sdm import diversify, key_for_uid, parse_cmac, parse_ctr, parse_uid, sdm_cmac, tag_url, validate_tap, TagParamError
from libsdm.sdm import EncMode, InvalidMessage, ParamMode, decrypt_sun_message, validate_plain_sun


def test_plain_vectors_from_vectors_json(vectors):
    for v in vectors["sdm"]["plain"]:
        uid, ctr, cmac, key = (bytes.fromhex(v["uidHex"]), int(v["ctrHex"], 16), bytes.fromhex(v["cmacHex"]), bytes.fromhex(v["keyHex"]))
        assert validate_tap(uid, ctr, cmac, key) is v["valid"], v


def test_plain_sdm_libsdm_direct():
    # ported from icedevml/sdm-backend tests/test_libsdm.py::test_plain_sdm
    res = validate_plain_sun(uid=binascii.unhexlify("041E3C8A2D6B80"), read_ctr=binascii.unhexlify("000006"),
                             sdmmac=binascii.unhexlify("4B00064004B0B3D3"),
                             sdm_file_read_key=binascii.unhexlify("00000000000000000000000000000000"), mode=EncMode.AES)
    assert res["uid"] == binascii.unhexlify("041E3C8A2D6B80") and res["read_ctr"] == 6
    with pytest.raises(InvalidMessage):
        validate_plain_sun(uid=binascii.unhexlify("041E3C8A2D6B80"), read_ctr=binascii.unhexlify("000006"),
                           sdmmac=binascii.unhexlify("AB00064004B0B3AB"),
                           sdm_file_read_key=binascii.unhexlify("00000000000000000000000000000000"), mode=EncMode.AES)


def test_simulator_generates_reference_cmac(vectors):
    assert sdm_cmac(bytes.fromhex("041E3C8A2D6B80"), 6, bytes(16)).hex().upper() == "4B00064004B0B3D3"
    # round trip for a few counters with the factory key
    uid = bytes.fromhex("04A1B2C3D4E5F6")
    for ctr in (1, 14, 0xFFFFFF):
        assert validate_tap(uid, ctr, sdm_cmac(uid, ctr, sdm.FACTORY_KEY), sdm.FACTORY_KEY)
        assert not validate_tap(uid, ctr + 1 if ctr < 0xFFFFFF else ctr - 1, sdm_cmac(uid, ctr, sdm.FACTORY_KEY), sdm.FACTORY_KEY)


def test_an12196_encrypted_reference_via_libsdm(vectors):
    ref = vectors["sdm"]["encrypted_reference"][0]
    res = decrypt_sun_message(param_mode=ParamMode.SEPARATED, sdm_meta_read_key=bytes(16), sdm_file_read_key=lambda _: bytes(16),
                              picc_enc_data=bytes.fromhex(ref["picc_data"]), sdmmac=bytes.fromhex(ref["cmac"]))
    assert res["picc_data_tag"] == b"\xc7"
    assert res["uid"].hex().upper() == ref["uidHex"]
    assert res["read_ctr"] == ref["ctr"]
    assert res["encryption_mode"] == EncMode.AES


def test_url_and_param_parsing(vectors):
    uid = bytes.fromhex("04A1B2C3D4E5F6")
    url = tag_url("https://<verifier-host>", uid, 14, bytes.fromhex("6F3A0B1C2D3E4F50"))
    assert url == vectors["urlExample"]
    assert parse_ctr("00000E") == 14 and parse_ctr(14) == 14
    assert parse_uid("04a1b2c3d4e5f6") == uid
    assert parse_cmac("6f3a0b1c2d3e4f50") == bytes.fromhex("6F3A0B1C2D3E4F50")
    for bad in (lambda: parse_uid("04A1B2"), lambda: parse_ctr("0E"), lambda: parse_ctr("zz0000"), lambda: parse_cmac("00"),
                lambda: parse_ctr(-1)):
        with pytest.raises(TagParamError):
            bad()


def test_an10922_published_vector():
    k = diversify(bytes.fromhex("00112233445566778899AABBCCDDEEFF"), bytes.fromhex("04782E21801D80"),
                  bytes.fromhex("3042F5"), b"NXP Abu")
    assert k.hex().upper() == "A8DD63A3B89D54B37CA802473FDA9175"


def test_key_mode_switch(vectors):
    c = vectors["constants"]
    assert sdm.KEY_DIV_APP_ID == bytes.fromhex(c["KEY_DIV_APP_ID_HEX"]) and sdm.KEY_DIV_SYS_ID == c["KEY_DIV_SYS_ID"].encode()
    uid = bytes.fromhex("04A1B2C3D4E5F6")
    assert key_for_uid("factory", bytes(16), uid) == bytes(16)
    k = key_for_uid("diversified", bytes(16), uid)
    assert len(k) == 16 and k != bytes(16)
    assert k == diversify(bytes(16), uid, sdm.KEY_DIV_APP_ID, sdm.KEY_DIV_SYS_ID)
    assert key_for_uid("diversified", bytes(16), bytes.fromhex("04DE5F1EACC040")) != k
    with pytest.raises(ValueError):
        key_for_uid("nope", bytes(16), uid)
