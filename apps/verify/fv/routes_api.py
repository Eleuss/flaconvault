"""/health, /api/session, /api/preview, /api/verify, /api/media, /api/events, /api/passport(s), /api/attester."""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator

from fv import proof
from fv.config import Settings
from fv.db import (bump_attester, confirm_event, consume_nonce, get_attester, get_event, get_nonce, get_passport,
                   get_seal_by_hash, insert_event, insert_nonce, insert_tap, list_passports, mark_seal_dead, now,
                   previous_scan_before, purge_nonces, set_passport_grade, upsert_attester, upsert_passport,
                   upsert_seal, void_passport, transaction)
from fv.deps import get_conn, get_settings
from fv.enums import EventType, Grade, Indicator, NONCE_INVALID, NO_RESPONSE, SealKind, Tamper, VALID
from fv.service import check_tap
from fv.strings import tap_message
from fv.views import attester_view, event_view, passport_list_view, passport_view

router = APIRouter()

Platform = Literal["ANDROID_WEB", "IOS_WEB", "DESKTOP_WEB", "SIMULATOR"]


# ---------- models ----------

class Indicators(BaseModel):
    heat: int = Field(ge=0, le=3)
    humidity: int = Field(ge=0, le=3)
    uv: int = Field(default=Indicator.MISSING, ge=0, le=3)


class Location(BaseModel):
    country: str | None = Field(default=None, max_length=2)
    city: str | None = Field(default=None, max_length=80)


class PreviewBody(BaseModel):
    uid: str
    ctr: str | int
    cmac: str


class VerifyBody(BaseModel):
    uid: str
    ctr: str | int
    cmac: str
    nonce: str
    role: int = Field(ge=0, le=4)
    tier: int = Field(ge=0, le=4)
    indicators: Indicators
    heatLevels: list[int] = Field(min_length=6, max_length=6)
    fill: int = Field(ge=0, le=100)
    mediaHash: str | None = None
    serial: str | None = None
    location: Location | None = None
    attester: str | None = Field(default=None, min_length=32, max_length=64)
    platform: Platform = "SIMULATOR"
    tamper: int = Field(default=Tamper.UNKNOWN, ge=0, le=3)
    note: str = Field(default="", max_length=280)

    @field_validator("heatLevels")
    @classmethod
    def _bits(cls, v: list[int]) -> list[int]:
        if any(x not in (0, 1) for x in v):
            raise ValueError("heatLevels entries must be 0/1")
        return v


class EventBody(BaseModel):
    eventId: int | None = None
    serial: str | None = None
    type: int | str | None = None
    txSig: str | None = None
    sealUidHash: str | None = None
    actor: str | None = None
    actorLabel: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: int | None = None
    location: Location | None = None
    status: Literal["pending", "confirmed", "failed"] | None = None


# ---------- health / session ----------

@router.get("/health")
def health(settings: Settings = Depends(get_settings)):
    return {"ok": True, "keyId": settings.server_key_id, "pubkeyHex": proof.public_key(settings.server_seed).hex(),
            "simulator": settings.dev_simulator, "programId": settings.program_id or None}


