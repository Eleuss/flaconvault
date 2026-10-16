"""/health, /api/session, /api/preview, /api/verify, /api/media, /api/events, /api/passport(s), /api/attester."""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from fv import arweave, media_store, proof, txverify
from fv.chain import RpcError, pda_passport, pda_scan, pda_seal
from fv.config import Settings
from fv.db import (ORDER_DISPUTE, ORDER_RELEASED, consume_nonce, event_actors, find_event, get_attester, get_event, get_media,
                   get_nonce, get_passport, get_seal_by_hash, get_seal_by_uid, insert_event, insert_nonce, insert_tap_random_id,
                   list_passports_confirmed, mark_seal_dead, now, open_seal_dead_report, purge_nonces, record_escrow_outcome,
                   reserve_nonce_media, seals_for, set_event_resume_hash, update_event_payload, upsert_attester,
                   upsert_passport, upsert_seal, void_passport, transaction)
from fv.deps import get_conn, get_rpc, get_settings
from fv.enums import (EventType, Grade, Indicator, NONCE_INVALID, NO_RESPONSE, Role, SEAL_KIND_NAMES, SealKind, Tamper, Tier,
                      VALID)
from fv.ratelimit import client_key, rate_limit, report_allowed
from fv.routes_chain import is_registry_partner, registry_partners
from fv.service import (adopt_tap, apply_confirmed_scan, authenticate_tap, check_tap, new_resume_token, token_matches)
from fv.strings import tap_message
from fv.views import attester_view, clean_text, event_view, passport_list_view, passport_metadata, passport_view, uid_tail

log = logging.getLogger("fv.api")
router = APIRouter()

Platform = Literal["ANDROID_WEB", "IOS_WEB", "DESKTOP_WEB", "SIMULATOR"]
MAX_ID = 2**63 - 1                     # SQLite INTEGER range: larger ids would be a 500 instead of a 404/422
SERIAL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")


def valid_serial(serial: str | None) -> bool:
    """Serial numbers are URL-safe by construction: they go into /p/<serial>, PDAs and the Core asset URI."""
    return bool(serial) and SERIAL_RE.match(serial) is not None


# ---------- models ----------

class Indicators(BaseModel):
    heat: int = Field(ge=0, le=3)
    humidity: int = Field(ge=0, le=3)
    uv: int = Field(default=Indicator.MISSING, ge=0, le=3)


class Location(BaseModel):
    """Where a scan was made, as the scanner states it (only SCANs from /api/verify keep a location)."""
    country: str | None = Field(default=None, max_length=2)
    city: str | None = Field(default=None, max_length=80)

    @field_validator("country")
    @classmethod
    def _country(cls, v):
        return v.upper() if isinstance(v, str) and re.fullmatch(r"[A-Za-z]{2}", v) else None

    @field_validator("city")
    @classmethod
    def _city(cls, v):
        return clean_text(v, 80)            # printable, whitespace collapsed (no bidi overrides or control characters)


def _short_ctr(v):
    if isinstance(v, str) and len(v) > 16:
        raise ValueError("ctr too long")
    return v


class PreviewBody(BaseModel):
    uid: str | None = Field(default=None, max_length=64)
    ctr: str | int | None = None
    cmac: str = Field(max_length=64)
    piccData: str | None = Field(default=None, max_length=50)   # encrypted SUN: 16 (AES) / 24 (LRP) byte hex
    enc: str | None = Field(default=None, max_length=66)        # SDMENCFileData (TagTamper `/tagtt`), ≤ 32 bytes

    @field_validator("ctr")
    @classmethod
    def _ctr(cls, v):
        return _short_ctr(v)


class VerifyBody(BaseModel):
    """Extra fields are ignored — notably `tamper`: the server always signs tamper = UNKNOWN (non-TT NTAG 424 DNA)."""
    uid: str | None = Field(default=None, max_length=64)
    ctr: str | int | None = None
    cmac: str | None = Field(default=None, max_length=64)
    piccData: str | None = Field(default=None, max_length=50)
    enc: str | None = Field(default=None, max_length=66)
    nonce: str = Field(max_length=80)
    role: int = Field(ge=0, le=4)
    tier: int = Field(ge=0, le=4)
    indicators: Indicators
    heatLevels: list[int] = Field(min_length=6, max_length=6)
    fill: int = Field(ge=0, le=100)
    mediaHash: str | None = Field(default=None, max_length=80)
    serial: str | None = Field(default=None, max_length=64)
    location: Location | None = None
    attester: str | None = Field(default=None, min_length=32, max_length=44)
    platform: Platform = "SIMULATOR"
    tapId: int | None = Field(default=None, ge=1, le=MAX_ID)   # adopt a tap already consumed by /t (≤ 3 min, once) …
    tapToken: str | None = Field(default=None, max_length=64)  # … with the one-time token from the /t redirect (`k`)
    note: str = Field(default="", max_length=280)

    @field_validator("ctr")
    @classmethod
    def _ctr(cls, v):
        return _short_ctr(v)

    @field_validator("heatLevels")
    @classmethod
    def _bits(cls, v: list[int]) -> list[int]:
        if any(x not in (0, 1) for x in v):
            raise ValueError("heatLevels entries must be 0/1")
        return v


class EventBody(BaseModel):
    eventId: int | None = Field(default=None, ge=1, le=MAX_ID)
    serial: str | None = Field(default=None, max_length=64)
    type: int | str | None = None
    txSig: str | None = Field(default=None, max_length=128)
    sealUidHash: str | None = Field(default=None, max_length=66)
    actor: str | None = Field(default=None, max_length=64)
    actorLabel: str | None = Field(default=None, max_length=120)   # ignored: labels come from the server's records only
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: int | None = None            # ignored: the server uses the tx blockTime (else now)
    location: Location | None = None
    status: Literal["pending", "confirmed", "failed"] | None = None   # ignored: the server decides the status
    nonce: str | None = Field(default=None, max_length=80)   # SEAL_DEAD report without txSig: an unused session nonce


# ---------- health / session ----------

@router.get("/health")
def health(settings: Settings = Depends(get_settings)):
    return {"ok": True, "keyId": settings.server_key_id, "pubkeyHex": proof.public_key(settings.server_seed).hex(),
            "simulator": settings.dev_simulator, "programId": settings.program_id or None,
            "build": getattr(settings, "build_sha", "") or None, "arweave": arweave.health(settings)}


