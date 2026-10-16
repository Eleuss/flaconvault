"""Arweave via the Irys sidecar — sidecar mocked at the subprocess boundary (fv.arweave._run_sidecar); no network."""
import hashlib
import io
import json
import subprocess
from pathlib import Path

import pytest

import fv.arweave as aw
from fv import proof
from tests.conftest import ADMIN, post_media, sig

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
    from tests.conftest import PROGRAM_ID, FakeRpc
    settings.arweave = True
    settings.irys_key = "default"
    settings.program_id = PROGRAM_ID
    fake = FakeSidecar()
    monkeypatch.setattr(aw, "_run_sidecar", fake)
    app = create_app(settings)
    app.state.rpc = FakeRpc()
    with TestClient(app) as c:
        c.fake = fake
        c.rpc = app.state.rpc
        yield c


def _upload(client, frames: list[bytes], content_type="image/jpeg", nonce: str | None = None):
    files = [("files", (f"frame{i}.jpg", io.BytesIO(b), content_type)) for i, b in enumerate(frames)]
    r = post_media(client, files=files, nonce=nonce)
    assert r.status_code == 200, r.text
    return r.json()


def _verify(client, uid, media_hash, nonce: str | None = None, **over):
    tap = client.post("/api/dev/tap", json={"uid": uid}).json()
    nonce = nonce or client.post("/api/session", json={}).json()["nonce"]
    body = {"uid": tap["uid"], "ctr": tap["ctrHex"], "cmac": tap["cmac"], "nonce": nonce, "role": 1, "tier": 2,
            "indicators": {"heat": 0, "humidity": 0, "uv": 3}, "heatLevels": [1, 1, 0, 0, 0, 0], "fill": 92, "mediaHash": media_hash,
            "attester": SELLER, "platform": "SIMULATOR", "location": {"country": "DE", "city": "Wickede"}}
    body.update(over)
    v = client.post("/api/verify", json=body).json()
    assert v["verdict"] == "VALID", v
    return v


def _archive(client) -> dict:
    """One reconcile cycle: the only place uploads happen (the archiving queue)."""
    r = client.post("/api/reconcile", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()["arweave"]


def _event(client, event_id):
    return next(x for x in client.get(f"/api/passport/{SERIAL}").json()["events"] if x["id"] == event_id)


def _scan_with_media(client, frames, content_type="image/jpeg", sig_tag="T"):
    """Upload under the session nonce, sign the scan with that nonce, confirm it on chain, run the archiving queue."""
    nonce = client.post("/api/session", json={}).json()["nonce"]
    m = _upload(client, frames, content_type, nonce=nonce)
    tag = client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _verify(client, tag["uid"], m["sha256"], nonce=nonce)
    client.rpc.scan_tx(sig(sig_tag), v, SELLER)
    e = client.post("/api/events", json={"eventId": v["eventId"], "txSig": sig(sig_tag)}).json()
    assert e["status"] == "confirmed", e
    assert client.fake.calls == []                                                    # the confirm request never uploads
    _archive(client)
    return m, v, _event(client, v["eventId"])


def test_media_is_archived_only_after_its_scan_is_confirmed(ar_client, settings):
    data = b"\xff\xd8\xff\xe0" + b"jpeg-bytes" * 50
    nonce = ar_client.post("/api/session", json={}).json()["nonce"]
    m = _upload(ar_client, [data], nonce=nonce)
    assert m["sha256"] == "0x" + hashlib.sha256(data).hexdigest() and m["bytes"] == len(data) and m["files"] == 1
    assert m["ar"] is None and m["url"] is None and ar_client.fake.calls == []      # an upload alone spends nothing
    tag = ar_client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _verify(ar_client, tag["uid"], m["sha256"], nonce=nonce)
    assert ar_client.fake.calls == []                                                 # signed, not yet anchored
    ar_client.rpc.scan_tx(sig("A1"), v, SELLER)
    e = ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("A1")}).json()
    assert e["status"] == "confirmed" and e["arBundle"] is None and ar_client.fake.calls == []   # not in the request
    assert _archive(ar_client) == {"attempted": 1, "archived": 1, "failed": 0, "mediaFailed": 0, "skipped": None}
    e = _event(ar_client, v["eventId"])
    media_call, bundle_call = ar_client.fake.calls
    assert media_call["tags"]["Content-Type"] == "image/jpeg" and media_call["tags"]["FV-Sha256"] == m["sha256"][2:]
    assert media_call["sha256"] == m["sha256"][2:] and media_call["tags"]["App-Type"] == "seal-frames"
    assert media_call["args"][:6] == ["--key", str(Path.home() / ".config/solana/id.json"), "--network", "devnet", "--rpc",
                                      settings.solana_rpc_public]
    assert bundle_call["tags"]["App-Type"] == "scanproof-bundle"
    assert e["arMedia"] == "https://gateway.irys.xyz/" + media_call["id"]            # a single image is its own thumbnail
    # the same bytes again (another session): the archived links come back, nothing is uploaded twice
    m2 = _upload(ar_client, [data])
    assert m2["ar"] == "ar://" + media_call["id"] and m2["url"] == e["arMedia"] and len(ar_client.fake.calls) == 2


def test_media_multiple_frames_archive_the_first_frame_as_preview(ar_client, settings):
    frames = [b"\xff\xd8frame-A" * 30, b"\xff\xd8frame-B" * 30, b"\xff\xd8frame-C" * 30]
    m, v, e = _scan_with_media(ar_client, frames)
    assert m["files"] == 3 and m["bytes"] == sum(map(len, frames))
    whole, preview, bundle = ar_client.fake.calls
    assert whole["sha256"] == m["sha256"][2:] and whole["tags"]["App-Type"] == "seal-frames"
    assert preview["sha256"] == hashlib.sha256(frames[0]).hexdigest() and preview["tags"]["Content-Type"] == "image/jpeg"
    assert bundle["tags"]["App-Type"] == "scanproof-bundle"
    assert e["arMedia"] == "https://gateway.irys.xyz/" + preview["id"]
    assert (settings.media_dir / (m["sha256"][2:] + ".preview.jpg")).read_bytes() == frames[0]


