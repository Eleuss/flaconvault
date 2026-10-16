"""Chain-facing reads: POST /api/reconcile (x-admin-token), GET /api/registry, GET /api/sites."""
from __future__ import annotations

import logging
import threading
import time

from fastapi import APIRouter, Depends, Request

from fv.chain import DecodeError, RpcError, decode_registry, pda_registry
from fv.config import Settings
from fv.db import get_chain_state, now as wall_now, partner_pubkeys
from fv.deps import get_conn, get_db, get_rpc, get_settings, require_admin
from fv.ratelimit import rate_limit
from fv.reconcile import reconcile_once

log = logging.getLogger("fv.chain")
router = APIRouter()

FALLBACK_SITES = [{"siteId": 1, "label": "Parfümerie X, Düsseldorf"}, {"siteId": 2, "label": "FlaconVault Vault, Wickede"}]

REGISTRY_TTL_S = 60.0          # a chain read is reused for this long (one RPC call per minute, not per request)
REGISTRY_STALE_S = 900.0       # while the RPC fails, the last chain read stays usable this long
REGISTRY_RETRY_S = 10.0        # after a failed read the chain is asked again at most this often (negative cache)


def _read_registry(conn, settings: Settings, rpc) -> dict | None:
    """
    The registry PDA from chain; None when it is missing or unreadable. Its sites are the chain's own list — possibly
    empty: the demo FALLBACK_SITES are never served as chain data.
    """
    try:
        data = rpc.get_account_info(pda_registry(settings.program_id))
        if data is not None:
            reg = decode_registry(data)
            return {"programId": settings.program_id, **reg, "sites": list(reg["sites"] or []), "source": "chain"}
    except (RpcError, DecodeError) as exc:
        log.warning("registry read failed: %s", exc)
    return None


def _stored_registry(conn, settings: Settings) -> dict | None:
    """The registry the reconcile job decoded last (chain_state), while it is younger than REGISTRY_STALE_S."""
    try:
        st = get_chain_state(conn, "registry")
    except Exception:  # noqa: BLE001 — an old database without chain_state
        return None
    if not st or (st["value"] or {}).get("programId") != settings.program_id or wall_now() - int(st["updatedAt"]) >= REGISTRY_STALE_S:
        return None
    reg = st["value"]
    return {**reg, "sites": list(reg.get("sites") or []), "source": "chain"}


def _fallback(conn, settings: Settings) -> dict:
    return {"programId": settings.program_id or None, "authority": None, "serverKeys": [], "partners": partner_pubkeys(conn),
            "sites": FALLBACK_SITES, "source": "fallback"}


class RegistryCache:
    def __init__(self):
        self.value: dict | None = None      # last successful chain read
        self.at = 0.0                       # … and when it was made (monotonic)
        self.failed_at: float | None = None  # last failed read (negative cache)
        self.lock = threading.Lock()        # guards the fields
        self.refresh = threading.Lock()     # single flight: one thread reads the chain, the others use what is cached


_CACHE_INIT = threading.Lock()


def _cache(holder) -> RegistryCache:
    c = getattr(holder, "registry_cache", None)
    if c is None:
        with _CACHE_INIT:
            c = getattr(holder, "registry_cache", None)
            if c is None:
                c = RegistryCache()
                holder.registry_cache = c
    return c


def _cached(c: RegistryCache, conn, settings: Settings, now: float) -> dict:
    """Without a fresh read: the last chain read while it is not too old, then chain_state, then the fallback."""
    with c.lock:
        if c.value is not None and now - c.at < REGISTRY_STALE_S:
            return c.value
    return _stored_registry(conn, settings) or _fallback(conn, settings)


def registry_info(conn, settings: Settings, rpc, *, cache_holder=None, now: float | None = None) -> dict:
    """
    Registry PDA from chain when FV_PROGRAM_ID is set and the RPC answers; otherwise the seed fallback. With a
    `cache_holder` (app.state):
      * a chain read is reused for REGISTRY_TTL_S;
      * after a failed read the chain is not asked again for REGISTRY_RETRY_S (the last chain read is served while it is
        younger than REGISTRY_STALE_S, then the stored registry, then the fallback), so an RPC outage costs one call per
        REGISTRY_RETRY_S instead of one 5 s call per request;
      * only one thread refreshes at a time; concurrent requests get the cached value (or the stale/fallback chain)
        instead of waiting for the RPC.
    Without one, the registry the reconcile job stored (chain_state, at most REGISTRY_STALE_S old) is used before
    falling back.
    """
    if not settings.program_id:
        return _fallback(conn, settings)
    if cache_holder is None:
        return _read_registry(conn, settings, rpc) or _stored_registry(conn, settings) or _fallback(conn, settings)
    c = _cache(cache_holder)
    now = time.monotonic() if now is None else now
    with c.lock:
        if c.value is not None and now - c.at < REGISTRY_TTL_S:
            return c.value
    if not c.refresh.acquire(blocking=False):
        return _cached(c, conn, settings, now)    # another request is reading the chain right now
    try:
        with c.lock:                               # a refresh may just have finished, or failed a moment ago
            if c.value is not None and now - c.at < REGISTRY_TTL_S:
                return c.value
            backing_off = c.failed_at is not None and now - c.failed_at < REGISTRY_RETRY_S
        if backing_off:
            return _cached(c, conn, settings, now)
        fresh = _read_registry(conn, settings, rpc)
        with c.lock:
            if fresh is not None:
                c.value, c.at, c.failed_at = fresh, now, None
                return fresh
            c.failed_at = now
    finally:
        c.refresh.release()
    return _cached(c, conn, settings, now)


def registry_partners(request: Request, conn, settings: Settings, rpc) -> set[str] | None:
    """Partner pubkeys from the on-chain registry (cached); None when no chain registry could be read."""
    reg = registry_info(conn, settings, rpc, cache_holder=request.app.state)
    return set(reg["partners"]) if reg["source"] == "chain" else None


def is_registry_partner(request: Request, conn, settings: Settings, rpc, pubkey: str | None) -> bool:
    """
    May `pubkey` attest certified scans (tier ≥ 3, roles VAULT/PARTNER)? The on-chain registry decides. Only a
    deployment without FV_PROGRAM_ID (local simulator) uses the DB partner list.
    """
    if not pubkey:
        return False
    reg = registry_info(conn, settings, rpc, cache_holder=request.app.state)
    if reg["source"] != "chain" and settings.program_id:
        return False                      # chain configured but unreadable: never trust seed data
    return pubkey in reg["partners"]


@router.get("/api/registry")
def registry(request: Request, conn=Depends(get_conn), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    return registry_info(conn, settings, rpc, cache_holder=request.app.state)


@router.get("/api/sites")
def sites(request: Request, conn=Depends(get_conn), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    return registry_info(conn, settings, rpc, cache_holder=request.app.state)["sites"]


@router.post("/api/reconcile", dependencies=[Depends(rate_limit), Depends(require_admin)])
def reconcile(db=Depends(get_db), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    return reconcile_once(db, settings, rpc)
