"""GET /t — real tag landing (SUN URL). GET /api/tap/<id> — stored tap for the web /t page."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from fv.config import Settings
from fv.db import get_seal_by_uid, get_tap, insert_event, insert_tap, now, transaction
from fv.deps import get_conn, get_settings
from fv.enums import EventType, VALID
from fv.service import check_tap
from fv.strings import tap_message
from fv.views import tap_view

router = APIRouter()


def _wants_json(request: Request) -> bool:
    if request.query_params.get("format") == "json":
        return True
    accept = request.headers.get("accept", "")
    return "application/json" in accept and "text/html" not in accept.split(",")[0]


@router.get("/t")
def tag_landing(request: Request, uid: str | None = None, ctr: str | None = None, cmac: str | None = None,
                conn=Depends(get_conn), settings: Settings = Depends(get_settings)):
    ts = now()
    with transaction(conn):
        chk = check_tap(conn, settings, uid, ctr, cmac, consume=True)
        message = tap_message(chk.verdict, chk.counter)
        tap = insert_tap(conn, ts=ts, source="t", uid_hex=chk.uid_hex, ctr=chk.counter, cmac=chk.cmac_hex,
                         verdict=chk.verdict, serial=chk.serial, message=message)
        if chk.verdict == VALID and chk.seal:
            # Tier-0 sighting: off-chain only, nothing pending on chain.
            p = conn.execute("SELECT grade, void FROM passports WHERE serial=?", (chk.serial,)).fetchone()
            insert_event(conn, serial=chk.serial, type=EventType.SCAN, ts=ts, actor_pubkey=None, actor_label=None,
                         tx_sig=None, status="confirmed", seal_uid_hash=chk.seal["uid_hash"],
                         payload={"tier": 0, "verdict": VALID, "counter": chk.counter, "tapId": tap["id"]},
                         grade_after=(4 if p and p["void"] else (p["grade"] if p else None)), country=None, city=None)
    if _wants_json(request):
        return JSONResponse(tap_view(tap, chk.seal))
    return RedirectResponse(url=f"{settings.web_url}/t?tap={tap['id']}", status_code=302)


@router.get("/api/tap/{tap_id}")
def get_tap_row(tap_id: int, conn=Depends(get_conn)):
    tap = get_tap(conn, tap_id)
    if not tap:
        raise HTTPException(404, "tap not found")
    seal = get_seal_by_uid(conn, tap["uid_hex"]) if tap["uid_hex"] else None
    return tap_view(tap, seal)
