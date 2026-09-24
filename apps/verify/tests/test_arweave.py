"""Arweave via the Irys sidecar — sidecar mocked at the subprocess boundary (fv.arweave._run_sidecar); no network."""
import hashlib
import io
import json
import subprocess
from pathlib import Path

import pytest

import fv.arweave as aw
from fv import proof

SERIAL = "SN-2026-000001"
SELLER = "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2"


class FakeSidecar:
    """Stands in for `node upload.mjs …`: records the call and returns a deterministic receipt."""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, args, settings):
        path = Path(args[-1])
        data = path.read_bytes()
        tags = dict(a.split("=", 1) for i, a in enumerate(args) if i > 0 and args[i - 1] == "--tag")
        n = len(self.calls) + 1
        id_ = f"FAKE{n:02d}" + "x" * 37
        self.calls.append({"args": args, "tags": tags, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                           "text": data.decode("utf-8", "replace"), "id": id_})
        return {"id": id_, "url": f"https://gateway.irys.xyz/{id_}", "ar": f"ar://{id_}", "bytes": len(data)}


@pytest.fixture()
def ar_client(settings, monkeypatch):
    from fastapi.testclient import TestClient
    from fv.main import create_app
    settings.arweave = True
    settings.irys_key = "default"
    fake = FakeSidecar()
    monkeypatch.setattr(aw, "_run_sidecar", fake)
    with TestClient(create_app(settings)) as c:
        c.fake = fake
        yield c


def _upload(client, frames: list[bytes], content_type="image/jpeg"):
    files = [("files", (f"frame{i}.jpg", io.BytesIO(b), content_type)) for i, b in enumerate(frames)]
    r = client.post("/api/media", files=files)
    assert r.status_code == 200, r.text
    return r.json()


def _verify(client, uid, media_hash, **over):
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = client.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "mediaHash": media_hash,
            "attester": SELLER, "platform": "SIMULATOR", "location": {"country": "DE", "city": "Wickede"}}
    body.update(over)
    v = client.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID", v
    return v


def test_media_single_image_and_cache(ar_client, settings):
    data = b"\xff\xd8\xff\xe0" + b"jpeg-bytes" * 50
    m = _upload(ar_client, [data])
    assert m["sha256"] == "0x" + hashlib.sha256(data).hexdigest() and m["bytes"] == len(data) and m["files"] == 1
    assert m["ar"] == "ar://" + ar_client.fake.calls[0]["id"] and m["url"] == "https://gateway.irys.xyz/" + ar_client.fake.calls[0]["id"]
    assert m["arPreview"] == m["url"]                     # a single image is its own thumbnail
    call = ar_client.fake.calls[0]
    assert call["tags"]["Content-Type"] == "image/jpeg" and call["tags"]["FV-Sha256"] == m["sha256"][2:] and call["sha256"] == m["sha256"][2:]
    assert call["args"][:6] == ["--key", str(Path.home() / ".config/solana/id.json"), "--network", "devnet", "--rpc", settings.solana_rpc_public]
    # same bytes again → served from the media table, no second upload
    m2 = _upload(ar_client, [data])
    assert m2 == m and len(ar_client.fake.calls) == 1


def test_media_multiple_frames_uploads_first_frame_as_preview(ar_client, settings):
    frames = [b"\xff\xd8frame-A" * 30, b"\xff\xd8frame-B" * 30, b"\xff\xd8frame-C" * 30]
    m = _upload(ar_client, frames)
    assert m["files"] == 3 and m["bytes"] == sum(map(len, frames))
    assert len(ar_client.fake.calls) == 2
    whole, preview = ar_client.fake.calls
    assert whole["sha256"] == m["sha256"][2:] and whole["tags"]["App-Type"] == "seal-frames"
    assert preview["sha256"] == hashlib.sha256(frames[0]).hexdigest() and preview["tags"]["Content-Type"] == "image/jpeg"
    assert m["arPreview"] == "https://gateway.irys.xyz/" + preview["id"] and m["arPreview"] != m["url"]
    assert (settings.media_dir / (m["sha256"][2:] + ".preview.jpg")).read_bytes() == frames[0]


def test_media_non_image_has_no_preview(ar_client):
    m = _upload(ar_client, [b"binary-blob" * 20], content_type="application/octet-stream")
    assert m["ar"] and m["arPreview"] is None and ar_client.fake.calls[0]["tags"]["Content-Type"] == "application/octet-stream"


