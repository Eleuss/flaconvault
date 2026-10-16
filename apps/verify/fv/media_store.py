"""
Seal frames uploaded to POST /api/media, kept only when a signed scan uses them.

  staging   <media_dir>/staging/<nonce hex>/<sha256>.bin + <sha256>.json (bytes, files, contentType, sizes) — every
            upload lands here, under the session nonce it was sent with.
  promoted  <media_dir>/<sha256>.bin (+ <sha256>.preview.<ext>, the first frame, when there are several) and a media
            row — only when a VALID /api/verify consumes that nonce with mediaHash = sha256 (promote()). Nothing else
            ever leaves staging.
  purge     a staging directory whose nonce is expired, consumed or unknown is deleted, opportunistically from
            POST /api/session and POST /api/media (at most every PURGE_EVERY_S per media directory) and on every
            reconcile cycle (retention()). Junk uploads therefore live no longer than a session nonce (FV_NONCE_TTL_S)
            plus that interval.
  retention promoted blobs (and their media rows) that no scan references any more — no pending or confirmed event,
            no failed one the reconcile job may still recover — are deleted once they are older than
            FV_MEDIA_RETENTION_S (default 7 days, 0 = never), and so are blob files without a media row; run by the
            reconcile job (retention()), at most RETENTION_BATCH per cycle.

Budgets, checked from Content-Length before the body is parsed and charged with the bytes actually staged:
  * free space: less than FV_MEDIA_MIN_FREE_BYTES (default 256 MiB) left on the media volume after the upload → 507
    storage_full (the same volume holds the SQLite database, which must never run out of space);
  * per client (rate-limit key: IPv4 address / IPv6 /64): FV_MEDIA_MAX_BYTES_PER_IP_DAY (default 200 MiB per 24 h)
    → 429 media_limited;
  * whole server: FV_MEDIA_MAX_BYTES_PER_HOUR (default 2 GiB) → 503 media_busy.
Each file is streamed to disk in CHUNK-sized pieces: a request never holds the whole upload in memory.
Arweave: media is archived only by the reconcile job's archiving queue (arweave.backfill → archive_scan, media first,
then the bundle) once its scan is confirmed — never at upload and never inside a request, so junk uploads cannot spend
the Irys balance.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from fastapi import HTTPException, Request

from fv import proof
from fv.config import Settings
from fv.db import get_media, get_nonce, transaction, upsert_media
from fv.ratelimit import RateLimiter, client_key, limiter, setting

log = logging.getLogger("fv.media")

MEDIA_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}   # content type → stored preview extension
CHUNK = 1 << 20
STAGING = "staging"
PURGE_EVERY_S = 30.0
DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_BYTES_PER_IP_DAY = 200 * 1024 * 1024
DEFAULT_MAX_BYTES_PER_HOUR = 2 * 1024 * 1024 * 1024
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_BLOB = re.compile(r"^([0-9a-f]{64})\.(?:bin|preview\.(?:jpg|png|webp))$")   # promoted files; nothing else is ever touched
RETENTION_BATCH = 200            # media rows / orphan files deleted per retention() call at most
_purge_lock = threading.Lock()
_last_purge: dict[str, float] = {}


class FileTooLarge(Exception):
    pass


# ---------- paths ----------

def staging_root(settings: Settings) -> Path:
    return Path(settings.media_dir) / STAGING


def _nonce_dir(settings: Settings, nonce_hex: str) -> Path:
    if not _HEX64.match(nonce_hex):
        raise ValueError("nonce must be 32 bytes of lowercase hex")
    return staging_root(settings) / nonce_hex


def staged_files(settings: Settings, nonce_hex: str) -> list[Path]:
    d = _nonce_dir(settings, nonce_hex)
    return sorted(d.iterdir()) if d.is_dir() else []


# ---------- budgets ----------

def disk_free(path: Path) -> int:
    """Free bytes on the filesystem of `path` (its nearest existing parent)."""
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free


def _per_client(request: Request) -> RateLimiter:
    n = setting(request, "media_max_bytes_per_ip_day", "FV_MEDIA_MAX_BYTES_PER_IP_DAY", DEFAULT_MAX_BYTES_PER_IP_DAY)
    return limiter(request, "media-client", lambda: RateLimiter(capacity=n, rate_per_s=n / 86400.0))


def _global(request: Request) -> RateLimiter:
    n = setting(request, "media_max_bytes_per_hour", "FV_MEDIA_MAX_BYTES_PER_HOUR", DEFAULT_MAX_BYTES_PER_HOUR)
    return limiter(request, "media-global", lambda: RateLimiter(capacity=n, rate_per_s=n / 3600.0))


def check_budget(request: Request, settings: Settings, declared: int) -> None:
    """Refuse an upload of `declared` bytes before its body is read (nothing is charged yet)."""
    floor = setting(request, "media_min_free_bytes", "FV_MEDIA_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BYTES)
    try:
        free = disk_free(Path(settings.media_dir))
    except OSError as exc:
        log.warning("media: free space unknown (%s)", exc)
        free = None
    if free is not None and free - declared < floor:
        log.warning("media: refused, %d bytes free on the media volume (floor %d)", free, int(floor))
        raise HTTPException(507, "storage_full")
    per_client, key = _per_client(request), client_key(request)
    if not per_client.allows(key, declared):
        raise HTTPException(429, "media_limited", headers={"Retry-After": str(per_client.retry_after(key, declared))})
    total = _global(request)
    if not total.allows("*", declared):
        raise HTTPException(503, "media_busy", headers={"Retry-After": str(min(3600, total.retry_after("*", declared)))})


def charge(request: Request, nbytes: int) -> None:
    """Count bytes that were staged against the client's and the server's budget."""
    _per_client(request).spend(client_key(request), nbytes)
    _global(request).spend("*", nbytes)


# ---------- staging ----------

def stage(settings: Settings, nonce_hex: str, uploads: list, max_file_bytes: int) -> dict:
    """
    Stream the files (UploadFile objects, in order) into one staging blob; their concatenation is what mediaHash
    commits to. Raises FileTooLarge (nothing kept) for a file above max_file_bytes. Returns the part file and its facts;
    finalize() makes it a staged upload.
    """
    d = _nonce_dir(settings, nonce_hex)
    d.mkdir(parents=True, exist_ok=True)
    part = d / f".{secrets.token_hex(8)}.part"
    h = hashlib.sha256()
    sizes: list[int] = []
    try:
        with open(part, "wb") as out:
            for up in uploads:
                f = up.file
                f.seek(0)
                n = 0
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    n += len(chunk)
                    if n > max_file_bytes:
                        raise FileTooLarge()
                    h.update(chunk)
                    out.write(chunk)
                sizes.append(n)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return {"part": part, "sha256": h.hexdigest(), "sizes": sizes, "bytes": sum(sizes)}


def finalize(settings: Settings, nonce_hex: str, staged: dict, content_type: str) -> None:
    d = _nonce_dir(settings, nonce_hex)
    sha = staged["sha256"]
    try:
        target = d / f"{sha}.bin"
        if target.exists():
            staged["part"].unlink(missing_ok=True)
        else:
            os.replace(staged["part"], target)
        meta = {"bytes": staged["bytes"], "files": len(staged["sizes"]), "contentType": content_type, "sizes": staged["sizes"]}
        (d / f"{sha}.json").write_text(json.dumps(meta), encoding="utf-8")
    except FileNotFoundError as exc:          # purged meanwhile: its nonce expired during the upload
        staged["part"].unlink(missing_ok=True)
        raise HTTPException(403, "media_nonce_invalid") from exc


def drop_part(staged: dict) -> None:
    staged["part"].unlink(missing_ok=True)


def discard(settings: Settings, nonce_hex: str) -> None:
    """Everything staged under this nonce."""
    try:
        d = _nonce_dir(settings, nonce_hex)
    except ValueError:
        return
    shutil.rmtree(d, ignore_errors=True)


def promote(conn, settings: Settings, nonce_hex: str, sha_hex: str, ts: int) -> dict | None:
    """
    A VALID /api/verify consumed `nonce_hex` with mediaHash `sha_hex`: that upload moves out of staging (blob, first
    frame as preview, media row); everything else staged under the nonce is deleted. Returns the media row (None when
    nothing with that hash was uploaded under this nonce and no earlier scan kept it).
    """
    sha = sha_hex.lower()
    d = _nonce_dir(settings, nonce_hex)
    blob, meta_path = d / f"{sha}.bin", d / f"{sha}.json"
    row = get_media(conn, sha)
    try:
        if blob.is_file() and meta_path.is_file():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            media_dir = Path(settings.media_dir)
            dest = media_dir / f"{sha}.bin"
            if not dest.exists():
                os.replace(blob, dest)
            ext = MEDIA_TYPES.get(meta.get("contentType") or "")
            sizes = meta.get("sizes") or []
            if ext and len(sizes) > 1:
                preview = media_dir / f"{sha}.preview.{ext}"
                if not preview.exists():
                    with open(dest, "rb") as f:
                        preview.write_bytes(f.read(int(sizes[0])))
            row = upsert_media(conn, sha256_hex=sha, bytes_=int(meta["bytes"]), files=int(meta["files"]),
                               content_type=meta.get("contentType"), ar=None, url=None, ar_preview=None, created_at=ts)
    except (OSError, ValueError, KeyError) as exc:
        log.warning("media: promoting %s… failed: %s", sha[:12], exc)
    finally:
        discard(settings, nonce_hex)
    return row


# ---------- purge ----------

def purge(conn, settings: Settings, now_ts: int) -> int:
    """Delete the staging directories of nonces that are expired, consumed or gone. Returns how many were deleted."""
    root = staging_root(settings)
    if not root.is_dir():
        return 0
    n = 0
    for d in root.iterdir():
        if not d.is_dir() or not _HEX64.match(d.name):
            continue
        row = get_nonce(conn, d.name)
        if row is None or row["used_at"] is not None or row["expires_at"] < now_ts:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    if n:
        log.info("media: purged %d staging director%s", n, "y" if n == 1 else "ies")
    return n


def maybe_purge(conn, settings: Settings, now_ts: int) -> int:
    key = str(Path(settings.media_dir))
    with _purge_lock:
        if time.monotonic() - _last_purge.get(key, -1e18) < PURGE_EVERY_S:
            return 0
        _last_purge[key] = time.monotonic()
    try:
        return purge(conn, settings, now_ts)
    except OSError as exc:
        log.warning("media: staging purge failed: %s", exc)
        return 0


# ---------- retention (reconcile job) ----------

def referenced_media(conn, failed_since: int) -> set[str]:
    """sha256 (lowercase hex) of every media an event still references: any event that is not failed, or failed at or
    after `failed_since` (the reconcile job may still recover it from its ScanProof)."""
    rows = conn.execute(
        """SELECT DISTINCT CASE WHEN m.type = 'object' THEN json_extract(m.value, '$.sha256') END
           FROM events e, json_each(e.payload_json, '$.media') m
           WHERE e.status != 'failed' OR e.ts >= ?""", (failed_since,)).fetchall()
    return {proof.strip0x(r[0]).lower() for r in rows if isinstance(r[0], str)}


def _unlink_blob(media_dir: Path, sha: str) -> int:
    freed = 0
    for f in [media_dir / f"{sha}.bin", *media_dir.glob(f"{sha}.preview.*")]:
        try:
            freed += f.stat().st_size
            f.unlink()
        except FileNotFoundError:
            continue
    return freed


def retention(conn, settings: Settings, now_ts: int, *, failed_since: int, batch: int = RETENTION_BATCH) -> dict:
    """
    Media housekeeping of the reconcile job: staging directories of expired / consumed nonces (purge), then — unless
    FV_MEDIA_RETENTION_S is 0 — promoted blobs no event references (referenced_media) whose media row is older than the
    retention, and blob files without a media row whose mtime is. Runs in one write transaction, so a VALID /api/verify
    promoting the same bytes at the same time (it moves the blob and writes the row under the same lock) can never lose
    its file. → {staging, rows, files, bytes} deleted.
    """
    out = {"staging": 0, "rows": 0, "files": 0, "bytes": 0}
    try:
        out["staging"] = purge(conn, settings, now_ts)
    except OSError as exc:
        log.warning("media: staging purge failed: %s", exc)
    ttl = int(getattr(settings, "media_retention_s", 0) or 0)
    media_dir = Path(settings.media_dir)
    if ttl <= 0 or not media_dir.is_dir():
        return out
    cutoff = now_ts - ttl
    with transaction(conn):
        keep = referenced_media(conn, failed_since)
        old = [r[0] for r in conn.execute("SELECT sha256 FROM media WHERE created_at < ? ORDER BY created_at", (cutoff,))]
        doomed = [sha for sha in old if sha not in keep][:batch]
        for sha in doomed:
            conn.execute("DELETE FROM media WHERE sha256=?", (sha,))
            out["bytes"] += _unlink_blob(media_dir, sha)
        out["rows"] = len(doomed)
        known = {r[0] for r in conn.execute("SELECT sha256 FROM media")}
        for f in media_dir.iterdir():
            if out["files"] >= batch:
                break
            m = _BLOB.match(f.name)
            if not m or m.group(1) in known or m.group(1) in keep or not f.is_file():
                continue
            try:
                st = f.stat()
                if st.st_mtime >= cutoff:
                    continue
                f.unlink()
            except FileNotFoundError:
                continue
            out["files"] += 1
            out["bytes"] += st.st_size
    if out["rows"] or out["files"]:
        log.info("media retention: deleted %d unreferenced media row(s), %d orphan file(s), %d bytes", out["rows"],
                 out["files"], out["bytes"])
    return out
