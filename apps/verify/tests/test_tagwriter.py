"""NXP TagWriter SDM format: uid=<UID>x<CTR>x<MAC> in one parameter."""
from fv.service import split_tagwriter


def test_split_tagwriter_format():
    uid, ctr, cmac = split_tagwriter("04A1B2C3D4E5F6x00000Ex6F3A0B1C2D3E4F50", "000000", "0000000000000000")
    assert (uid, ctr, cmac) == ("04A1B2C3D4E5F6", "00000E", "6F3A0B1C2D3E4F50")


def test_split_tagwriter_leaves_normal_params_alone():
    assert split_tagwriter("04A1B2C3D4E5F6", "00000E", "6F3A0B1C2D3E4F50") == ("04A1B2C3D4E5F6", "00000E", "6F3A0B1C2D3E4F50")
    assert split_tagwriter(None, None, None) == (None, None, None)


def test_tagwriter_tap_is_valid(client):
    """A TagWriter-style URL with a real simulator CMAC verifies like a normal tap."""
    tag = client.post("/api/dev/tag", json={"serial": "SN-2026-000001"}).json()
    tap = client.post("/api/dev/tap", json={"uid": tag["uid"]}).json()
    combined = f"{tap['uid']}x{tap['ctrHex']}x{tap['cmac']}"
    r = client.get("/t", params={"uid": combined, "ctr": "000000", "cmac": "0000000000000000", "format": "json"})
    assert r.status_code == 200, r.text
    assert r.json()["verdict"] == "VALID", r.json()