@router.post("/api/session", dependencies=[Depends(rate_limit)])
def session(conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    ts = now()
    nonce = os.urandom(32).hex()
    with transaction(conn):
        insert_nonce(conn, nonce, ts, ts + settings.nonce_ttl_s)
        purge_nonces(conn, ts)
    media_store.maybe_purge(conn, settings, ts)     # staged uploads of expired / consumed nonces
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


@router.post("/api/preview", dependencies=[Depends(rate_limit)])
def preview(body: PreviewBody, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    chk = check_tap(conn, settings, body.uid, body.ctr, body.cmac, consume=False, picc_data=body.piccData, enc=body.enc)
    out = _tap_fields(chk)
    if chk.verdict == VALID and chk.seal_dead:
        out["verdict"] = NO_RESPONSE
    out["message"] = tap_message(out["verdict"], chk.counter)
    return out


def _signed_response(conn, settings: Settings, ev: dict) -> dict:
    """The VALID /api/verify response, rebuilt from the pending SCAN event (also served by the resume link)."""
    p = json.loads(ev["payload_json"] or "{}")
    seal = get_seal_by_hash(conn, ev["seal_uid_hash"]) if ev["seal_uid_hash"] else None
    server = p.get("server") or {}
    counter = p.get("counter")
    return {
        "verdict": VALID, "counter": counter, "uid": seal["uid_hex"] if seal else None,
        "serial": ev["serial"], "serialHash": p.get("serialHash"), "uidHash": p.get("uidHash"),
        "sealKind": seal["kind"] if seal else None, "sealDead": bool(seal["dead"]) if seal else None,
        "grade": p.get("grade"), "reviewRecommended": bool(p.get("reviewRecommended", False)),
        "message": tap_message(VALID, counter),
        "heatMask": proof.heat_levels_to_mask(p["heatLevels"]), "serverSig": server.get("sig"),
        "serverPubkey": proof.public_key(settings.server_seed).hex(), "keyId": server.get("keyId"), "ts": server.get("ts"),
        "msgHex": p.get("msgHex"), "bundle": proof.bundle_from_payload(p), "bundleHash": p.get("bundleHash"),
        "eventId": ev["id"],
    }


def _needs_partner(tier: int, role: int) -> bool:
    """Mirrors record_scan: tier ≥ CERTIFIED or a VAULT/PARTNER role needs a registry partner as attester."""
    return tier >= Tier.CERTIFIED or role in (Role.VAULT, Role.PARTNER)


@router.post("/api/verify", dependencies=[Depends(rate_limit)])
def verify(body: VerifyBody, request: Request, conn=Depends(get_conn), settings: Settings = Depends(get_settings),
           rpc=Depends(get_rpc)):
    """
    Sign a genuine, fresh tap (or adopt one /t consumed) as a pending SCAN. Contract notes (C1 / M4):
      * a certified scan (tier ≥ 3, or role VAULT / PARTNER) is only signed for an `attester` that is a registry
        partner — the claim must be sent here, also when the scan will be anchored later from another browser via the
        resume link (e.g. iPhone Safari without a wallet: the partner's wallet address has to be entered); otherwise
        403 not_partner, and the tap is not consumed;
      * the claimed attester is the only wallet whose record_scan confirms the scan (and the only one whose failed tx
        marks it failed); a scan without a claimed attester is confirmed by whichever wallet anchors the signature;
      * VALID answers carry `resumeToken` (GET /api/verify/{eventId}?token=… while pending); a dead seal answers
        NO_RESPONSE without a signature;
      * the media upload staged under `nonce` with this mediaHash is kept, everything else staged under it is deleted.
    """
    ts = now()
    pub_hex = proof.public_key(settings.server_seed).hex()
    heat_mask = proof.heat_levels_to_mask(body.heatLevels)
    base = {"heatMask": heat_mask, "serverSig": None, "serverPubkey": pub_hex, "keyId": settings.server_key_id,
            "ts": ts, "msgHex": None, "bundle": None, "bundleHash": None, "eventId": None, "reviewRecommended": False}
    if body.attester and not txverify.is_pubkey(body.attester):
        raise HTTPException(422, "attester must be a base58 pubkey")
    if body.serial is not None and not valid_serial(body.serial):
        raise HTTPException(422, "invalid serial")
    # A certified tier or a professional role is only signed for a registry partner (the program refuses anything else
    # on chain; refusing it here keeps an unsigned claim from ever reading as a partner's certification).
    if _needs_partner(body.tier, body.role) and not is_registry_partner(request, conn, settings, rpc, body.attester):
        raise HTTPException(403, "not_partner")

    # heat consistency: indicators.heat ∈ {0,1} must equal heatLevels[4]; 2/3 are trusted as sent.
    heat = body.indicators.heat
    if heat in (Indicator.INTACT, Indicator.TRIGGERED) and heat != body.heatLevels[proof.HEAT_DECISIVE_INDEX]:
        raise HTTPException(422, "indicators.heat must equal heatLevels[4] (the 40 °C field)")
    # tamper: NTAG 424 DNA (non-TT) has no tamper loop — never taken from the client (uv: read from the card, Rev C)
    hum, uv, tamper = body.indicators.humidity, body.indicators.uv, Tamper.UNKNOWN
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
    # CMAC / decryption before the write transaction (key derivation is slow; the lock must not wait for it)
    auth = None if body.tapId is not None else authenticate_tap(settings, body.uid, body.ctr, body.cmac,
                                                                picc_data=body.piccData, enc=body.enc)

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
            chk = check_tap(conn, settings, body.uid, body.ctr, body.cmac, consume=True, auth=auth)
        verdict = chk.verdict
        if verdict == VALID and chk.seal_dead:
            verdict = NO_RESPONSE
        if verdict == VALID and body.serial and body.serial != chk.serial:
            raise HTTPException(409, f"serial mismatch: tag belongs to {chk.serial}")
        message = tap_message(verdict, chk.counter)
        if chk.uid_hex:
            insert_tap_random_id(conn, ts=ts, source="verify", uid_hex=chk.uid_hex, ctr=chk.counter, cmac=chk.cmac_hex,
                                 verdict=verdict, serial=chk.serial, message=message)
        grade, review = proof.compute_grade(verdict=verdict, tamper=tamper, heat=heat, hum=hum, fill=body.fill,
                                            seal_dead=chk.seal_dead)
        out = {**base, **_tap_fields(chk), "verdict": verdict, "grade": grade, "reviewRecommended": review, "message": message}
        if verdict != VALID:
            return out

        # 6. message, signature, nonce consumed, SCAN(pending) event
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
        b_hash = proof.bundle_hash(proof.canonical_json(bundle))
        consume_nonce(conn, nonce_b.hex(), ts)
        # the upload this scan commits to leaves staging; anything else staged under the nonce is deleted
        if body.tier >= 2:
            media_store.promote(conn, settings, nonce_b.hex(), media_hash.hex(), ts)
        else:
            media_store.discard(settings, nonce_b.hex())
        payload = {**bundle, "grade": grade, "reviewRecommended": review, "msgHex": msg.hex(), "bundleHash": proof.hex0x(b_hash)}
        # SCAN(pending): the claimed attester lives only in the signed bundle — actor and label stay empty, and passport
        # grade, stats and attester rows change only once the scan is confirmed on chain (POST /api/events with the
        # record_scan tx, or the reconcile job) — see service.apply_confirmed_scan.
        ev = insert_event(conn, serial=serial, type=EventType.SCAN, ts=ts, actor_pubkey=None, actor_label=None,
                          tx_sig=None, status="pending", seal_uid_hash=seal["uid_hash"], payload=payload, grade_after=grade,
                          country=loc.country, city=loc.city)
        token, token_hash = new_resume_token()
        set_event_resume_hash(conn, ev["id"], token_hash)
        return {**out, **_signed_response(conn, settings, ev), "resumeToken": token}


@router.get("/api/verify/{event_id}", dependencies=[Depends(rate_limit)])
def resume_verify(event_id: int = Path(ge=1, le=MAX_ID), token: str | None = Query(default=None, max_length=64),
                  conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    """
    The signed scan again (same JSON as the VALID /api/verify answer) for the holder of its one-time resume token —
    e.g. inside a wallet app's browser on iPhone — while the scan is still pending. Anything else is 404.
    """
    ev = get_event(conn, event_id)
    ok = token_matches(token, (ev or {}).get("resume_hash"))   # always compared (constant time), even for unknown ids
    if not ev or not ok or ev["status"] != "pending" or int(ev["type"]) != EventType.SCAN:
        raise HTTPException(404, "resume_not_found")
    return _signed_response(conn, settings, ev)


# ---------- media ----------

MEDIA_MAX_FILES = 6                                   # per upload and per session nonce
MEDIA_MAX_BYTES = 8 * 1024 * 1024                     # per file
MEDIA_MAX_BODY = MEDIA_MAX_FILES * MEDIA_MAX_BYTES + 256 * 1024   # whole multipart body, checked before parsing
MEDIA_TYPES = media_store.MEDIA_TYPES                 # content type → stored preview extension


def _media_nonce(raw) -> str:
    if not isinstance(raw, str):
        raise HTTPException(403, "media_nonce_invalid")
    try:
        return proof.parse_hex(raw, 32, "nonce").hex()
    except ValueError as exc:
        raise HTTPException(403, "media_nonce_invalid") from exc


@router.post("/api/media", dependencies=[Depends(rate_limit)])
async def media(request: Request, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    """
    Seal frames of a scan: multipart `file`/`files` (≤ 6, ≤ 8 MB each, image/jpeg|png|webp) plus `nonce`, the current
    session nonce (unexpired, not yet used by /api/verify; at most 6 files per nonce). The body size is checked from
    Content-Length before anything is read, together with the free space and the byte budgets (fv.media_store: 507
    storage_full · 429 media_limited · 503 media_busy). The upload is only *staged* under its nonce: it is kept when a
    VALID /api/verify consumes that nonce with this mediaHash, and deleted otherwise once the nonce has expired. Nothing
    is archived to Arweave here (that happens when the scan is confirmed).
    """
    cl = request.headers.get("content-length")
    if cl is None or not cl.isdigit():
        raise HTTPException(411, "Content-Length required")
    if int(cl) > MEDIA_MAX_BODY:
        raise HTTPException(413, f"upload too large (at most {MEDIA_MAX_FILES} × {MEDIA_MAX_BYTES // (1024 * 1024)} MB)")
    media_store.check_budget(request, settings, int(cl))
    try:
        form = await request.form(max_files=MEDIA_MAX_FILES + 1, max_fields=8, max_part_size=4096)
    except StarletteHTTPException as exc:
        if "files" in str(exc.detail).lower():
            raise HTTPException(413, f"at most {MEDIA_MAX_FILES} files per upload") from exc
        raise HTTPException(400, str(exc.detail)) from exc
    nonce_hex = _media_nonce(form.get("nonce"))
    ts = now()
    n = await run_in_threadpool(get_nonce, conn, nonce_hex)
    if not n or n["used_at"] is not None or n["expires_at"] < ts:
        raise HTTPException(403, "media_nonce_invalid")
    await run_in_threadpool(media_store.maybe_purge, conn, settings, ts)
    uploads = [u for u in (*form.getlist("file"), *form.getlist("files")) if isinstance(u, UploadFile)]
    if not uploads:
        raise HTTPException(422, "no file(s) uploaded (multipart field 'file' or 'files')")
    if len(uploads) > MEDIA_MAX_FILES:
        raise HTTPException(413, f"at most {MEDIA_MAX_FILES} files per upload")
    types = [(up.content_type or "").split(";")[0].strip().lower() for up in uploads]
    if any(t not in MEDIA_TYPES for t in types):
        raise HTTPException(415, "only image/jpeg, image/png and image/webp are accepted")
    content_type = types[0]                 # whitelisted above — never the raw client string
    try:
        staged = await run_in_threadpool(media_store.stage, settings, nonce_hex, uploads, MEDIA_MAX_BYTES)
    except media_store.FileTooLarge as exc:
        raise HTTPException(413, f"each file must be at most {MEDIA_MAX_BYTES // (1024 * 1024)} MB") from exc

    def _reserve() -> str:
        with transaction(conn):
            return reserve_nonce_media(conn, nonce_hex, len(uploads), MEDIA_MAX_FILES, ts)

    budget = await run_in_threadpool(_reserve)
    if budget != "ok":
        media_store.drop_part(staged)
        if budget == "full":
            raise HTTPException(413, f"at most {MEDIA_MAX_FILES} files per session")
        raise HTTPException(403, "media_nonce_invalid")
    await run_in_threadpool(media_store.finalize, settings, nonce_hex, staged, content_type)
    media_store.charge(request, staged["bytes"])
    digest = staged["sha256"]
    row = await run_in_threadpool(get_media, conn, digest)      # the same bytes kept (and maybe archived) by an earlier scan
    return {"sha256": "0x" + digest, "ar": row["ar"] if row else None, "url": row["url"] if row else None,
            "arPreview": row["ar_preview"] if row else None, "bytes": staged["bytes"], "files": len(uploads)}


# ---------- events ----------
#
# Contract (the web client depends on it):
#   new event   {serial, type, txSig, actor, payload?, sealUidHash?}   types MINT, SEAL_ATTACH, LIST…DISPUTE,
#               SEAL_DEAD with txSig — the tx is verified on chain, the event is stored `confirmed`, ts = blockTime.
#               Tx-backed facts (asset, binding hash, seal kind, price, counters, match, reason) come from the decoded
#               instruction, its accounts and the program's Anchor events; the client payload only supplies what the
#               chain cannot know (MINT brand/name/batch, SHIP carrier from a fixed list). The issuer label is the
#               server's record of the verified issuer, never a client choice. A MINT or SEAL_ATTACH that already
#               exists is returned as stored (a passport is never renamed); a tx that already backs an event of this
#               serial and type is answered from the DB before any RPC call.
#   confirm     {eventId, txSig, actor?}  (actor defaults to the scan's claimed attester) — a pending SCAN from
#               /api/verify; attester, tier, role and site are taken from the verified record_scan. A failed tx marks
#               the scan failed only when it is the claimed attester's own; anyone else's failed tx changes nothing.
#   report      {serial, type: SEAL_DEAD, nonce, sealUidHash?, payload?}  — no tx: stored `reported`, no effect; one open
#               report per seal and day, a small per-IP budget, fixed payload (source, note, uidTail, reportedBy).
#   errors      503 tx_not_visible (retry) · 422 tx_failed · 403 tx_mismatch · 403 not_issuer · 403 nonce_invalid ·
#               409 event_confirmed · 503 chain_not_configured · 429 rate_limited · 429 report_limited ·
#               503 busy (all tx lookup slots in use; Retry-After) · 404 passport/event/seal not found · 422 malformed.
# Client `ts`, `status`, `actorLabel` and `location` are ignored: a location belongs only to the scanner's own SCAN
# (/api/verify), so whoever posts a public transaction first cannot write text into the timeline.

MAX_PAYLOAD_BYTES = 16 * 1024
REPORT_WINDOW_S = 24 * 3600
REPORT_SOURCES = ("nfc", "manual", "simulator", "t")
# escrow DISPUTE_REASON_* (programs/escrow/src/constants.rs): TIMEOUT = the seller did not ship within the window
DISPUTE_REASONS = {0: "admin", 1: "not shipped within the deadline", 2: "Seal not responding", 3: "scans disagree"}
DISPUTE_REASON_MISMATCH = 3
# SHIP carrier: one of these (case-insensitive) or nothing — the first poster of a public ship tx picks no free text
CARRIERS = ("DHL", "DPD", "UPS", "GLS", "Hermes", "FedEx", "TNT", "Deutsche Post", "Österreichische Post", "Swiss Post",
            "PostNL", "bpost", "La Poste", "Colissimo", "Chronopost", "Poste Italiane", "Correos", "Royal Mail", "USPS",
            "Canada Post", "Japan Post", "Courier", "Hand delivery")
_CARRIER_BY_KEY = {c.casefold(): c for c in CARRIERS}
RESOLVED_TO_SELLER = "scans disagree · resolved by the escrow admin"
RESOLVED_TO_BUYER = "scans disagree · refunded by the escrow admin"
RELEASED_AFTER_TIMEOUT = "no receipt scan within the deadline"
USDC_DECIMALS = 6


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
        seal = scan = None
        if seal_uid_hash:
            seal_pda = pda_seal(pid, bytes.fromhex(seal_uid_hash))
            seal = str(seal_pda)
            if etype == EventType.SCAN and scan_counter is not None:
                scan = str(pda_scan(pid, seal_pda, int(scan_counter)))
        return txverify.Expectation(program=pid, instructions=txverify.FLACON_IX[etype], passport=passport_pda,
                                    seal=seal, scan=scan)
    if not settings.escrow_program_id:
        raise HTTPException(503, "chain_not_configured")
    sellers = tuple(event_actors(conn, serial, EventType.LIST))
    to_seller = True if etype == EventType.RELEASE else False if etype == EventType.DISPUTE else None
    return txverify.Expectation(program=settings.escrow_program_id, instructions=txverify.ESCROW_IX[etype],
                                passport=passport_pda, escrow=True, known_sellers=sellers, resolve_to_seller=to_seller)


def _verify_tx(rpc, tx_sig: str, actor: str, exp: txverify.Expectation, client: str | None = None) -> txverify.VerifiedTx:
    try:
        return txverify.verify_transaction(rpc, tx_sig, actor, exp, client=client)
    except txverify.TxRejected as exc:
        log.info("events: tx %s… rejected (%s) %s", tx_sig[:12], exc.detail, exc.reason)
        raise HTTPException(exc.status, exc.detail, headers=exc.headers) from exc


def _check_issuer(conn, serial: str, passport: dict | None, actor: str) -> None:
    """Once a MINT exists for the serial, only its issuer gets an answer (the stored event); anyone else is refused."""
    if find_event(conn, serial, EventType.MINT) and not (passport and passport["issuer"] and passport["issuer"] == actor):
        raise HTTPException(403, "not_issuer")


def _actor_label(conn, actor: str, ts: int) -> str | None:
    """The label the server has on record for this wallet (seed / operator); client-sent labels are never stored."""
    a = get_attester(conn, actor)
    upsert_attester(conn, pubkey=actor, first_seen=ts)
    return a["label"] if a and a["label"] else None


def _settle_existing(conn, existing: dict, payload: dict, tx_sig: str, actor: str) -> dict:
    """Idempotent MINT / SEAL_ATTACH: a confirmed event is never changed again; an old pending one gets confirmed."""
    if existing["status"] == "confirmed":
        return existing
    merged = {**json.loads(existing["payload_json"] or "{}"), **payload}
    merged.pop("uid", None)
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


_text = clean_text                         # a short, printable client string (or None)


def _carrier(v) -> str | None:
    return _CARRIER_BY_KEY.get(" ".join(v.split()).casefold()) if isinstance(v, str) else None


def _usdc(base_units: int | None) -> int | float | None:
    if base_units is None:
        return None
    whole, frac = divmod(int(base_units), 10 ** USDC_DECIMALS)
    return whole if frac == 0 else base_units / 10 ** USDC_DECIMALS


SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"      # also Pubkey::default()


def _scan_counter_at(rpc, address: str | None) -> int | None:
    if not address or address == SYSTEM_PROGRAM_ID:
        return None
    try:
        sp = txverify.decode_scan_proof_checked(rpc.get_account_info(address))
    except RpcError as exc:
        log.warning("ScanProof %s… not readable: %s", address[:8], exc)
        return None
    return sp["counter"] if sp else None


def _tx_payload(etype: int, vt: txverify.VerifiedTx, client: dict, *, serial: str, rpc) -> dict:
    """
    The stored payload of a tx-backed event: chain facts from the verified instruction (args, accounts, Anchor events,
    Order account) plus the few client fields the chain cannot know. Raises 403 tx_mismatch if the args contradict the
    event. Runs outside the DB transaction (SHIP reads one more account).
    """
    args = vt.args or {}
    order = vt.order or {}
    if etype == EventType.MINT:
        if args.get("serialHash") != proof.serial_hash(serial).hex():
            raise HTTPException(403, "tx_mismatch")
        core_asset = vt.account("core_asset")     # programs since the Core-asset check: account 4 = the asset arg
        if core_asset is not None and core_asset != args.get("asset"):
            raise HTTPException(403, "tx_mismatch")
        # no siteId / issuerLabel: registry sites are not bound to partners, so a client-picked site would let any
        # poster label the passport with a shop's name; the issuer label is the server's record of the verified issuer
        out: dict[str, Any] = {"brand": _text(client.get("brand"), 200), "name": _text(client.get("name"), 200),
                               "batch": _text(client.get("batch"), 200), "asset": args.get("asset"),
                               "bindingHash": "0x" + args["bindingHash"] if args.get("bindingHash") else None}
        return {k: v for k, v in out.items() if v is not None}
    if etype == EventType.SEAL_ATTACH:
        return {"kind": args.get("kind")}
    if etype == EventType.SEAL_DEAD:
        return {}
    base = {"order": vt.order_address, "currency": "USDC"}
    if etype == EventType.LIST:
        ev = vt.event("OrderListed") or {}
        price = ev.get("price") or args.get("price")          # list(price) requires price > 0
        return {**base, "price": price, "priceUsdc": _usdc(price), "seller": vt.actor}
    if etype == EventType.RESERVE:
        ev = vt.event("OrderReserved") or {}
        price = ev.get("price") or args.get("expectedPrice") or order.get("price")
        return {**base, "price": price, "priceUsdc": _usdc(price), "buyer": ev.get("buyer", vt.actor)}
    if etype == EventType.SHIP:
        return {"order": vt.order_address, "carrier": _carrier(client.get("carrier")),
                "preShipScanCounter": _scan_counter_at(rpc, order.get("sellerScan"))}
    if etype == EventType.RECEIVE:
        ev = vt.event("ReceiptScanRecorded")
        buyer_scan = txverify.decode_scan_proof_checked(vt.account_data.get(vt.account("scan") or ""))
        seller_scan = txverify.decode_scan_proof_checked(vt.account_data.get(vt.account("seller_scan") or ""))
        out = {"order": vt.order_address, "preShipScanCounter": seller_scan["counter"] if seller_scan else None}
        if ev:
            out.update(receiptScanCounter=ev["counter"], match=ev["matched"], fillDelta=abs(ev["buyerFill"] - ev["sellerFill"]))
        elif buyer_scan and seller_scan:          # the program's rule (escrow scans.rs), from the two ScanProofs
            fill_delta = abs(buyer_scan["fill"] - seller_scan["fill"])
            out.update(receiptScanCounter=buyer_scan["counter"], fillDelta=fill_delta,
                       match=buyer_scan["heat"] == seller_scan["heat"] and buyer_scan["hum"] == seller_scan["hum"] and fill_delta <= 5)
        else:
            out.update(receiptScanCounter=buyer_scan["counter"] if buyer_scan else None, match=None, fillDelta=None)
        return out
    if etype == EventType.RELEASE:
        if vt.name == "resolve":                  # admin settled a MISMATCH order for the seller (OrderResolved)
            rv = vt.event("OrderResolved") or {}
            amount = rv.get("amount") or order.get("price")
            out = {**base, "price": amount, "priceUsdc": _usdc(amount), "to": order.get("seller") or vt.account("seller"),
                   "reason": RESOLVED_TO_SELLER}
            if rv.get("assetTransferred"):
                out["passportTo"] = order.get("buyer") or vt.account("buyer")
            return out
        ev = vt.event("OrderReleased") or {}
        amount = ev.get("amount") or order.get("price")
        out = {**base, "price": amount, "priceUsdc": _usdc(amount), "to": ev.get("seller") or order.get("seller")}
        if vt.name == "release_after_timeout":
            out["reason"] = RELEASED_AFTER_TIMEOUT
        if ev.get("assetTransferred"):
            out["passportTo"] = ev.get("buyer")
        return out
    if etype == EventType.DISPUTE:
        if vt.name == "resolve":                  # admin refunded the buyer of a MISMATCH order (OrderResolved)
            rv = vt.event("OrderResolved") or {}
            return {**base, "reason": RESOLVED_TO_BUYER, "reasonCode": DISPUTE_REASON_MISMATCH,
                    "refunded": rv.get("amount"), "refundedUsdc": _usdc(rv.get("amount"))}
        ev = vt.event("OrderDisputed") or {}
        code = ev.get("reason")
        return {**base, "reason": DISPUTE_REASONS.get(code) if code is not None else None, "reasonCode": code,
                "refunded": ev.get("refunded"), "refundedUsdc": _usdc(ev.get("refunded"))}
    return {}


def _escrow_seller(vt: txverify.VerifiedTx) -> str | None:
    ev = vt.event("OrderReleased") or {}
    return ev.get("seller") or (vt.order or {}).get("seller") or vt.account("seller")


def _record_escrow_outcome(conn, etype: int, vt: txverify.VerifiedTx, passport_pda: str, payload: dict, ts: int) -> None:
    """A confirmed RELEASE / DISPUTE → the final state of its listing (escrow_orders: one source for the counters)."""
    if not vt.order_address:
        return
    ev = vt.event("OrderReleased") or {}
    order = dict(vt.order) if vt.order else None
    if order and order.get("buyer") == SYSTEM_PROGRAM_ID:      # Pubkey::default() until reserved
        order["buyer"] = None
    record_escrow_outcome(conn, vt.order_address, state=ORDER_RELEASED if etype == EventType.RELEASE else ORDER_DISPUTE,
                          at=vt.block_time, ts=ts, order=order, passport=passport_pda, seller=_escrow_seller(vt),
                          buyer=ev.get("buyer") or vt.account("buyer"),
                          price=payload.get("price") or payload.get("refunded"))


@router.post("/api/events", dependencies=[Depends(rate_limit)])
def events(body: EventBody, request: Request, conn=Depends(get_conn), settings: Settings = Depends(get_settings),
           rpc=Depends(get_rpc)):
    tx_sig = (body.txSig or "").strip() or None
    actor = (body.actor or "").strip() or None
    if actor and not txverify.is_pubkey(actor):
        raise HTTPException(422, "actor must be a base58 pubkey")
    if tx_sig and not txverify.is_signature(tx_sig):
        raise HTTPException(422, "txSig must be a base58 transaction signature (64 bytes)")
    if body.eventId is not None:
        return _confirm_event(body.eventId, tx_sig, actor, conn, settings, rpc, client=client_key(request))

    if not body.serial or body.type is None:
        raise HTTPException(422, "serial and type are required for a new event")
    serial = body.serial
    if not valid_serial(serial):
        raise HTTPException(422, "invalid serial (3–64 characters: letters, digits, '.', '_', '-')")
    etype = _event_type(body.type)
    client = dict(body.payload)
    if len(json.dumps(client, ensure_ascii=False)) > MAX_PAYLOAD_BYTES:
        raise HTTPException(413, "payload too large")
    seal_uid_hash = _hash_arg(body.sealUidHash, "sealUidHash") if body.sealUidHash else None

    if etype == EventType.SCAN:
        raise HTTPException(422, "SCAN events come from /api/verify; confirm them with {eventId, txSig, actor}")
    if etype == EventType.SEAL_DEAD and not tx_sig:
        return _report_seal_dead(request, body, conn, serial, client, seal_uid_hash)
    if not tx_sig or not actor:
        raise HTTPException(422, f"txSig and actor are required for {EventType.name(etype)}")

    # ---- cheap checks before any RPC (repeated under the write lock below) ----
    if etype not in (EventType.MINT, EventType.SEAL_ATTACH):
        dup = _event_for_tx(conn, tx_sig, serial, etype)
        if dup:
            return event_view(dup)              # a repeat (or a replay) of a known tx costs no RPC call
    passport = get_passport(conn, serial)
    uid_b = None
    if etype == EventType.MINT:
        for k in ("brand", "name", "batch"):
            if client.get(k) is not None and (not isinstance(client[k], str) or len(client[k]) > 200):
                raise HTTPException(422, f"payload.{k} must be a string (≤ 200 chars)")
        _check_issuer(conn, serial, passport, actor)
        existing = find_event(conn, serial, EventType.MINT)
        if existing and existing["status"] == "confirmed":
            return event_view(existing)          # a minted passport is never renamed or re-pointed
        if not passport and not (_text(client.get("brand"), 200) and _text(client.get("name"), 200)):
            raise HTTPException(422, "MINT for an unknown serial needs payload.brand and payload.name")
    elif not passport:
        raise HTTPException(404, "passport not found")
    if etype == EventType.SEAL_ATTACH:
        if not client.get("uid"):
            raise HTTPException(422, "SEAL_ATTACH needs payload.uid (7 bytes hex)")
        try:
            uid_b = proof.parse_hex(str(client["uid"]), 7, "uid")
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        seal_uid_hash = proof.uid_hash(uid_b).hex()
        other = get_seal_by_hash(conn, seal_uid_hash)
        if other and other["serial"] != serial:
            raise HTTPException(409, "seal is attached to another passport")
        existing = find_event(conn, serial, EventType.SEAL_ATTACH, seal_uid_hash)
        if existing and existing["status"] == "confirmed":
            return event_view(existing)          # an attached seal never changes kind or passport again
    if etype == EventType.SEAL_DEAD and seal_uid_hash:
        _seal_of_serial(conn, seal_uid_hash, serial)

    # ---- on-chain evidence (outside any DB transaction) ----
    exp = _expectation(conn, settings, etype, serial, seal_uid_hash=seal_uid_hash)
    vt = _verify_tx(rpc, tx_sig, actor, exp, client=client_key(request))
    ts = vt.block_time or now()
    payload = _tx_payload(etype, vt, client, serial=serial, rpc=rpc)

    with transaction(conn):
        if etype not in (EventType.MINT, EventType.SEAL_ATTACH):   # those two are idempotent per serial / seal below
            dup = _event_for_tx(conn, tx_sig, serial, etype)
            if dup:
                return event_view(dup)          # one transaction backs one event — a repeat is idempotent
        actor_label = _actor_label(conn, actor, ts)
        passport = get_passport(conn, serial)

        if etype == EventType.MINT:
            _check_issuer(conn, serial, passport, actor)
            existing = find_event(conn, serial, EventType.MINT)
            if existing and existing["status"] == "confirmed":
                return event_view(existing)
            if not passport and not (payload.get("brand") and payload.get("name")):
                raise HTTPException(422, "MINT for an unknown serial needs payload.brand and payload.name")
            passport = upsert_passport(conn, serial=serial, serial_hash=proof.serial_hash(serial).hex(),
                                       brand=payload.get("brand") or passport["brand"], name=payload.get("name") or passport["name"],
                                       batch=payload.get("batch") or (passport["batch"] if passport else None),
                                       asset=payload.get("asset"), issuer=actor,
                                       issuer_label=payload.get("issuerLabel") or actor_label, grade=Grade.A, void=False,
                                       created_at=ts)
            if existing:
                return event_view(_settle_existing(conn, existing, payload, tx_sig, actor))
        if not passport:
            raise HTTPException(404, "passport not found")

        if etype == EventType.SEAL_ATTACH:
            other = get_seal_by_hash(conn, seal_uid_hash)
            if other and other["serial"] != serial:
                raise HTTPException(409, "seal is attached to another passport")
            existing = find_event(conn, serial, EventType.SEAL_ATTACH, seal_uid_hash)
            if existing and existing["status"] == "confirmed":
                return event_view(existing)
            args = vt.args or {}
            kind = args.get("kind")
            if args.get("uidHash") != seal_uid_hash or kind not in SealKind.values():   # attach_seal: BOX or NECK only
                raise HTTPException(403, "tx_mismatch")
            uid_hex = uid_b.hex().upper()
            seal = upsert_seal(conn, uid_hash=seal_uid_hash, uid_hex=uid_hex, serial=serial, kind=kind, attached_at=ts)
            # only the hash and the last byte of the UID are ever published (the encrypted SUN mirror hides the UID)
            payload = {"uidHash": "0x" + seal["uid_hash"], "uidTail": uid_tail(uid_hex), "kind": kind,
                       "kindName": SEAL_KIND_NAMES[kind]}
            if existing:
                return event_view(_settle_existing(conn, existing, payload, tx_sig, actor))

        if etype == EventType.SEAL_DEAD:
            seal_uid_hash = seal_uid_hash or _seal_in_tx(conn, settings, serial, vt)
            _apply_seal_dead(conn, serial, seal_uid_hash)
        if etype in (EventType.RELEASE, EventType.DISPUTE):
            _record_escrow_outcome(conn, etype, vt, exp.passport, payload, ts)

        p = get_passport(conn, serial)
        grade_after = Grade.VOID if p["void"] else p["grade"]
        row = insert_event(conn, serial=serial, type=etype, ts=ts, actor_pubkey=actor, actor_label=actor_label,
                           tx_sig=tx_sig, status="confirmed", seal_uid_hash=seal_uid_hash, payload=payload,
                           grade_after=grade_after, country=None, city=None)
        return event_view(row)


def _event_for_tx(conn, tx_sig: str, serial: str, etype: int) -> dict | None:
    r = conn.execute("SELECT * FROM events WHERE tx_sig=? AND serial=? AND type=? ORDER BY id LIMIT 1",
                     (tx_sig, serial, etype)).fetchone()
    return dict(r) if r else None


def _seal_in_tx(conn, settings: Settings, serial: str, vt: txverify.VerifiedTx) -> str | None:
    """mark_seal_dead without sealUidHash: the seal of this passport at the instruction's seal position."""
    seal_pda = vt.account("seal")
    for s in seals_for(conn, serial):
        if seal_pda and str(pda_seal(settings.program_id, bytes.fromhex(s["uid_hash"]))) == seal_pda:
            return s["uid_hash"]
    return None


def _apply_seal_dead(conn, serial: str, seal_uid_hash: str | None) -> None:
    """Effect of a *verified* SEAL_DEAD (partner's mark_seal_dead tx): seal dead, passport void."""
    if seal_uid_hash:
        mark_seal_dead(conn, seal_uid_hash)
    void_passport(conn, serial, Grade.VOID)


def _report_payload(conn, serial: str, client: dict, claimed: str | None) -> tuple[dict, str | None]:
    """Fixed schema of an unverified report: source, note, uidTail, reportedBy (claimed, unverified); the seal it names."""
    source = client.get("source") if client.get("source") in REPORT_SOURCES else "manual"
    out: dict[str, Any] = {"source": source}
    note = _text(client.get("note"), 120)
    if note:
        out["note"] = note
    seal_hash = None
    uid = client.get("uid")
    if isinstance(uid, str) and re.fullmatch(r"(0x)?[0-9A-Fa-f]{14}", uid.strip()):
        uid_hex = proof.strip0x(uid.strip()).upper()
        out["uidTail"] = uid_tail(uid_hex)
        seal = get_seal_by_uid(conn, uid_hex)
        if seal and seal["serial"] == serial:
            seal_hash = seal["uid_hash"]
    if claimed and txverify.is_pubkey(claimed):
        out["reportedBy"] = claimed
    return out, seal_hash


def _report_seal_dead(request: Request, body: EventBody, conn, serial: str, client: dict, seal_uid_hash: str | None):
    """
    SEAL_DEAD without a transaction (a buyer reporting a non-responding seal): needs an unused session nonce
    (consumed), is stored as `reported` and changes nothing else — no void, no dead seal, no attester row. At most one
    open report per seal (or per passport, for a report naming no seal) within 24 h, and a small per-IP budget
    (429 report_limited). The payload has a fixed schema; the claimed reporter is kept in payload.reportedBy, unverified.
    A report never stores a location.
    """
    if not body.nonce:
        raise HTTPException(422, "a SEAL_DEAD report without txSig needs a session nonce (POST /api/session)")
    try:
        nonce_hex = proof.parse_hex(body.nonce, 32, "nonce").hex()
    except ValueError as exc:
        raise HTTPException(403, "nonce_invalid") from exc
    report_allowed(request)
    ts = now()
    with transaction(conn):
        p = get_passport(conn, serial)
        if not p:
            raise HTTPException(404, "passport not found")
        payload, named_seal = _report_payload(conn, serial, client, (body.actor or "").strip() or None)
        seal_uid_hash = seal_uid_hash or named_seal
        if seal_uid_hash:
            _seal_of_serial(conn, seal_uid_hash, serial)
        n = get_nonce(conn, nonce_hex)
        if not n or n["used_at"] is not None or n["expires_at"] < ts:
            raise HTTPException(403, "nonce_invalid")
        if open_seal_dead_report(conn, serial, seal_uid_hash, ts - REPORT_WINDOW_S):
            raise HTTPException(429, "report_limited")
        consume_nonce(conn, nonce_hex, ts)
        row = insert_event(conn, serial=serial, type=EventType.SEAL_DEAD, ts=ts, actor_pubkey=None, actor_label=None,
                           tx_sig=None, status="reported", seal_uid_hash=seal_uid_hash, payload=payload,
                           grade_after=Grade.VOID if p["void"] else p["grade"], country=None, city=None)
        return event_view(row)


def _scan_chain_values(vt: txverify.VerifiedTx, payload: dict) -> dict:
    """What record_scan wrote into the ScanProof (its args), plus the fields the program does not check against the bundle."""
    args = vt.args
    if args is None:
        return {}                                     # args not decodable: the claim is kept only for its own attester
    chain = {"tier": args.get("tier"), "role": args.get("role"), "siteId": args.get("siteId"), "source": "tx"}
    extra = []
    if args.get("bundleHash") is not None and proof.strip0x(payload.get("bundleHash") or "").lower() != args["bundleHash"]:
        extra.append("bundleHash")
    if args.get("heatLevels") is not None and payload.get("heatLevels") is not None \
            and proof.heat_levels_to_mask(payload["heatLevels"]) != args["heatLevels"]:
        extra.append("heatLevels")
    chain["mismatch"] = extra
    return chain


def _confirm_event(event_id: int, tx_sig: str | None, actor: str | None, conn, settings: Settings, rpc,
                   client: str | None = None):
    """
    {eventId, txSig, actor?}: confirm a pending event (normally a SCAN from /api/verify) with its transaction.
    A confirmed event never changes again: the same txSig again is an idempotent 200, a different one 409.
    A failed record_scan marks the scan failed only when it was signed by the scan's claimed attester: a scan without
    a claimed attester (e.g. started in a browser without a wallet, to be anchored via the resume link) stays pending
    whatever failing tx a stranger posts for its public PDAs — otherwise anyone could kill its resume link — and the
    reconcile job's timeout decides.
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
    payload = json.loads(ev["payload_json"] or "{}")
    claimed = (payload.get("attester") or {}).get("pubkey") if etype == EventType.SCAN else None
    expected_actor = ev["actor_pubkey"] or claimed
    actor = actor or expected_actor
    if not actor:
        raise HTTPException(422, "actor is required to confirm this event")
    if expected_actor and actor != expected_actor:
        raise HTTPException(403, "tx_mismatch")      # the scan was requested for another attester
    counter = payload.get("counter") if etype == EventType.SCAN else None
    exp = _expectation(conn, settings, etype, ev["serial"], seal_uid_hash=ev["seal_uid_hash"], scan_counter=counter)
    try:
        vt = txverify.verify_transaction(rpc, tx_sig, actor, exp, client=client)
    except txverify.TxRejected as exc:
        log.info("events: confirm %s with tx %s… rejected (%s) %s", event_id, tx_sig[:12], exc.detail, exc.reason)
        if exc.detail == "tx_failed" and etype == EventType.SCAN and expected_actor is not None and actor == expected_actor:
            with transaction(conn):
                conn.execute("UPDATE events SET status='failed', tx_sig=? WHERE id=? AND status='pending'", (tx_sig, event_id))
        raise HTTPException(exc.status, exc.detail, headers=exc.headers) from exc
    if etype == EventType.SCAN:
        args = vt.args
        if vt.account("signer") != actor or (args is not None and args.get("counter") != counter):
            raise HTTPException(403, "tx_mismatch")   # the attester is record_scan's signer account; same counter

    ts = now()
    with transaction(conn):
        cur = get_event(conn, event_id)
        if cur["status"] == "confirmed":            # already confirmed (reconcile job / a parallel request)
            if cur["tx_sig"] is None:
                conn.execute("UPDATE events SET tx_sig=? WHERE id=? AND tx_sig IS NULL", (tx_sig, event_id))
            elif cur["tx_sig"] != tx_sig:
                raise HTTPException(409, "event_confirmed")
            return event_view(get_event(conn, event_id))  # type: ignore[arg-type]
        conn.execute("UPDATE events SET status='confirmed', tx_sig=?, actor_pubkey=?, resume_hash=NULL WHERE id=?",
                     (tx_sig, actor, event_id))
        if etype == EventType.SCAN:
            upsert_attester(conn, pubkey=actor, first_seen=ts)
            apply_confirmed_scan(conn, get_event(conn, event_id), actor, ts, chain=_scan_chain_values(vt, payload))
        elif etype == EventType.SEAL_DEAD:
            seal_uid_hash = cur["seal_uid_hash"] or _seal_in_tx(conn, settings, cur["serial"], vt)
            _apply_seal_dead(conn, cur["serial"], seal_uid_hash)
            conn.execute("UPDATE events SET grade_after=?, seal_uid_hash=? WHERE id=?", (Grade.VOID, seal_uid_hash, event_id))
    # Arweave (media, then the bundle) is archived by the reconcile job's queue (arweave.backfill), never here: a confirm
    # request must not hold a worker thread for up to FV_ARWEAVE_TIMEOUT_S per sidecar call while Irys is slow or down
    return event_view(get_event(conn, event_id))  # type: ignore[arg-type]


# ---------- passports / attesters ----------

@router.get("/api/passport/{serial}")
def passport(serial: str, conn=Depends(get_conn)):
    v = passport_view(conn, serial) if valid_serial(serial) else None
    if not v:
        raise HTTPException(404, "passport not found")
    return v


@router.get("/api/passport/{serial}/metadata.json")
def passport_metadata_json(serial: str, conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    """Metadata JSON for the passport's Metaplex Core asset `uri`."""
    v = passport_metadata(conn, serial, settings.web_url) if valid_serial(serial) else None
    if not v:
        raise HTTPException(404, "passport not found")
    return v


@router.get("/api/passports")
def passports(conn=Depends(get_conn)):
    return passport_list_view(list_passports_confirmed(conn))


@router.get("/api/attester/{pubkey}")
def attester(pubkey: str, request: Request, conn=Depends(get_conn), settings: Settings = Depends(get_settings),
             rpc=Depends(get_rpc)):
    a = get_attester(conn, pubkey) if txverify.is_pubkey(pubkey) else None
    if not a:
        raise HTTPException(404, "attester not found")
    return attester_view(conn, a, partners=registry_partners(request, conn, settings, rpc))