@router.post("/api/session")
def session(conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    ts = now()
    nonce = os.urandom(32).hex()
    with transaction(conn):
        insert_nonce(conn, nonce, ts, ts + settings.nonce_ttl_s)
        purge_nonces(conn, ts)
    return {"nonce": "0x" + nonce, "issuedAt": ts, "expiresAt": ts + settings.nonce_ttl_s, "ttl": settings.nonce_ttl_s}


# ---------- preview / verify ----------

def _tap_fields(chk) -> dict:
    return {
        "verdict": chk.verdict, "counter": chk.counter,
        "serial": chk.serial,
        "serialHash": proof.hex0x(proof.serial_hash(chk.serial)) if chk.serial else None,
        "uidHash": ("0x" + chk.uid_hash_hex) if chk.uid_hash_hex else None,
        "sealKind": chk.seal["kind"] if chk.seal else None,
        "sealDead": chk.seal_dead if chk.seal else None,
    }


@router.post("/api/preview")
def preview(body: PreviewBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    chk = check_tap(conn, settings, body.uid, body.ctr, body.cmac, consume=False)
    out = _tap_fields(chk)
    if chk.verdict == VALID and chk.seal_dead:
        out["verdict"] = NO_RESPONSE
    out["message"] = tap_message(out["verdict"], chk.counter)
    return out


@router.post("/api/verify")
def verify(body: VerifyBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    ts = now()
    pub_hex = proof.public_key(settings.server_seed).hex()
    heat_mask = proof.heat_levels_to_mask(body.heatLevels)
    base = {"heatMask": heat_mask, "serverSig": None, "serverPubkey": pub_hex, "keyId": settings.server_key_id,
            "ts": ts, "msgHex": None, "bundle": None, "bundleHash": None, "eventId": None, "reviewRecommended": False}

    # heat consistency: indicators.heat ∈ {0,1} must equal heatLevels[4]; 2/3 are trusted as sent.
    heat = body.indicators.heat
    if heat in (Indicator.INTACT, Indicator.TRIGGERED) and heat != body.heatLevels[proof.HEAT_DECISIVE_INDEX]:
        raise HTTPException(422, "indicators.heat must equal heatLevels[4] (the 40 °C field)")
    hum, uv, tamper = body.indicators.humidity, Indicator.MISSING, body.tamper
    if body.tier >= 2:
        if not body.mediaHash:
            raise HTTPException(422, "mediaHash required for tier ≥ 2")
        try:
            media_hash = proof.parse_hex(body.mediaHash, 32, "mediaHash")
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    else:
        media_hash = proof.ZERO32
    try:
        nonce_b = proof.parse_hex(body.nonce, 32, "nonce")
    except ValueError:
        nonce_b = None

    with transaction(conn):
        # 1. nonce
        n = get_nonce(conn, nonce_b.hex()) if nonce_b else None
        if not n or n["used_at"] is not None or n["expires_at"] < ts:
            g, _ = proof.compute_grade(verdict=NONCE_INVALID, tamper=tamper, heat=heat, hum=hum, fill=body.fill)
            return {**base, "verdict": NONCE_INVALID, "counter": None, "serial": None, "serialHash": None, "uidHash": None,
                    "sealKind": None, "sealDead": None, "grade": g, "message": tap_message(NONCE_INVALID)}
        # 2.–5. key, CMAC, counter (advances), seal
        chk = check_tap(conn, settings, body.uid, body.ctr, body.cmac, consume=True)
        verdict = chk.verdict
        if verdict == VALID and chk.seal_dead:
            verdict = NO_RESPONSE
        if verdict == VALID and body.serial and body.serial != chk.serial:
            raise HTTPException(409, f"serial mismatch: tag belongs to {chk.serial}")
        message = tap_message(verdict, chk.counter)
        insert_tap(conn, ts=ts, source="verify", uid_hex=chk.uid_hex, ctr=chk.counter, cmac=chk.cmac_hex,
                   verdict=verdict, serial=chk.serial, message=message)
        grade, review = proof.compute_grade(verdict=verdict, tamper=tamper, heat=heat, hum=hum, fill=body.fill,
                                            seal_dead=chk.seal_dead)
        out = {**base, **_tap_fields(chk), "verdict": verdict, "grade": grade, "reviewRecommended": review, "message": message}
        if verdict != VALID:
            return out

        # 6. message, signature, nonce consumed, SCAN(pending) event, attesters
        seal = chk.seal
        serial = seal["serial"]
        sh, uh = proof.serial_hash(serial), bytes.fromhex(chk.uid_hash_hex)
        msg = proof.build_message(serial_hash=sh, uid_hash=uh, counter=chk.counter, tamper=tamper, uv=uv, hum=hum,
                                  heat=heat, fill=body.fill, media_hash=media_hash, nonce=nonce_b, ts=ts)
        sig = proof.sign(settings.server_seed, msg)
        loc = body.location or Location()
        bundle = proof.build_bundle(
            serial=serial, serial_hash_b=sh, uid_hash_b=uh, counter=chk.counter, seal_kind=seal["kind"], tamper=tamper,
            heat=heat, hum=hum, uv=uv, heat_levels=body.heatLevels, fill=body.fill, country=loc.country, city=loc.city,
            media_hash_b=media_hash if body.tier >= 2 else None, media_ar=None, nonce_b=nonce_b, issued_at=n["issued_at"],
            platform=body.platform, role=body.role, tier=body.tier, attester=body.attester, key_id=settings.server_key_id,
            verdict=VALID, server_ts=ts, sig_b=sig, bundle_ts=ts, note=body.note)
        canonical = proof.canonical_json(bundle)
        b_hash = proof.bundle_hash(canonical)
        consume_nonce(conn, nonce_b.hex(), ts)
        actor_label = None
        if body.attester:
            a = get_attester(conn, body.attester)
            actor_label = a["label"] if a else None
        payload = {**bundle, "grade": grade, "reviewRecommended": review, "msgHex": msg.hex(), "bundleHash": proof.hex0x(b_hash)}
        ev = insert_event(conn, serial=serial, type=EventType.SCAN, ts=ts, actor_pubkey=body.attester, actor_label=actor_label,
                          tx_sig=None, status="pending", seal_uid_hash=seal["uid_hash"], payload=payload, grade_after=grade,
                          country=loc.country, city=loc.city)
        set_passport_grade(conn, serial, grade)
        if body.attester:
            bump_attester(conn, body.attester, ts, scans=1, certified=1 if body.tier >= 3 else 0)
            prev = previous_scan_before(conn, serial, ev["id"])
            if prev and prev["actor_pubkey"] and prev["actor_pubkey"] != body.attester:
                pb = json.loads(prev["payload_json"])
                pi = pb.get("indicators") or {}
                agree = (pi.get("heat") == heat and pi.get("humidity") == hum and abs(int(pb.get("fill", -100)) - body.fill) <= 5)
                bump_attester(conn, prev["actor_pubkey"], ts, compare=1, agree=1 if agree else 0)
        out.update({"serverSig": proof.hex0x(sig), "msgHex": msg.hex(), "bundle": bundle, "bundleHash": proof.hex0x(b_hash),
                    "eventId": ev["id"]})
        return out


# ---------- media ----------

@router.post("/api/media")
async def media(file: list[UploadFile] | None = File(default=None), files: list[UploadFile] | None = File(default=None),
                settings: Settings = Depends(get_settings)):
    uploads = [*(file or []), *(files or [])]
    if not uploads:
        raise HTTPException(422, "no file(s) uploaded (multipart field 'file' or 'files')")
    h = hashlib.sha256()
    chunks: list[bytes] = []
    total = 0
    for up in uploads:
        data = await up.read()
        h.update(data)
        chunks.append(data)
        total += len(data)
    digest = h.hexdigest()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    path = settings.media_dir / f"{digest}.bin"
    if not path.exists():
        with open(path, "wb") as f:
            for c in chunks:
                f.write(c)
    return {"sha256": "0x" + digest, "ar": None, "bytes": total, "files": len(uploads)}


# ---------- events ----------

def _event_type(v: int | str) -> int:
    if isinstance(v, int):
        if v not in EventType.values():
            raise HTTPException(422, f"unknown event type {v}")
        return v
    try:
        return getattr(EventType, v.upper())
    except AttributeError as exc:
        raise HTTPException(422, f"unknown event type {v!r}") from exc


@router.post("/api/events")
def events(body: EventBody, conn=Depends(get_conn)):
    ts = body.ts or now()
    with transaction(conn):
        if body.eventId is not None:
            if not get_event(conn, body.eventId):
                raise HTTPException(404, "event not found")
            row = confirm_event(conn, body.eventId, body.txSig, body.status or "confirmed")
            return event_view(row)  # type: ignore[arg-type]

        if not body.serial or body.type is None:
            raise HTTPException(422, "serial and type are required for a new event")
        etype = _event_type(body.type)
        payload = dict(body.payload)
        loc = body.location or Location()
        actor_label = body.actorLabel
        if body.actor:
            a = get_attester(conn, body.actor)
            actor_label = actor_label or (a["label"] if a else None)
            upsert_attester(conn, pubkey=body.actor, first_seen=ts, label=body.actorLabel)

        passport = get_passport(conn, body.serial)
        if etype == EventType.MINT and not passport:
            if not payload.get("brand") or not payload.get("name"):
                raise HTTPException(422, "MINT for an unknown serial needs payload.brand and payload.name")
            passport = upsert_passport(conn, serial=body.serial, serial_hash=proof.serial_hash(body.serial).hex(),
                                       brand=payload["brand"], name=payload["name"], batch=payload.get("batch"),
                                       asset=payload.get("asset"), issuer=body.actor,
                                       issuer_label=payload.get("issuerLabel") or actor_label, grade=Grade.A, void=False,
                                       created_at=ts)
        if not passport:
            raise HTTPException(404, "passport not found")

        seal_uid_hash = proof.strip0x(body.sealUidHash).lower() if body.sealUidHash else None
        if etype == EventType.SEAL_ATTACH:
            uid_hex = payload.get("uid")
            if not uid_hex:
                raise HTTPException(422, "SEAL_ATTACH needs payload.uid (7 bytes hex)")
            try:
                uid_b = proof.parse_hex(uid_hex, 7, "uid")
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            kind = int(payload.get("kind", SealKind.NECK))
            seal = upsert_seal(conn, uid_hash=proof.uid_hash(uid_b).hex(), uid_hex=uid_b.hex().upper(), serial=body.serial,
                               kind=kind, attached_at=ts)
            seal_uid_hash = seal["uid_hash"]
            payload.setdefault("uidHash", "0x" + seal_uid_hash)
            payload.setdefault("kindName", SealKind.name(kind) if kind in SealKind.values() else "LOOP")
        if etype == EventType.SEAL_DEAD:
            if seal_uid_hash:
                if not get_seal_by_hash(conn, seal_uid_hash):
                    raise HTTPException(404, "seal not found")
                mark_seal_dead(conn, seal_uid_hash)
            void_passport(conn, body.serial, Grade.VOID)

        p = get_passport(conn, body.serial)
        grade_after = Grade.VOID if p["void"] else p["grade"]
        status = body.status or ("confirmed" if body.txSig else "pending")
        row = insert_event(conn, serial=body.serial, type=etype, ts=ts, actor_pubkey=body.actor, actor_label=actor_label,
                           tx_sig=body.txSig, status=status, seal_uid_hash=seal_uid_hash, payload=payload,
                           grade_after=grade_after, country=loc.country, city=loc.city)
        return event_view(row)


# ---------- passports / attesters ----------

@router.get("/api/passport/{serial}")
def passport(serial: str, conn=Depends(get_conn)):
    v = passport_view(conn, serial)
    if not v:
        raise HTTPException(404, "passport not found")
    return v


@router.get("/api/passports")
def passports(conn=Depends(get_conn)):
    return passport_list_view(list_passports(conn))


@router.get("/api/attester/{pubkey}")
def attester(pubkey: str, conn=Depends(get_conn)):
    a = get_attester(conn, pubkey)
    if not a:
        raise HTTPException(404, "attester not found")
    return attester_view(conn, a)
