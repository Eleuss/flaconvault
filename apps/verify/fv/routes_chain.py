"""Chain-facing reads: POST /api/reconcile, GET /api/registry, GET /api/sites."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

from fv.chain import DecodeError, RpcError, decode_registry, pda_registry
from fv.config import Settings
from fv.db import partner_pubkeys
from fv.deps import get_conn, get_db, get_rpc, get_settings
from fv.reconcile import reconcile_once

log = logging.getLogger("fv.chain")
router = APIRouter()

FALLBACK_SITES = [{"siteId": 1, "label": "Parfümerie X, Düsseldorf"}, {"siteId": 2, "label": "FlaconVault Vault, Wickede"}]


def registry_info(conn, settings: Settings, rpc) -> dict:
    """Registry PDA from chain when FV_PROGRAM_ID is set and the RPC answers; otherwise the seed fallback."""
    if settings.program_id:
        try:
            data = rpc.get_account_info(pda_registry(settings.program_id))
            if data is not None:
                reg = decode_registry(data)
                return {"programId": settings.program_id, **reg, "sites": reg["sites"] or FALLBACK_SITES, "source": "chain"}
        except (RpcError, DecodeError) as exc:
            log.warning("registry read failed, using fallback: %s", exc)
    return {"programId": settings.program_id or None, "authority": None, "serverKeys": [], "partners": partner_pubkeys(conn),
            "sites": FALLBACK_SITES, "source": "fallback"}


@router.get("/api/registry")
def registry(conn=Depends(get_conn), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    return registry_info(conn, settings, rpc)


@router.get("/api/sites")
def sites(conn=Depends(get_conn), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    return registry_info(conn, settings, rpc)["sites"]


@router.post("/api/reconcile")
def reconcile(db=Depends(get_db), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    return reconcile_once(db, settings, rpc)