def test_media_non_image_is_rejected_before_any_upload(ar_client):
    r = post_media(ar_client, files={"file": ("blob.bin", io.BytesIO(b"binary-blob" * 20), "application/octet-stream")})
    assert r.status_code == 415 and ar_client.fake.calls == []


def test_media_preview_extension_comes_from_the_whitelist(ar_client, settings):
    frames = [b"\x89PNGframe-A" * 30, b"\x89PNGframe-B" * 30]
    nonce = ar_client.post("/api/session", json={}).json()["nonce"]
    files = [("files", (f"evil{i}.html", io.BytesIO(b), "image/png; charset=../../x")) for i, b in enumerate(frames)]
    m = post_media(ar_client, files=files, nonce=nonce).json()
    tag = ar_client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    _verify(ar_client, tag["uid"], m["sha256"], nonce=nonce)
    assert (settings.media_dir / (m["sha256"][2:] + ".preview.png")).read_bytes() == frames[0]
    assert sorted(p.name for p in settings.media_dir.iterdir() if p.is_file()) == sorted(
        [m["sha256"][2:] + ".bin", m["sha256"][2:] + ".preview.png"])


def test_verify_bundle_and_events_archive_media_and_bundle(ar_client):
    frames = [b"\xff\xd8frame-1" * 40, b"\xff\xd8frame-2" * 40]
    nonce = ar_client.post("/api/session", json={}).json()["nonce"]
    m = _upload(ar_client, frames, nonce=nonce)
    tag = ar_client.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    v = _verify(ar_client, tag["uid"], m["sha256"], nonce=nonce)
    b = v["bundle"]
    assert b["media"] == [{"type": "SEAL_FRAMES", "sha256": m["sha256"], "ar": None}]   # not archived before the anchor
    assert proof.bundle_hash(proof.canonical_json(b)).hex() == v["bundleHash"][2:]
    assert ar_client.fake.calls == []

    ar_client.rpc.scan_tx(sig("T"), v, SELLER)
    e = ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("T"), "serial": SERIAL, "type": 2}).json()
    assert e["status"] == "confirmed" and e["txSig"] == sig("T")
    assert ar_client.fake.calls == []                              # archived by the reconcile job, not in the request
    _archive(ar_client)
    e = _event(ar_client, v["eventId"])
    assert len(ar_client.fake.calls) == 3                          # frames, first-frame preview, bundle
    call = ar_client.fake.calls[-1]
    assert call["tags"]["Content-Type"] == "application/json" and call["tags"]["App-Type"] == "scanproof-bundle"
    assert call["tags"]["FV-Serial"] == SERIAL and call["tags"]["FV-Bundle-Hash"] == v["bundleHash"][2:]
    assert call["sha256"] == v["bundleHash"][2:]                  # exactly the canonical bytes
    assert json.loads(call["text"]) == b and call["text"] == proof.canonical_json(b)
    preview_url = "https://gateway.irys.xyz/" + ar_client.fake.calls[1]["id"]
    assert e["arBundle"] == "ar://" + call["id"] and e["arMedia"] == preview_url
    ev = next(x for x in ar_client.get(f"/api/passport/{SERIAL}").json()["events"] if x["id"] == v["eventId"])
    assert ev["arBundle"] == e["arBundle"] and ev["arMedia"] == preview_url
    # reporting the tx again is idempotent — no second upload, and the queue has nothing left for this scan
    again = ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("T")})
    assert again.status_code == 200 and again.json()["id"] == e["id"] and again.json()["arBundle"] == e["arBundle"]
    assert _archive(ar_client)["attempted"] == 0
    assert len(ar_client.fake.calls) == 3


def test_tier1_scan_without_media_gets_bundle_only(ar_client):
    tag = ar_client.post("/api/dev/tag", json={"serial": SERIAL}).json()
    v = _verify(ar_client, tag["uid"], None, tier=1, mediaHash=None)
    assert v["bundle"]["media"] == []
    ar_client.rpc.scan_tx(sig("U"), v, SELLER)
    ar_client.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("U")})
    _archive(ar_client)
    e = _event(ar_client, v["eventId"])
    assert e["arBundle"].startswith("ar://") and e["arMedia"] is None


def test_disabled_never_calls_sidecar(chain_client, monkeypatch, settings):
    client = chain_client
    calls = []
    monkeypatch.setattr(aw, "_run_sidecar", lambda args, s: calls.append(args) or {"id": "SHOULD-NOT-HAPPEN"})
    assert settings.arweave is False and aw.enabled(settings) is False
    nonce = client.post("/api/session", json={}).json()["nonce"]
    m = _upload(client, [b"\xff\xd8x" * 10, b"\xff\xd8y" * 10], nonce=nonce)
    assert m["ar"] is None and m["url"] is None and m["arPreview"] is None and m["sha256"].startswith("0x")
    tag = client.post("/api/dev/tag", json={"serial": SERIAL}).json()
    v = _verify(client, tag["uid"], m["sha256"], nonce=nonce)
    assert v["bundle"]["media"][0]["ar"] is None
    client.rpc.scan_tx(sig("V"), v, SELLER)
    e = client.post("/api/events", json={"eventId": v["eventId"], "txSig": sig("V")}).json()
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
