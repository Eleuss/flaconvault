"""Chain-facing reads: POST /api/reconcile (x-admin-token), GET /api/registry, GET /api/sites."""
from __future__ import annotations

import logging
import threading
import time

from fastapi import APIRouter, Depends, Request

from fv.chain import DecodeError, RpcError, decode_registry, pda_registry
from fv.config import Settings
from fv.db import partner_pubkeys
from fv.deps import get_conn, get_db, get_rpc, get_settings, require_admin
from fv.ratelimit import rate_limit
from fv.reconcile import reconcile_once

log = logging.getLogger("fv.chain")
router = APIRouter()

FALLBACK_SITES = [{"siteId": 1, "label": "Parfümerie X, Düsseldorf"}, {"siteId": 2, "label": "FlaconVault Vault, Wickede"}]

REGISTRY_TTL_S = 60.0          # a chain read is reused for this long (one RPC call per minute, not per request)
REGISTRY_STALE_S = 900.0       # while the RPC fails, the last chain read stays usable this long


def _read_registry(conn, settings: Settings, rpc) -> dict | None:
    """The registry PDA from chain; None when it is missing or unreadable."""
    try:
        data = rpc.get_account_info(pda_registry(settings.program_id))
        if data is not None:
            reg = decode_registry(data)
            return {"programId": settings.program_id, **reg, "sites": reg["sites"] or FALLBACK_SITES, "source": "chain"}
    except (RpcError, DecodeError) as exc:
        log.warning("registry read failed: %s", exc)
    return None


def _fallback(conn, settings: Settings) -> dict:
    return {"programId": settings.program_id or None, "authority": None, "serverKeys": [], "partners": partner_pubkeys(conn),
            "sites": FALLBACK_SITES, "source": "fallback"}


class RegistryCache:
    def __init__(self):
        self.value: dict | None = None
        self.at = 0.0
        self.lock = threading.Lock()


def _cache(holder) -> RegistryCache:
    c = getattr(holder, "registry_cache", None)
    if c is None:
        c = RegistryCache()
        holder.registry_cache = c
    return c


def registry_info(conn, settings: Settings, rpc, *, cache_holder=None, now: float | None = None) -> dict:
    """
    Registry PDA from chain when FV_PROGRAM_ID is set and the RPC answers; otherwise the seed fallback. With a
    `cache_holder` (app.state) a chain read is reused for REGISTRY_TTL_S, and a failing RPC keeps the last chain read
    for REGISTRY_STALE_S before falling back.
    """
    if not settings.program_id:
        return _fallback(conn, settings)
    if cache_holder is None:
        return _read_registry(conn, settings, rpc) or _fallback(conn, settings)
    c = _cache(cache_holder)
    now = time.monotonic() if now is None else now
    with c.lock:
        if c.value is not None and now - c.at < REGISTRY_TTL_S:
            return c.value
    fresh = _read_registry(conn, settings, rpc)
    with c.lock:
        if fresh is not None:
            c.value, c.at = fresh, now
            return fresh
        if c.value is not None and now - c.at < REGISTRY_STALE_S:
            return c.value
    return _fallback(conn, settings)


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
