"""Simulator (/api/dev/*) — only when FV_DEV_SIMULATOR=true, otherwise every route is 404."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from fv import proof
from fv.config import Settings
from fv.db import (get_passport, get_seal_by_uid, get_sim_tag, insert_tap, list_sim_tags, now, transaction,
                   update_sim_tag, upsert_seal, upsert_sim_tag)
from fv.deps import get_conn, get_db, get_settings
from fv.enums import NO_RESPONSE, SealKind
from fv.sdm import ctr_hex, key_for_uid, parse_uid, sdm_cmac, tag_url
from fv.seed import run_seed
from fv.strings import tap_message
from fv.views import sim_tag_view


def _simulator_only(settings: Settings = Depends(get_settings)) -> None:
    if not settings.dev_simulator:
        raise HTTPException(404, "not found")


router = APIRouter(prefix="/api/dev", dependencies=[Depends(_simulator_only)])


class TagBody(BaseModel):
    uid: str | None = None
    serial: str | None = None
    kind: int = Field(default=SealKind.NECK, ge=0, le=2)


class UidBody(BaseModel):
    uid: str


def _tag(conn, uid: str) -> dict:
    t = get_sim_tag(conn, uid)
    if not t:
        raise HTTPException(404, "virtual tag not found")
    return t


@router.post("/tag")
def create_tag(body: TagBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    ts = now()
    uid_b = parse_uid(body.uid) if body.uid else (b"\x04" + os.urandom(6))
    uid_hex = uid_b.hex().upper()
    key = key_for_uid(settings.key_mode, settings.master_key, uid_b)
    with transaction(conn):
        if body.serial and not get_passport(conn, body.serial):
            raise HTTPException(404, "passport not found")
        t = upsert_sim_tag(conn, uid_hex=uid_hex, key_hex=key.hex(), counter=0, alive=True, created_at=ts, serial=body.serial)
        seal = get_seal_by_uid(conn, uid_hex)
        if body.serial:
            seal = upsert_seal(conn, uid_hash=proof.uid_hash(uid_b).hex(), uid_hex=uid_hex, serial=body.serial,
                               kind=body.kind, attached_at=ts)
    return sim_tag_view(t, seal)


@router.post("/tap")
def tap(body: UidBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    with transaction(conn):
        t = _tag(conn, body.uid)
        seal = get_seal_by_uid(conn, t["uid_hex"])
        if not t["alive"]:
            row = insert_tap(conn, ts=now(), source="sim", uid_hex=t["uid_hex"], ctr=None, cmac=None, verdict=NO_RESPONSE,
                             serial=seal["serial"] if seal else t["serial"], message=tap_message(NO_RESPONSE))
            url = f"{settings.web_url}/t?tap={row['id']}"
            update_sim_tag(conn, t["uid_hex"], last_url=url)
            return {"responds": False, "uid": t["uid_hex"], "tapId": row["id"], "url": url, "message": row["message"]}
        ctr = int(t["counter"]) + 1
        uid_b, key = bytes.fromhex(t["uid_hex"]), bytes.fromhex(t["key_hex"])
        cmac = sdm_cmac(uid_b, ctr, key)
        url = tag_url(settings.verifier_host, uid_b, ctr, cmac)
        update_sim_tag(conn, t["uid_hex"], counter=ctr, last_url=url)
    return {"responds": True, "uid": t["uid_hex"], "ctr": ctr, "ctrHex": ctr_hex(ctr), "cmac": cmac.hex().upper(), "url": url}


@router.post("/kill")
def kill(body: UidBody, conn=Depends(get_conn)):
    with transaction(conn):
        t = _tag(conn, body.uid)
        t = update_sim_tag(conn, t["uid_hex"], alive=False)
    return sim_tag_view(t, get_seal_by_uid(conn, t["uid_hex"]))


@router.post("/revive")
def revive(body: UidBody, conn=Depends(get_conn)):
    with transaction(conn):
        t = _tag(conn, body.uid)
        t = update_sim_tag(conn, t["uid_hex"], alive=True)
    return sim_tag_view(t, get_seal_by_uid(conn, t["uid_hex"]))


@router.get("/tags")
def tags(conn=Depends(get_conn)):
    return [sim_tag_view(t, get_seal_by_uid(conn, t["uid_hex"])) for t in list_sim_tags(conn)]


@router.post("/reset")
def reset(db=Depends(get_db), settings: Settings = Depends(get_settings)):
    counts = run_seed(db, settings, wipe=True)
    return {"ok": True, "seeded": counts}
