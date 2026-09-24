"""
Arweave storage via Irys (briefing §4.4, week 2). There is no maintained Python SDK for Irys, so uploads go
through the Node sidecar in apps/verify/irys (upload.mjs) via subprocess.

Enabled only when FV_ARWEAVE=true AND FV_IRYS_KEY is set (path to a Solana keypair json, or "default" for
~/.config/solana/id.json). Every failure is logged and yields None — the scan flow never breaks because of Arweave.
Irys devnet uploads are pruned after ~60 days.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from fv import proof
from fv.config import APP_DIR, Settings
from fv.db import get_media, set_event_arweave
from fv.enums import EventType

log = logging.getLogger("fv.arweave")

SIDECAR_DIR = APP_DIR / "irys"
UPLOAD_SCRIPT = SIDECAR_DIR / "upload.mjs"
DEFAULT_KEY = Path.home() / ".config" / "solana" / "id.json"
DEFAULT_NODE = Path.home() / ".local" / "node" / "bin" / "node"


class ArweaveError(RuntimeError):
    pass


def enabled(settings: Settings) -> bool:
    return bool(settings.arweave and settings.irys_key)


def key_path(settings: Settings) -> Path:
    k = (settings.irys_key or "").strip()
    return DEFAULT_KEY if k in ("", "default") else Path(k).expanduser()


def node_bin(settings: Settings) -> str:
    if settings.node_bin:
        return settings.node_bin
    if DEFAULT_NODE.exists():
        return str(DEFAULT_NODE)
    found = shutil.which("node")
    if not found:
        raise ArweaveError("node binary not found (set FV_NODE_BIN)")
    return found


def _run_sidecar(args: list[str], settings: Settings) -> dict[str, Any]:
    """Run `node upload.mjs <args>` and parse its JSON stdout. Raises ArweaveError on any failure."""
    if not UPLOAD_SCRIPT.exists():
        raise ArweaveError(f"sidecar missing: {UPLOAD_SCRIPT} (run `npm install` in apps/verify/irys)")
    cmd = [node_bin(settings), str(UPLOAD_SCRIPT), *args]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=settings.arweave_timeout_s, cwd=str(SIDECAR_DIR),
                             env={**os.environ, "NODE_NO_WARNINGS": "1"})
    except subprocess.TimeoutExpired as exc:
        raise ArweaveError(f"sidecar timed out after {settings.arweave_timeout_s}s") from exc
    except OSError as exc:
        raise ArweaveError(f"sidecar could not start: {exc}") from exc
    if res.returncode != 0:
        raise ArweaveError((res.stderr or res.stdout or "").strip()[-500:] or f"exit {res.returncode}")
    try:
        out = json.loads(res.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise ArweaveError(f"sidecar returned no JSON: {res.stdout[-200:]!r}") from exc
    if not out.get("id"):
        raise ArweaveError(f"sidecar returned no id: {out}")
    return out


def upload_file(path: Path | str, content_type: str, settings: Settings, extra_tags: dict[str, str] | None = None) -> dict | None:
    """→ {"id", "url", "ar", "bytes"} or None (disabled / failed)."""
    if not enabled(settings):
        return None
    args = ["--key", str(key_path(settings)), "--network", settings.irys_network, "--rpc", settings.solana_rpc_public,
            "--tag", f"Content-Type={content_type or 'application/octet-stream'}"]
    for k, v in (extra_tags or {}).items():
        args += ["--tag", f"{k}={v}"]
    args.append(str(path))
    try:
        out = _run_sidecar(args, settings)
    except ArweaveError as exc:
        log.warning("arweave upload failed for %s: %s", path, exc)
        return None
    res = {"id": out["id"], "url": out.get("url") or f"https://gateway.irys.xyz/{out['id']}", "ar": out.get("ar") or f"ar://{out['id']}",
           "bytes": out.get("bytes")}
    log.info("arweave: uploaded %s (%s, %s bytes) → %s", Path(path).name, content_type, res["bytes"], res["url"])
    return res


def upload_json(obj: Any, settings: Settings, *, canonical: str | None = None, extra_tags: dict[str, str] | None = None) -> dict | None:
    """Upload a JSON document as application/json. `canonical` (if given) is uploaded byte-for-byte."""
    if not enabled(settings):
        return None
    text = canonical if canonical is not None else proof.canonical_json(obj)
    with tempfile.NamedTemporaryFile("w", suffix=".json", prefix="fv-bundle-", encoding="utf-8", delete=False) as f:
        f.write(text)
        tmp = Path(f.name)
    try:
        return upload_file(tmp, "application/json", settings, extra_tags)
    finally:
        tmp.unlink(missing_ok=True)


def archive_scan_event(conn, settings: Settings, event: dict) -> tuple[str | None, str | None]:
    """
    For a confirmed SCAN event: upload the canonical §4.4 bundle (the bytes whose sha256 is bundleHash) → events.ar_bundle,
    and copy the media's preview/url → events.ar_media. Idempotent; returns (ar_bundle, ar_media).
    """
    if event["type"] != EventType.SCAN:
        return event.get("ar_bundle"), event.get("ar_media")
    payload = json.loads(event["payload_json"] or "{}")
    ar_bundle, ar_media = event.get("ar_bundle"), event.get("ar_media")
    media = payload.get("media") or []
    if not ar_media and media:
        row = get_media(conn, proof.strip0x(media[0]["sha256"]).lower())
        if row:
            ar_media = row["ar_preview"] or row["url"]
    if not ar_bundle and "indicators" in payload and enabled(settings):
        bundle = proof.bundle_from_payload(payload)
        canonical = proof.canonical_json(bundle)
        want = proof.strip0x(payload.get("bundleHash") or "").lower()
        got = proof.bundle_hash(canonical).hex()
        if want and want != got:
            log.warning("archive: event %s bundle hash mismatch (%s != %s) — uploading the reconstructed bundle anyway", event["id"], got[:12], want[:12])
        res = upload_json(bundle, settings, canonical=canonical,
                          extra_tags={"App-Type": "scanproof-bundle", "FV-Serial": payload.get("serial") or "", "FV-Bundle-Hash": got})
        if res:
            ar_bundle = res["ar"]
    if ar_bundle != event.get("ar_bundle") or ar_media != event.get("ar_media"):
        set_event_arweave(conn, event["id"], ar_bundle, ar_media)
    return ar_bundle, ar_media