def test_verify_bundle_carries_ar_and_events_archives_bundle(ar_client):
    frames = [b"\xff\xd8frame-1" * 40, b"\xff\xd8frame-2" * 40]
    m = _upload(ar_client, frames)
    tag = ar_client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _verify(ar_client, tag["uid"], m["sha256"])
    b = v["bundle"]
    assert b["media"] == [{"type": "SEAL_FRAMES", "sha256": m["sha256"], "ar": m["ar"]}]
    assert proof.bundle_hash(proof.canonical_json(b)).hex() == v["bundleHash"][2:]      # hash covers the ar link
    n_before = len(ar_client.fake.calls)

    e = ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": "T" * 88, "serial": SERIAL, "type": 2}).json()
    assert e["status"] == "confirmed" and e["txSig"] == "T" * 88
    assert len(ar_client.fake.calls) == n_before + 1
    call = ar_client.fake.calls[-1]
    assert call["tags"]["Content-Type"] == "application/json" and call["tags"]["App-Type"] == "scanproof-bundle"
    assert call["tags"]["FV-Serial"] == SERIAL and call["tags"]["FV-Bundle-Hash"] == v["bundleHash"][2:]
    assert call["sha256"] == v["bundleHash"][2:]                  # exactly the canonical bytes
    assert json.loads(call["text"]) == b and call["text"] == proof.canonical_json(b)
    assert e["arBundle"] == "ar://" + call["id"] and e["arMedia"] == m["arPreview"]
    ev = next(x for x in ar_client.get(f"/api/passport/{SERIAL}").json()["events"] if x["id"] == v["eventId"])
    assert ev["arBundle"] == e["arBundle"] and ev["arMedia"] == m["arPreview"]
    # reporting the tx again is idempotent — no second upload
    ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": "T" * 88})
    assert len(ar_client.fake.calls) == n_before + 1


def test_tier1_scan_without_media_gets_bundle_only(ar_client):
    tag = ar_client.post("/api/dev/tag", json={"serial": SERIAL}).json()
    v = _verify(ar_client, tag["uid"], None, tier=1, mediaHash=None)
    assert v["bundle"]["media"] == []
    e = ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": "U" * 88}).json()
    assert e["arBundle"].startswith("ar://") and e["arMedia"] is None


def test_disabled_never_calls_sidecar(client, monkeypatch, settings):
    calls = []
    monkeypatch.setattr(aw, "_run_sidecar", lambda args, s: calls.append(args) or {"id": "SHOULD-NOT-HAPPEN"})
    assert settings.arweave is False and aw.enabled(settings) is False
    m = _upload(client, [b"\xff\xd8x" * 10, b"\xff\xd8y" * 10])
    assert m["ar"] is None and m["url"] is None and m["arPreview"] is None and m["sha256"].startswith("0x")
    tag = client.post("/api/dev/tag", json={"serial": SERIAL}).json()
    v = _verify(client, tag["uid"], m["sha256"])
    assert v["bundle"]["media"][0]["ar"] is None
    e = client.post("/api/events", json={"eventId": v["eventId"], "txSig": "V" * 88}).json()
    assert e["status"] == "confirmed" and e["arBundle"] is None and e["arMedia"] is None
    assert calls == []
    assert aw.upload_file(Path(__file__), "text/plain", settings) is None and aw.upload_json({"a": 1}, settings) is None


def test_sidecar_failures_return_none(settings, monkeypatch, tmp_path):
    settings.arweave, settings.irys_key = True, "default"
    f = tmp_path / "x.bin"
    f.write_bytes(b"abc")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, stdout="", stderr="irys-sidecar: insufficient balance"))
    assert aw.upload_file(f, "application/octet-stream", settings) is None
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="not json\n", stderr=""))
    assert aw.upload_file(f, "application/octet-stream", settings) is None

    def timeout(*a, **k):
        raise subprocess.TimeoutExpired(a[0], k.get("timeout", 60))
    monkeypatch.setattr(subprocess, "run", timeout)
    assert aw.upload_json({"x": 1}, settings) is None

    ok = json.dumps({"id": "Q" * 43, "url": "https://gateway.irys.xyz/" + "Q" * 43, "ar": "ar://" + "Q" * 43, "bytes": 3})
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout=ok + "\n", stderr=""))
    assert aw.upload_file(f, "image/jpeg", settings) == {"id": "Q" * 43, "url": "https://gateway.irys.xyz/" + "Q" * 43, "ar": "ar://" + "Q" * 43, "bytes": 3}


def test_bundle_from_payload_reproduces_vectors(vectors):
    for s in vectors["scans"]:
        payload = {**json.loads(s["bundleCanonical"]), "grade": s["grade"], "msgHex": s["msgHex"], "bundleHash": "0x" + s["bundleHashHex"],
                   "reconcile": {"mismatch": []}}
        assert proof.canonical_json(proof.bundle_from_payload(payload)) == s["bundleCanonical"]


def test_settings_helpers(settings):
    assert aw.key_path(settings) == Path.home() / ".config/solana/id.json"
    settings.irys_key = "~/keys/dev.json"
    assert aw.key_path(settings) == Path.home() / "keys/dev.json"
    settings.solana_rpc = "http://127.0.0.1:8899"
    assert settings.solana_rpc_public == "https://api.devnet.solana.com"
    settings.solana_rpc = "https://api.devnet.solana.com"
    assert settings.solana_rpc_public == "https://api.devnet.solana.com"
