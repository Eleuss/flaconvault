"""/health, /api/session, /api/preview, /api/verify, /api/media, /api/events, /api/passport(s), /api/attester."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from fv import arweave, proof, txverify
from fv.chain import pda_passport, pda_scan, pda_seal
from fv.config import Settings
from fv.db import (consume_nonce, event_actors, find_event, get_attester, get_event, get_media, get_nonce, get_passport,
                   get_seal_by_hash, insert_event, insert_nonce, insert_tap, list_passports, mark_seal_dead, now,
                   purge_nonces, seals_for, update_event_payload, upsert_attester, upsert_media, upsert_passport,
                   upsert_seal, void_passport, transaction)
from fv.deps import get_conn, get_rpc, get_settings
from fv.enums import EventType, Grade, Indicator, NONCE_INVALID, NO_RESPONSE, SEAL_KIND_NAMES, SealKind, Tamper, VALID
from fv.service import adopt_tap, apply_confirmed_scan, check_tap
from fv.strings import tap_message
from fv.views import attester_view, event_view, passport_list_view, passport_view

log = logging.getLogger("fv.api")
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
    uid: str | None = None
    ctr: str | int | None = None
    cmac: str
    piccData: str | None = None      # encrypted SUN (NFC Developer App): 16/24 byte hex; uid/ctr not needed then
    enc: str | None = None           # SDMENCFileData (TagTamper `/tagtt`), decrypted and ignored


class VerifyBody(BaseModel):
    uid: str | None = None
    ctr: str | int | None = None
    cmac: str | None = None
    piccData: str | None = None
    enc: str | None = None
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
    tapId: int | None = None   # adopt a tap already consumed by /t (same phone, ≤ 3 min, not yet verified) …
    tapToken: str | None = Field(default=None, max_length=64)   # … with the one-time token from the /t redirect (`k`)
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
    serial: str | None = Field(default=None, max_length=64)
    type: int | str | None = None
    txSig: str | None = Field(default=None, max_length=128)
    sealUidHash: str | None = Field(default=None, max_length=66)
    actor: str | None = Field(default=None, max_length=64)
    actorLabel: str | None = Field(default=None, max_length=120)
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: int | None = None            # ignored: the server uses the tx blockTime (else now)
    location: Location | None = None
    status: Literal["pending", "confirmed", "failed"] | None = None   # ignored: the server decides the status
    nonce: str | None = None         # SEAL_DEAD report without txSig: an unused nonce from POST /api/session


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
        "verdict": chk.verdict, "counter": chk.counter, "uid": chk.uid_hex,
        "serial": chk.serial,
        "serialHash": proof.hex0x(proof.serial_hash(chk.serial)) if chk.serial else None,
        "uidHash": ("0x" + chk.uid_hash_hex) if chk.uid_hash_hex else None,
        "sealKind": chk.seal["kind"] if chk.seal else None,
        "sealDead": chk.seal_dead if chk.seal else None,
    }


@router.post("/api/preview")
def preview(body: PreviewBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    chk = check_tap(conn, settings, body.uid, body.ctr, body.cmac, consume=False, picc_data=body.piccData, enc=body.enc)
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
    hum, uv, tamper = body.indicators.humidity, body.indicators.uv, body.tamper   # uv: read from the card since frame mode (Rev C holder)
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
        # 2.–5. key, CMAC, counter (advances), seal — or adopt the tap /t already verified and consumed
        if body.tapId is not None:
            chk = adopt_tap(conn, body.tapId, body.tapToken, ts)
        else:
            chk = check_tap(conn, settings, body.uid, body.ctr, body.cmac, consume=True, picc_data=body.piccData, enc=body.enc)
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
        media_row = get_media(conn, media_hash.hex()) if body.tier >= 2 else None
        bundle = proof.build_bundle(
            serial=serial, serial_hash_b=sh, uid_hash_b=uh, counter=chk.counter, seal_kind=seal["kind"], tamper=tamper,
            heat=heat, hum=hum, uv=uv, heat_levels=body.heatLevels, fill=body.fill, country=loc.country, city=loc.city,
            media_hash_b=media_hash if body.tier >= 2 else None, media_ar=(media_row["ar"] if media_row else None),
            nonce_b=nonce_b, issued_at=n["issued_at"],
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
        # SCAN(pending): passport grade and attester stats change only once the scan is confirmed on chain
        # (POST /api/events with the record_scan tx, or the reconcile job) — see service.apply_confirmed_scan.
        ev = insert_event(conn, serial=serial, type=EventType.SCAN, ts=ts, actor_pubkey=body.attester, actor_label=actor_label,
                          tx_sig=None, status="pending", seal_uid_hash=seal["uid_hash"], payload=payload, grade_after=grade,
                          country=loc.country, city=loc.city)
        out.update({"serverSig": proof.hex0x(sig), "msgHex": msg.hex(), "bundle": bundle, "bundleHash": proof.hex0x(b_hash),
                    "eventId": ev["id"]})
        return out


# ---------- media ----------

MEDIA_MAX_FILES = 6
MEDIA_MAX_BYTES = 8 * 1024 * 1024                     # per file
MEDIA_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}   # content type → stored preview extension


@router.post("/api/media")
async def media(file: list[UploadFile] | None = File(default=None), files: list[UploadFile] | None = File(default=None),
                conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    uploads = [*(file or []), *(files or [])]
    if not uploads:
        raise HTTPException(422, "no file(s) uploaded (multipart field 'file' or 'files')")
    if len(uploads) > MEDIA_MAX_FILES:
        raise HTTPException(413, f"at most {MEDIA_MAX_FILES} files per upload")
    types = [(up.content_type or "").split(";")[0].strip().lower() for up in uploads]
    if any(t not in MEDIA_TYPES for t in types):
        raise HTTPException(415, "only image/jpeg, image/png and image/webp are accepted")
    h = hashlib.sha256()
    chunks: list[bytes] = []
    total = 0
    for up in uploads:
        data = await up.read(MEDIA_MAX_BYTES + 1)
        if len(data) > MEDIA_MAX_BYTES:
            raise HTTPException(413, f"each file must be at most {MEDIA_MAX_BYTES // (1024 * 1024)} MB")
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
    content_type = types[0]                 # whitelisted above — never the raw client string

    def _view(row):
        return {"sha256": "0x" + digest, "ar": row["ar"], "url": row["url"], "arPreview": row["ar_preview"], "bytes": total, "files": len(uploads)}

    existing = get_media(conn, digest)
    if existing and existing["ar"]:
        return _view(existing)              # already archived — never upload the same bytes twice

    ar = url = preview = None
    if arweave.enabled(settings):
        res = await run_in_threadpool(arweave.upload_file, path, content_type, settings, {"App-Type": "seal-frames", "FV-Sha256": digest})
        if res:
            ar, url = res["ar"], res["url"]
            if len(uploads) > 1:            # several frames → the first one alone as a viewable thumbnail
                ppath = settings.media_dir / f"{digest}.preview.{MEDIA_TYPES[content_type]}"
                ppath.write_bytes(chunks[0])
                pres = await run_in_threadpool(arweave.upload_file, ppath, content_type, settings, {"App-Type": "seal-frame-preview", "FV-Sha256": digest})
                preview = pres["url"] if pres else None
            else:
                preview = url
    with transaction(conn):
        row = upsert_media(conn, sha256_hex=digest, bytes_=total, files=len(uploads), content_type=content_type, ar=ar, url=url,
                           ar_preview=preview, created_at=now())
    return _view(row)


# ---------- events ----------
#
# Contract (the web client depends on it):
#   new event   {serial, type, txSig, actor, payload?, sealUidHash?, location?}   types MINT, SEAL_ATTACH, LIST…DISPUTE,
#               SEAL_DEAD with txSig — the tx is verified on chain, the event is stored `confirmed`, ts = blockTime.
#   confirm     {eventId, txSig, actor?}  (actor defaults to the event's attester) — a pending SCAN from /api/verify.
#   report      {serial, type: SEAL_DEAD, nonce, sealUidHash?, payload?}  — no tx: stored `reported`, no effect.
#   errors      503 tx_not_visible (retry) · 422 tx_failed · 403 tx_mismatch · 403 not_issuer · 403 nonce_invalid ·
#               409 event_confirmed · 503 chain_not_configured · 404 passport/event/seal not found · 422 malformed.
# Client `ts` and `status` are ignored.

MAX_PAYLOAD_BYTES = 16 * 1024


def _event_type(v: int | str) -> int:
    if isinstance(v, int):
        if v not in EventType.values():
            raise HTTPException(422, f"unknown event type {v}")
        return v
    try:
        return getattr(EventType, v.upper())
    except AttributeError as exc:
        raise HTTPException(422, f"unknown event type {v!r}") from exc


def _hash_arg(v: str, what: str) -> str:
    try:
        return proof.parse_hex(v, 32, what).hex()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _expectation(conn, settings: Settings, etype: int, serial: str, *, seal_uid_hash: str | None = None,
                 scan_counter: int | None = None) -> txverify.Expectation:
    if not settings.program_id:
        raise HTTPException(503, "chain_not_configured")
    pid = settings.program_id
    passport_pda = str(pda_passport(pid, proof.serial_hash(serial)))
    if etype in txverify.FLACON_IX:
        required = [passport_pda]
        if seal_uid_hash:
            seal_pda = pda_seal(pid, bytes.fromhex(seal_uid_hash))
            required.append(str(seal_pda))
            if etype == EventType.SCAN and scan_counter is not None:
                required.append(str(pda_scan(pid, seal_pda, int(scan_counter))))
        return txverify.Expectation(program=pid, instructions=txverify.FLACON_IX[etype], required=required)
    if not settings.escrow_program_id:
        raise HTTPException(503, "chain_not_configured")
    sellers = tuple(event_actors(conn, serial, EventType.LIST))
    return txverify.Expectation(program=settings.escrow_program_id, instructions=txverify.ESCROW_IX[etype],
                                order_passport=passport_pda, order_program=settings.escrow_program_id, known_sellers=sellers)


def _verify_tx(rpc, tx_sig: str, actor: str, exp: txverify.Expectation) -> txverify.VerifiedTx:
    try:
        return txverify.verify_transaction(rpc, tx_sig, actor, exp)
    except txverify.TxRejected as exc:
        log.info("events: tx %s… rejected (%s) %s", tx_sig[:12], exc.detail, exc.reason)
        raise HTTPException(exc.status, exc.detail) from exc


def _check_issuer(conn, serial: str, passport: dict | None, actor: str) -> None:
    """MINT may create/rename a passport only while no MINT exists for the serial, or when sent by its issuer."""
    if find_event(conn, serial, EventType.MINT) and not (passport and passport["issuer"] and passport["issuer"] == actor):
        raise HTTPException(403, "not_issuer")


def _actor_label(conn, actor: str, client_label: str | None, ts: int) -> str | None:
    """Stored label wins; a client label is only taken for a (verified) actor that has none yet."""
    a = get_attester(conn, actor)
    label = a["label"] if a and a["label"] else None
    upsert_attester(conn, pubkey=actor, first_seen=ts, label=None if label else (client_label or None))
    return label or client_label or None


def _settle_existing(conn, existing: dict, payload: dict, tx_sig: str, actor: str) -> dict:
    """Idempotent MINT / SEAL_ATTACH: a confirmed event is never changed again; an old pending one gets confirmed."""
    if existing["status"] == "confirmed":
        return existing
    merged = {**json.loads(existing["payload_json"] or "{}"), **payload}
    update_event_payload(conn, existing["id"], merged)
    conn.execute("UPDATE events SET tx_sig=?, status='confirmed', actor_pubkey=? WHERE id=?", (tx_sig, actor, existing["id"]))
    return get_event(conn, existing["id"])  # type: ignore[return-value]


def _seal_of_serial(conn, seal_uid_hash: str, serial: str) -> dict:
    seal = get_seal_by_hash(conn, seal_uid_hash)
    if not seal:
        raise HTTPException(404, "seal not found")
    if seal["serial"] != serial:
        raise HTTPException(422, "seal belongs to another passport")
    return seal


@router.post("/api/events")
def events(body: EventBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    tx_sig = (body.txSig or "").strip() or None
    actor = (body.actor or "").strip() or None
    if actor and not txverify.is_pubkey(actor):
        raise HTTPException(422, "actor must be a base58 pubkey")
    if body.eventId is not None:
        return _confirm_event(body.eventId, tx_sig, actor, conn, settings, rpc)

    if not body.serial or body.type is None:
        raise HTTPException(422, "serial and type are required for a new event")
    serial = body.serial
    etype = _event_type(body.type)
    payload = dict(body.payload)
    if len(json.dumps(payload, ensure_ascii=False)) > MAX_PAYLOAD_BYTES:
        raise HTTPException(413, "payload too large")
    loc = body.location or Location()
    seal_uid_hash = _hash_arg(body.sealUidHash, "sealUidHash") if body.sealUidHash else None

    if etype == EventType.SCAN:
        raise HTTPException(422, "SCAN events come from /api/verify; confirm them with {eventId, txSig, actor}")
    if etype == EventType.SEAL_DEAD and not tx_sig:
        return _report_seal_dead(body, conn, serial, payload, seal_uid_hash, loc)
    if not tx_sig or not actor:
        raise HTTPException(422, f"txSig and actor are required for {EventType.name(etype)}")

    # ---- cheap checks before any RPC (repeated under the write lock below) ----
    passport = get_passport(conn, serial)
    uid_b = None
    if etype == EventType.MINT:
        for k in ("brand", "name", "batch", "asset", "issuerLabel"):
            if payload.get(k) is not None and (not isinstance(payload[k], str) or len(payload[k]) > 200):
                raise HTTPException(422, f"payload.{k} must be a string (≤ 200 chars)")
        if not passport and not (payload.get("brand") and payload.get("name")):
            raise HTTPException(422, "MINT for an unknown serial needs payload.brand and payload.name")
        _check_issuer(conn, serial, passport, actor)
    elif not passport:
        raise HTTPException(404, "passport not found")
    if etype == EventType.SEAL_ATTACH:
        if not payload.get("uid"):
            raise HTTPException(422, "SEAL_ATTACH needs payload.uid (7 bytes hex)")
        try:
            uid_b = proof.parse_hex(str(payload["uid"]), 7, "uid")
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        seal_uid_hash = proof.uid_hash(uid_b).hex()
        other = get_seal_by_hash(conn, seal_uid_hash)
        if other and other["serial"] != serial:
            raise HTTPException(409, "seal is attached to another passport")
    if etype == EventType.SEAL_DEAD and seal_uid_hash:
        _seal_of_serial(conn, seal_uid_hash, serial)

    # ---- on-chain evidence (outside any DB transaction) ----
    vt = _verify_tx(rpc, tx_sig, actor, _expectation(conn, settings, etype, serial, seal_uid_hash=seal_uid_hash))
    ts = vt.block_time or now()

    with transaction(conn):
        if etype not in (EventType.MINT, EventType.SEAL_ATTACH):   # those two are idempotent per serial / seal below
            dup = conn.execute("SELECT * FROM events WHERE tx_sig=? AND serial=? AND type=? ORDER BY id LIMIT 1",
                               (tx_sig, serial, etype)).fetchone()
            if dup:
                return event_view(dict(dup))    # one transaction backs one event — a repeat is idempotent
        actor_label = _actor_label(conn, actor, body.actorLabel, ts)
        passport = get_passport(conn, serial)

        if etype == EventType.MINT:
            _check_issuer(conn, serial, passport, actor)
            if not passport and not (payload.get("brand") and payload.get("name")):
                raise HTTPException(422, "MINT for an unknown serial needs payload.brand and payload.name")
            passport = upsert_passport(conn, serial=serial, serial_hash=proof.serial_hash(serial).hex(),
                                       brand=payload.get("brand") or passport["brand"], name=payload.get("name") or passport["name"],
                                       batch=payload.get("batch") or (passport["batch"] if passport else None),
                                       asset=payload.get("asset"), issuer=actor,
                                       issuer_label=payload.get("issuerLabel") or actor_label, grade=Grade.A, void=False,
                                       created_at=ts)
            existing = find_event(conn, serial, EventType.MINT)
            if existing:
                return event_view(_settle_existing(conn, existing, payload, tx_sig, actor))
        if not passport:
            raise HTTPException(404, "passport not found")

        if etype == EventType.SEAL_ATTACH:
            other = get_seal_by_hash(conn, seal_uid_hash)
            if other and other["serial"] != serial:
                raise HTTPException(409, "seal is attached to another passport")
            try:
                kind = int(payload.get("kind", SealKind.NECK))
            except (TypeError, ValueError) as exc:
                raise HTTPException(422, "payload.kind must be an integer") from exc
            if kind not in SEAL_KIND_NAMES:
                raise HTTPException(422, "payload.kind must be 0 (BOX), 1 (NECK) or 2 (LOOP)")
            seal = upsert_seal(conn, uid_hash=seal_uid_hash, uid_hex=uid_b.hex().upper(), serial=serial, kind=kind, attached_at=ts)
            payload["uid"] = uid_b.hex().upper()
            payload.setdefault("uidHash", "0x" + seal["uid_hash"])
            payload.setdefault("kindName", SEAL_KIND_NAMES[kind])
            existing = find_event(conn, serial, EventType.SEAL_ATTACH, seal_uid_hash)
            if existing:
                return event_view(_settle_existing(conn, existing, payload, tx_sig, actor))

        if etype == EventType.SEAL_DEAD:
            seal_uid_hash = seal_uid_hash or _seal_in_tx(conn, settings, serial, vt)
            _apply_seal_dead(conn, serial, seal_uid_hash)

        p = get_passport(conn, serial)
        grade_after = Grade.VOID if p["void"] else p["grade"]
        row = insert_event(conn, serial=serial, type=etype, ts=ts, actor_pubkey=actor, actor_label=actor_label,
                           tx_sig=tx_sig, status="confirmed", seal_uid_hash=seal_uid_hash, payload=payload,
                           grade_after=grade_after, country=loc.country, city=loc.city)
        return event_view(row)


def _seal_in_tx(conn, settings: Settings, serial: str, vt: txverify.VerifiedTx) -> str | None:
    """mark_seal_dead without sealUidHash: the seal of this passport that the verified instruction references."""
    for s in seals_for(conn, serial):
        if str(pda_seal(settings.program_id, bytes.fromhex(s["uid_hash"]))) in vt.accounts:
            return s["uid_hash"]
    return None


def _apply_seal_dead(conn, serial: str, seal_uid_hash: str | None) -> None:
    """Effect of a *verified* SEAL_DEAD (partner's mark_seal_dead tx): seal dead, passport void."""
    if seal_uid_hash:
        mark_seal_dead(conn, seal_uid_hash)
    void_passport(conn, serial, Grade.VOID)


def _report_seal_dead(body: EventBody, conn, serial: str, payload: dict, seal_uid_hash: str | None, loc: Location):
    """
    SEAL_DEAD without a transaction (a buyer reporting a non-responding seal): needs an unused session nonce
    (consumed), is stored as `reported` and changes nothing else — no void, no dead seal, no attester row. The
    claimed reporter is kept in payload.reportedBy, unverified.
    """
    if not body.nonce:
        raise HTTPException(422, "a SEAL_DEAD report without txSig needs a session nonce (POST /api/session)")
    try:
        nonce_hex = proof.parse_hex(body.nonce, 32, "nonce").hex()
    except ValueError as exc:
        raise HTTPException(403, "nonce_invalid") from exc
    ts = now()
    with transaction(conn):
        p = get_passport(conn, serial)
        if not p:
            raise HTTPException(404, "passport not found")
        if seal_uid_hash:
            _seal_of_serial(conn, seal_uid_hash, serial)
        n = get_nonce(conn, nonce_hex)
        if not n or n["used_at"] is not None or n["expires_at"] < ts:
            raise HTTPException(403, "nonce_invalid")
        consume_nonce(conn, nonce_hex, ts)
        claimed = (body.actor or "").strip() or None
        if claimed:
            payload["reportedBy"] = claimed
        row = insert_event(conn, serial=serial, type=EventType.SEAL_DEAD, ts=ts, actor_pubkey=None, actor_label=None,
                           tx_sig=None, status="reported", seal_uid_hash=seal_uid_hash, payload=payload,
                           grade_after=Grade.VOID if p["void"] else p["grade"], country=loc.country, city=loc.city)
        return event_view(row)


def _confirm_event(event_id: int, tx_sig: str | None, actor: str | None, conn, settings: Settings, rpc):
    """
    {eventId, txSig, actor?}: confirm a pending event (normally a SCAN from /api/verify) with its transaction.
    A confirmed event never changes again: the same txSig again is an idempotent 200, a different one 409.
    """
    ev = get_event(conn, event_id)
    if not ev:
        raise HTTPException(404, "event not found")
    if ev["status"] == "confirmed":
        if tx_sig and ev["tx_sig"] == tx_sig:
            return event_view(ev)
        if not (tx_sig and ev["tx_sig"] is None):
            raise HTTPException(409, "event_confirmed")
        # confirmed by the reconcile job without a signature (lookup failed): the client's tx may fill it in once
        # verified; status and side effects stay as they are
    if not tx_sig:
        raise HTTPException(422, "txSig is required to confirm an event")
    etype = int(ev["type"])
    if etype not in txverify.FLACON_IX and etype not in txverify.ESCROW_IX:
        raise HTTPException(422, "event type cannot be confirmed")
    actor = actor or ev["actor_pubkey"]
    if not actor:
        raise HTTPException(422, "actor is required to confirm this event")
    if ev["actor_pubkey"] and actor != ev["actor_pubkey"]:
        raise HTTPException(403, "tx_mismatch")      # the scan was requested for another attester
    counter = json.loads(ev["payload_json"] or "{}").get("counter") if etype == EventType.SCAN else None
    exp = _expectation(conn, settings, etype, ev["serial"], seal_uid_hash=ev["seal_uid_hash"], scan_counter=counter)
    try:
        vt = txverify.verify_transaction(rpc, tx_sig, actor, exp)
    except txverify.TxRejected as exc:
        log.info("events: confirm %s with tx %s… rejected (%s) %s", event_id, tx_sig[:12], exc.detail, exc.reason)
        if exc.detail == "tx_failed" and etype == EventType.SCAN:
            with transaction(conn):
                conn.execute("UPDATE events SET status='failed', tx_sig=? WHERE id=? AND status='pending'", (tx_sig, event_id))
        raise HTTPException(exc.status, exc.detail) from exc

    ts = now()
    with transaction(conn):
        cur = get_event(conn, event_id)
        if cur["status"] == "confirmed":            # already confirmed (reconcile job / a parallel request)
            if cur["tx_sig"] is None:
                conn.execute("UPDATE events SET tx_sig=? WHERE id=? AND tx_sig IS NULL", (tx_sig, event_id))
            elif cur["tx_sig"] != tx_sig:
                raise HTTPException(409, "event_confirmed")
            return event_view(get_event(conn, event_id))  # type: ignore[arg-type]
        conn.execute("UPDATE events SET status='confirmed', tx_sig=?, actor_pubkey=? WHERE id=?", (tx_sig, actor, event_id))
        if etype == EventType.SCAN:
            apply_confirmed_scan(conn, get_event(conn, event_id), actor, ts)
        elif etype == EventType.SEAL_DEAD:
            seal_uid_hash = cur["seal_uid_hash"] or _seal_in_tx(conn, settings, cur["serial"], vt)
            _apply_seal_dead(conn, cur["serial"], seal_uid_hash)
            conn.execute("UPDATE events SET grade_after=?, seal_uid_hash=? WHERE id=?", (Grade.VOID, seal_uid_hash, event_id))
    if etype == EventType.SCAN:
        # bundle → ar_bundle, media preview → ar_media (sidecar subprocess; no-op when disabled) — after the commit
        arweave.archive_scan_event(conn, settings, get_event(conn, event_id))
    return event_view(get_event(conn, event_id))  # type: ignore[arg-type]


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
