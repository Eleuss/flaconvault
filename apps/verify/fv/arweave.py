"""
Arweave storage via Irys (briefing §4.4, week 2). There is no maintained Python SDK for Irys, so uploads go
through the Node sidecar in apps/verify/irys (upload.mjs) via subprocess.

Enabled only when FV_ARWEAVE=true AND FV_IRYS_KEY (path to a Solana keypair json, or "default" for
~/.config/solana/id.json) or FV_IRYS_KEY_JSON (the keypair inline) is set. Every failure yields None — the scan flow
never breaks because of Arweave — but failures are no longer silent: they are logged as errors, counted, and reported
by status() / health() (last error, last success, Irys balance from the periodic probe). A misconfiguration
(FV_ARWEAVE=true without a key, sidecar or node missing) is reported by config_problem() and logged at startup.
Irys devnet uploads are pruned after ~60 days.

The sidecar (≈ 245 npm packages) only gets a minimal environment: never FV_MASTER_KEY, the server signing seed, the
admin token or the inline Irys key — the key reaches it as a 0600 file path.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fv import proof
from fv.config import APP_DIR, Settings
from fv.db import get_media, set_event_arweave, upsert_media
from fv.enums import EventType

log = logging.getLogger("fv.arweave")

SIDECAR_DIR = APP_DIR / "irys"
UPLOAD_SCRIPT = SIDECAR_DIR / "upload.mjs"
FUND_SCRIPT = SIDECAR_DIR / "fund.mjs"
DEFAULT_KEY = Path.home() / ".config" / "solana" / "id.json"
DEFAULT_NODE = Path.home() / ".local" / "node" / "bin" / "node"

# Environment the sidecar may see (none of these carries a secret). Everything else is dropped.
SIDECAR_ENV_PASSTHROUGH = ("PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
                           "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy")
BACKOFF_BASE_S = 60          # after consecutive failures the backfill waits 60 s, 120 s, … up to BACKOFF_MAX_S
BACKOFF_MAX_S = 3600
BACKFILL_PER_CYCLE = 3       # confirmed SCANs archived per reconcile cycle (each may run the sidecar twice)


class ArweaveError(RuntimeError):
    def __init__(self, message: str, code: str = "upload_failed"):
        super().__init__(message)
        self.code = code


# ---------- status (process-wide; reported by /health and the admin status) ----------

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {}


def reset_status() -> None:
    with _LOCK:
        _STATE.clear()
        _STATE.update({"uploads": 0, "failures": 0, "consecutiveFailures": 0, "lastOkAt": None, "lastErrorAt": None,
                       "lastErrorCode": None, "lastError": None, "probe": None})


reset_status()


def _classify(message: str) -> str:
    m = message.lower()
    if "insufficient irys balance" in m or "insufficient balance" in m:
        return "insufficient_balance"
    if "timed out" in m:
        return "timeout"
    if "sidecar missing" in m or "could not start" in m or "node binary not found" in m or "dependencies missing" in m:
        return "sidecar_unavailable"
    if "keypair" in m or "fv_irys_key" in m:
        return "key_invalid"
    return "upload_failed"


def _record_ok() -> None:
    with _LOCK:
        _STATE["uploads"] += 1
        _STATE["consecutiveFailures"] = 0
        _STATE["lastOkAt"] = int(time.time())


def _record_error(exc: ArweaveError) -> None:
    with _LOCK:
        _STATE["failures"] += 1
        _STATE["consecutiveFailures"] += 1
        _STATE["lastErrorAt"] = int(time.time())
        _STATE["lastErrorCode"] = exc.code
        _STATE["lastError"] = str(exc)[-300:]


def in_backoff(now_ts: int | None = None) -> bool:
    """True while the backfill should not try again (after consecutive failures, exponential up to an hour)."""
    with _LOCK:
        n, last = _STATE["consecutiveFailures"], _STATE["lastErrorAt"]
    if not n or last is None:
        return False
    wait = min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** (n - 1))
    return (now_ts if now_ts is not None else int(time.time())) - last < wait


def enabled(settings: Settings) -> bool:
    return bool(settings.arweave and (settings.irys_key or settings.irys_key_json))


def config_problem(settings: Settings) -> str | None:
    """Why archiving cannot work although FV_ARWEAVE=true (None when it is off or looks fine). Never contains secrets."""
    if not settings.arweave:
        return None
    if not (settings.irys_key or settings.irys_key_json):
        return "FV_ARWEAVE=true but neither FV_IRYS_KEY nor FV_IRYS_KEY_JSON is set: nothing is archived"
    if settings.irys_key_json and _parse_keypair(settings.irys_key_json) is None:
        return "FV_IRYS_KEY_JSON is not a JSON array of 64 numbers (the Solana keypair file format)"
    if not settings.irys_key_json:
        k = key_path(settings)
        if not k.exists():
            return f"Irys key file not found: {k}"
    if not UPLOAD_SCRIPT.exists():
        return f"sidecar missing: {UPLOAD_SCRIPT}"
    if not (SIDECAR_DIR / "node_modules").exists():
        return "sidecar dependencies missing: run `npm ci --omit=dev` in apps/verify/irys"
    try:
        node_bin(settings)
    except ArweaveError as exc:
        return str(exc)
    return None


def status(settings: Settings) -> dict[str, Any]:
    """Full archiving status (admin): configuration, counters, last error text, last balance probe."""
    with _LOCK:
        st = dict(_STATE)
    return {"enabled": bool(settings.arweave), "configured": enabled(settings), "network": settings.irys_network,
            "problem": config_problem(settings), **st}


def health(settings: Settings) -> dict[str, Any]:
    """Compact public status for GET /health (error codes, no raw sidecar output)."""
    st = status(settings)
    probe = st.get("probe") or {}
    ok = None
    if st["enabled"]:
        ok = st["problem"] is None and not st["consecutiveFailures"] and probe.get("balanceOk", True) is not False
    return {"enabled": st["enabled"], "ok": ok, "problem": st["problem"], "lastOkAt": st["lastOkAt"],
            "lastErrorAt": st["lastErrorAt"], "lastErrorCode": st["lastErrorCode"], "failures": st["failures"],
            "balanceSol": probe.get("balanceSol"), "balanceOk": probe.get("balanceOk")}


# ---------- key / node / sidecar ----------

def _parse_keypair(text: str) -> list[int] | None:
    try:
        raw = json.loads(text)
    except ValueError:
        return None
    if not isinstance(raw, list) or len(raw) != 64 or not all(isinstance(x, int) and 0 <= x <= 255 for x in raw):
        return None
    return raw


def key_path(settings: Settings) -> Path:
    inline = (settings.irys_key_json or "").strip()
    if inline:
        if _parse_keypair(inline) is None:
            raise ArweaveError("FV_IRYS_KEY_JSON is not a JSON array of 64 numbers", "key_invalid")
        # hosted deployments pass the keypair as an env var; materialise it next to the database (0600)
        target = Path(settings.db_path).expanduser().resolve().parent / "irys-key.json"
        if not target.exists() or target.read_text() != inline:
            target.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(inline)
        target.chmod(0o600)
        return target
    k = (settings.irys_key or "").strip()
    return DEFAULT_KEY if k in ("", "default") else Path(k).expanduser()


def node_bin(settings: Settings) -> str:
    if settings.node_bin:
        return settings.node_bin
    if DEFAULT_NODE.exists():
        return str(DEFAULT_NODE)
    found = shutil.which("node")
    if not found:
        raise ArweaveError("node binary not found (set FV_NODE_BIN)", "sidecar_unavailable")
    return found


def sidecar_env() -> dict[str, str]:
    """The only environment the Node sidecar gets: no FV_* variable, no secret."""
    env = {k: os.environ[k] for k in SIDECAR_ENV_PASSTHROUGH if os.environ.get(k)}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env["HOME"] = tempfile.gettempdir()
    env["NODE_NO_WARNINGS"] = "1"
    return env


def _run_node(script: Path, args: list[str], settings: Settings) -> dict[str, Any]:
    """Run `node <script> <args>` with the minimal environment and parse its last stdout line as JSON."""
    if not script.exists():
        raise ArweaveError(f"sidecar missing: {script} (run `npm ci --omit=dev` in apps/verify/irys)", "sidecar_unavailable")
    cmd = [node_bin(settings), str(script), *args]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=settings.arweave_timeout_s, cwd=str(SIDECAR_DIR),
                             env=sidecar_env())
    except subprocess.TimeoutExpired as exc:
        raise ArweaveError(f"sidecar timed out after {settings.arweave_timeout_s}s", "timeout") from exc
    except OSError as exc:
        raise ArweaveError(f"sidecar could not start: {exc}", "sidecar_unavailable") from exc
    if res.returncode != 0:
        msg = (res.stderr or res.stdout or "").strip()[-500:] or f"exit {res.returncode}"
        raise ArweaveError(msg, _classify(msg))
    try:
        return json.loads(res.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise ArweaveError(f"sidecar returned no JSON: {res.stdout[-200:]!r}") from exc


def _run_sidecar(args: list[str], settings: Settings) -> dict[str, Any]:
    """Run `node upload.mjs <args>` and parse its JSON stdout. Raises ArweaveError on any failure."""
    out = _run_node(UPLOAD_SCRIPT, args, settings)
    if not out.get("id"):
        raise ArweaveError(f"sidecar returned no id: {out}")
    return out


def _base_args(settings: Settings) -> list[str]:
    return ["--key", str(key_path(settings)), "--network", settings.irys_network, "--rpc", settings.solana_rpc_public]


def upload_file(path: Path | str, content_type: str, settings: Settings, extra_tags: dict[str, str] | None = None) -> dict | None:
    """→ {"id", "url", "ar", "bytes"} or None (disabled / failed — failures are logged and recorded in status())."""
    if not enabled(settings):
        return None
    try:
        args = [*_base_args(settings), "--tag", f"Content-Type={content_type or 'application/octet-stream'}"]
        for k, v in (extra_tags or {}).items():
            args += ["--tag", f"{k}={v}"]
        args.append(str(path))
        out = _run_sidecar(args, settings)
    except ArweaveError as exc:
        _record_error(exc)
        log.error("arweave upload failed for %s (%s): %s", Path(path).name, exc.code, exc)
        return None
    _record_ok()
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


def probe(settings: Settings) -> dict | None:
    """
    Read the Irys balance (fund.mjs --dry-run: no funding, read-only) and record it in status(). Run periodically by the
    background loop, so an unfunded or drained Irys wallet shows up in /health before uploads fail.
    """
    if not enabled(settings):
        return None
    try:
        out = _run_node(FUND_SCRIPT, [*_base_args(settings), "--dry-run"], settings)
    except ArweaveError as exc:
        res = {"at": int(time.time()), "ok": False, "errorCode": exc.code, "balanceOk": None}
        log.error("arweave probe failed (%s): %s", exc.code, exc)
    else:
        balance_ok = out.get("status") == "sufficient"
        res = {"at": int(time.time()), "ok": True, "address": out.get("address"), "balanceSol": out.get("balanceSol"),
               "priceSol": out.get("priceSol"), "balanceOk": balance_ok}
        (log.info if balance_ok else log.error)("arweave probe: Irys balance %s SOL for %s (%s)", out.get("balanceSol"),
                                                out.get("address"), "ok" if balance_ok else "INSUFFICIENT — run irys/fund.mjs")
    with _LOCK:
        _STATE["probe"] = res
    return res


# ---------- archiving ----------

def archive_media(conn, settings: Settings, sha256_hex: str) -> bool | None:
    """
    Upload a stored media blob that has no Arweave link yet (POST /api/media failed or archiving was off then).
    True = archived (or already), None = nothing to do (no row / no file / disabled), False = upload failed.
    """
    row = get_media(conn, sha256_hex)
    if not row or not enabled(settings):
        return None
    if row["ar"]:
        return True
    path = Path(settings.media_dir) / f"{row['sha256']}.bin"
    if not path.exists():
        return None
    ctype = row["content_type"] or "application/octet-stream"
    res = upload_file(path, ctype, settings, {"App-Type": "seal-frames", "FV-Sha256": row["sha256"]})
    if not res:
        return False
    preview = res["url"] if int(row["files"] or 1) == 1 else None
    if preview is None:
        for p in sorted(Path(settings.media_dir).glob(f"{row['sha256']}.preview.*")):
            pres = upload_file(p, ctype, settings, {"App-Type": "seal-frame-preview", "FV-Sha256": row["sha256"]})
            preview = pres["url"] if pres else None
            break
    upsert_media(conn, sha256_hex=row["sha256"], bytes_=row["bytes"], files=row["files"], content_type=row["content_type"],
                 ar=res["ar"], url=res["url"], ar_preview=preview, created_at=row["created_at"])
    return True


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


def backfill(conn, settings: Settings, *, limit: int = BACKFILL_PER_CYCLE, skip_ids: frozenset[int] = frozenset()) -> dict:
    """
    Archive confirmed SCANs that have no Arweave bundle yet (the confirm request's upload failed, the sidecar was down,
    archiving was switched on later), media first, newest first, at most `limit` per call. Stops at the first failure
    and waits (in_backoff) before the next attempt, so a broken Irys setup is not hammered every cycle.
    """
    out = {"attempted": 0, "archived": 0, "failed": 0, "skipped": None}
    if not enabled(settings):
        out["skipped"] = "disabled"
        return out
    if in_backoff():
        out["skipped"] = "backoff"
        return out
    rows = conn.execute(
        """SELECT * FROM events WHERE type=2 AND status='confirmed' AND ar_bundle IS NULL
             AND json_extract(payload_json, '$.indicators') IS NOT NULL AND COALESCE(json_extract(payload_json, '$.seed'), 0) = 0
           ORDER BY id DESC LIMIT ?""", (limit + len(skip_ids),)).fetchall()
    for r in [dict(r) for r in rows if r["id"] not in skip_ids][:limit]:
        out["attempted"] += 1
        media = json.loads(r["payload_json"] or "{}").get("media") or []
        if media and archive_media(conn, settings, proof.strip0x(media[0]["sha256"]).lower()) is False:
            out["failed"] += 1
            break
        ar_bundle, _ = archive_scan_event(conn, settings, r)
        if not ar_bundle:
            out["failed"] += 1
            break
        out["archived"] += 1
    return out
