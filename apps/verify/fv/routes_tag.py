"""GET /t — real tag landing (SUN URL). GET /api/tap/<id> — stored tap for the web /t page."""
from __future__ import annotations

import re
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import JSONResponse, RedirectResponse

from fv.config import Settings
from fv.db import get_seal_by_uid, get_tap, insert_event, insert_tap_random_id, now, purge_invalid_taps, transaction
from fv.deps import get_conn, get_settings
from fv.enums import EventType, INVALID, NO_RESPONSE, VALID
from fv.ratelimit import rate_limit
from fv.service import authenticate_tap, check_tap, new_adopt_token
from fv.strings import tap_message
from fv.views import tap_view

router = APIRouter()

MAX_ID = 2**63 - 1
_UID_HEX = re.compile(r"^[0-9A-Fa-f]{14}$")
INVALID_TAP_RETENTION_S = 24 * 3600
PURGE_EVERY_S = 600.0
_purge_lock = threading.Lock()
_last_purge = [0.0]


def _wants_json(request: Request) -> bool:
    if request.query_params.get("format") == "json":
        return True
    accept = request.headers.get("accept", "")
    return "application/json" in accept and "text/html" not in accept.split(",")[0]


def _maybe_purge(conn, ts: int) -> None:
    with _purge_lock:
        if time.monotonic() - _last_purge[0] < PURGE_EVERY_S:
            return
        _last_purge[0] = time.monotonic()
    purge_invalid_taps(conn, ts - INVALID_TAP_RETENTION_S)


@router.get("/t", dependencies=[Depends(rate_limit)])
def tag_landing(request: Request, uid: str | None = None, ctr: str | None = None, cmac: str | None = None,
                picc_data: str | None = None, enc: str | None = None,
                conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    """
    Plain mirror: ?uid&ctr&cmac — encrypted SUN (NFC Developer App / sdm-backend `/tag`, `/tagtt`): ?picc_data&cmac[&enc].
    A genuine tap of a dead seal answers NO_RESPONSE (no adoption token, no sighting). A request without a parsable
    chip UID is not stored at all (it redirects to the plain web /t page).
    """
    ts = now()
    token = None
    auth = authenticate_tap(settings, uid, ctr, cmac, picc_data=picc_data, enc=enc)   # crypto outside the write lock
    with transaction(conn):
        chk = check_tap(conn, settings, uid, ctr, cmac, consume=True, auth=auth)
        verdict = chk.verdict
        if verdict == VALID and chk.seal_dead:
            verdict = NO_RESPONSE                      # a voided chip (e.g. moved onto another bottle) never reads genuine
        message = tap_message(verdict, chk.counter)
        if verdict == INVALID and not (chk.uid_hex and _UID_HEX.match(chk.uid_hex)):
            tap = None                                 # nothing to show and no replay state: not persisted
        else:
            adopt_hash = None
            if verdict == VALID:
                # one-time capability for /api/verify to adopt this tap (only its sha256 is stored)
                token, adopt_hash = new_adopt_token()
            tap = insert_tap_random_id(conn, ts=ts, source="t", uid_hex=chk.uid_hex, ctr=chk.counter, cmac=chk.cmac_hex,
                                       verdict=verdict, serial=chk.serial, message=message, adopt_hash=adopt_hash)
        if verdict == VALID and chk.seal and tap:
            # Tier-0 sighting: off-chain only, nothing pending on chain.
            p = conn.execute("SELECT grade, void FROM passports WHERE serial=?", (chk.serial,)).fetchone()
            insert_event(conn, serial=chk.serial, type=EventType.SCAN, ts=ts, actor_pubkey=None, actor_label=None,
                         tx_sig=None, status="confirmed", seal_uid_hash=chk.seal["uid_hash"],
                         payload={"tier": 0, "verdict": VALID, "counter": chk.counter, "tapId": tap["id"]},
                         grade_after=(4 if p and p["void"] else (p["grade"] if p else None)), country=None, city=None)
        _maybe_purge(conn, ts)
    if _wants_json(request):
        if tap is None:
            return JSONResponse({"tapId": None, "ts": ts, "verdict": INVALID, "counter": None, "uid": None, "serial": None,
                                 "serialHash": None, "uidHash": None, "sealKind": None, "sealDead": None, "message": message})
        out = tap_view(tap, chk.seal)
        if token:
            out["tapToken"] = token
        return JSONResponse(out)
    if tap is None:
        return RedirectResponse(url=f"{settings.web_url}/t", status_code=302)
    url = f"{settings.web_url}/t?tap={tap['id']}" + (f"&k={token}" if token else "")
    return RedirectResponse(url=url, status_code=302)


@router.get("/api/tap/{tap_id}")
def get_tap_row(tap_id: int = Path(ge=1, le=MAX_ID), conn=Depends(get_conn)):
    tap = get_tap(conn, tap_id)
    if not tap:
        raise HTTPException(404, "tap not found")
    seal = get_seal_by_uid(conn, tap["uid_hex"]) if tap["uid_hex"] else None
    return tap_view(tap, seal)
