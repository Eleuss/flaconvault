"""JSON shapes for the web app. Hashes go out as 0x + lowercase hex."""
from __future__ import annotations

import json
import re
from urllib.parse import quote

from fv.db import (events_for, get_passport, has_event_type, latest_scan_with_indicators, partner_pubkeys, passport_stats_confirmed,
                   recent_confirmed_serials_for, seals_for)
from fv.enums import UNREGISTERED, EventType, Grade, Tamper, Tier
from fv.proof import serial_hash, uid_hash

_UID_RE = re.compile(r"^[0-9A-Fa-f]{14}$")


def h0x(h: str | None) -> str | None:
    return None if h is None else ("0x" + h.lower())


def _uid_hash0x(uid_hex: str | None) -> str | None:
    """uidHash of a stored uid; None for anything that is not 7 bytes of hex (INVALID taps store raw input)."""
    if not uid_hex or len(uid_hex) != 14:
        return None
    try:
        return h0x(uid_hash(bytes.fromhex(uid_hex)).hex())
    except ValueError:
        return None


def clean_text(v, max_len: int) -> str | None:
    """A short, printable string (whitespace collapsed) or None — no control, format (bidi override) or private-use
    characters ever reach a page."""
    if not isinstance(v, str):
        return None
    v = " ".join(v.split())
    return v[:max_len] if v and v.isprintable() else None


def _location(r: dict, *, relay: bool = False) -> dict:
    """Only a SCAN carries a location (the scanner's own, from /api/verify). Other events never show one: older rows
    stored whatever the first poster of a public transaction sent. A public-record (relay) scan shows only its country:
    the place stays in SQLite (§9.8, D14), as the consumer page tells the visitor."""
    if r.get("type") != EventType.SCAN:
        return {"country": None, "city": None}
    country = r.get("country")
    return {"country": country.upper() if isinstance(country, str) and re.fullmatch(r"[A-Za-z]{2}", country) else None,
            "city": None if relay else clean_text(r.get("city"), 80)}


def uid_tail(uid_hex: str) -> str:
    """The public stand-in for a chip UID: its last byte only (the seed's convention, e.g. "…F6")."""
    return "…" + uid_hex[-2:].upper()


def tap_view(row: dict, seal: dict | None) -> dict:
    return {
        "tapId": row["id"],
        "ts": row["ts"],
        "verdict": row["verdict"],
        "counter": row["ctr"],
        # the raw uid only for an unassigned chip (the web offers to attach it); never for registered seals
        "uid": row["uid_hex"] if row["verdict"] == UNREGISTERED else None,
        "serial": row["serial"],
        "serialHash": h0x(serial_hash(row["serial"]).hex()) if row["serial"] else None,
        "uidHash": _uid_hash0x(row["uid_hex"]),
        "sealKind": seal["kind"] if seal else None,
        "sealDead": bool(seal["dead"]) if seal else None,
        "message": row["message"],
    }


def public_payload(r: dict) -> dict:
    """
    The event payload as anyone may see it:
      * events that are not confirmed lose the signed scan message, the server signature and the session nonce — with
        those, anyone could anchor (front-run) the scan with their own wallet; the scanner gets them from its own
        /api/verify response or the resume link (GET /api/verify/{eventId}?token=);
      * the same for a public-record (relay) scan that is not recorded: its FVSCAN2 would let anyone send it first
        (record_scan_v2 accepts any fee payer) and take the counter a queued TAP of the same tap still needs;
      * a public-record (relay) scan never shows the v1-style detail kept in SQLite only (§9.8, D14): the free-text note,
        the place (only the country stays), the device platform and the claimed attester pubkey — pending or recorded;
      * raw chip UIDs never leave the server (older SEAL_ATTACH and report rows stored them): only uidTail.
    """
    payload = json.loads(r.get("payload_json") or "{}")
    if not isinstance(payload, dict):
        return {}
    if r.get("status") != "confirmed" or (payload.get("anchor") == "relay" and not r.get("tx_sig")):
        payload.pop("msgHex", None)
        if isinstance(payload.get("server"), dict):
            payload["server"] = {**payload["server"], "sig": None}
        if isinstance(payload.get("session"), dict):
            payload["session"] = {**payload["session"], "nonce": None}
        v2 = payload.get("bundleV2")
        if isinstance(v2, dict) and isinstance(v2.get("session"), dict):
            payload["bundleV2"] = {**v2, "session": {**v2["session"], "nonce": None}}
    if payload.get("anchor") == "relay":
        if isinstance(payload.get("visual"), dict):
            payload["visual"] = {k: v for k, v in payload["visual"].items() if k != "note"}
        if isinstance(payload.get("location"), dict):
            payload["location"] = {"country": payload["location"].get("country")}
        payload.pop("device", None)
        if isinstance(payload.get("attester"), dict):
            payload["attester"] = {k: v for k, v in payload["attester"].items() if k != "pubkey"}
    uid = payload.pop("uid", None)
    if isinstance(uid, str) and _UID_RE.match(uid):
        payload.setdefault("uidTail", uid_tail(uid))
    return payload


SCAN_BY_ACTOR = {"NONE": "VISITOR", "HOLDER": "HOLDER", "WALLET": "HOLDER", "PARTNER": "PARTNER", "RECIPIENT": "RECIPIENT"}


def _int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def scan_by(r: dict, payload: dict, partners: set[str] | None) -> str:
    """
    Who made a SCAN, for the history label (§9.9): a public-record scan by its actor kind (NONE → VISITOR, HOLDER and
    WALLET → HOLDER, PARTNER, RECIPIENT); a Tier-0 sighting → VISITOR; a v1 scan → PARTNER when its verified attester
    is a registry partner (`partners`) or its verified tier is ≥ CERTIFIED, else VISITOR.
    """
    kind = payload.get("actorKind")
    if isinstance(kind, str) and kind in SCAN_BY_ACTOR:
        return SCAN_BY_ACTOR[kind]
    if "indicators" not in payload:
        return "VISITOR"
    actor = r.get("actor_pubkey")
    claimed = payload.get("attester") if isinstance(payload.get("attester"), dict) else {}
    tier = _int((payload.get("chain") or {}).get("tier") if isinstance(payload.get("chain"), dict) else None)
    if tier is None:
        tier = _int(payload.get("tier"))
    if tier is None and actor and actor == claimed.get("pubkey"):
        tier = _int(claimed.get("tier"))
    if (tier or 0) >= Tier.CERTIFIED or (actor and partners and actor in partners):
        return "PARTNER"
    return "VISITOR"


def event_view(r: dict, partners: set[str] | None = None) -> dict:
    """An event as the API shows it. SCAN events add `scanBy` (scan_by; `partners` = the registry partner pubkeys) and
    `purpose` (the FVSCAN2 purpose name, null for v1 scans)."""
    payload = public_payload(r)
    out = {
        "id": r["id"], "type": r["type"], "ts": r["ts"],
        "actor": r["actor_pubkey"], "actorLabel": r["actor_label"],
        "txSig": r["tx_sig"], "status": r["status"],
        "sealUidHash": h0x(r["seal_uid_hash"]),
        "payload": payload,
        "arBundle": r["ar_bundle"], "arMedia": r["ar_media"],
        "gradeAfter": r["grade_after"],
        "location": _location(r, relay=payload.get("anchor") == "relay"),
    }
    if r.get("type") == EventType.SCAN:
        out["scanBy"] = scan_by(r, payload, partners)
        out["purpose"] = payload.get("purpose") if payload.get("anchor") == "relay" else None
    return out


def seal_view(s: dict) -> dict:
    return {"uidHash": h0x(s["uid_hash"]), "kind": s["kind"], "lastCounter": s["last_counter"],
            "dead": bool(s["dead"]), "attachedAt": s["attached_at"]}


def passport_view(conn, serial: str) -> dict | None:
    p = get_passport(conn, serial)
    if not p:
        return None
    seals = seals_for(conn, serial)
    events = events_for(conn, serial)
    partners = set(partner_pubkeys(conn))       # attesters.is_partner, synced from the on-chain registry by reconcile
    stats = passport_stats_confirmed(conn, serial)
    latest_row = latest_scan_with_indicators(conn, serial)
    latest = None
    if latest_row:
        b = json.loads(latest_row["payload_json"])
        latest = {
            "tamper": b.get("tamper", Tamper.UNKNOWN), "indicators": b.get("indicators"),
            "heatLevels": b.get("heatLevels"), "fill": b.get("fill"), "counter": b.get("counter"),
            "ts": latest_row["ts"], "reviewRecommended": bool(b.get("reviewRecommended", False)),
            "eventId": latest_row["id"], "attester": latest_row["actor_pubkey"],
        }
    # a merely *reported* SEAL_DEAD (no tx) is shown in the timeline but changes nothing here
    any_dead = any(s["dead"] for s in seals) or has_event_type(conn, serial, EventType.SEAL_DEAD, status="confirmed")
    if any_dead:
        seal_status = "NO_RESPONSE"
    elif latest and latest["tamper"] in (Tamper.OPENED_NOW, Tamper.OPENED_BEFORE):
        seal_status = "OPENED"
    else:
        seal_status = "INTACT"
    counter = max([s["last_counter"] for s in seals], default=0)
    return {
        "serial": p["serial"], "serialHash": h0x(p["serial_hash"]),
        "brand": p["brand"], "name": p["name"], "batch": p["batch"],
        "asset": p["asset"], "issuer": p["issuer"], "issuerLabel": p["issuer_label"],
        "grade": Grade.VOID if p["void"] else p["grade"], "void": bool(p["void"]), "createdAt": p["created_at"],
        "seals": [seal_view(s) for s in seals],
        "sealStatus": seal_status,
        "stats": {**stats, "counter": counter},
        "latest": latest,
        "events": [event_view(e, partners) for e in events],
    }


def passport_list_view(rows: list[dict]) -> list[dict]:
    return [{"serial": r["serial"], "brand": r["brand"], "name": r["name"],
             "grade": Grade.VOID if r["void"] else r["grade"], "void": bool(r["void"]),
             "scanCount": int(r["scan_count"] or 0), "lastEventTs": r["last_event_ts"]} for r in rows]


GRADE_LETTERS = {Grade.A: "A", Grade.B: "B", Grade.C: "C", Grade.D: "D", Grade.VOID: "VOID"}


def passport_metadata(conn, serial: str, web_url: str) -> dict | None:
    """Metaplex-style metadata JSON for the passport's Core asset (`uri`): name, image, link to the public page."""
    p = get_passport(conn, serial)
    if not p:
        return None
    grade = Grade.VOID if p["void"] else p["grade"]
    page = f"{web_url.rstrip('/')}/p/{quote(serial, safe='')}"
    attrs = [{"trait_type": "Serial", "value": serial}, {"trait_type": "Brand", "value": p["brand"]},
             {"trait_type": "Grade", "value": GRADE_LETTERS.get(grade, str(grade))}]
    if p["batch"]:
        attrs.append({"trait_type": "Batch", "value": p["batch"]})
    return {
        "name": f"{p['brand']} · {p['name']}"[:64],
        "symbol": "FLACON",
        "description": f"FlaconVault passport {serial}: seal and handling record of a {p['brand']} bottle. "
                       f"Full history: {page}",
        "image": f"{web_url.rstrip('/')}/icon.svg",
        "external_url": page,
        "attributes": attrs,
        "properties": {"category": "image", "files": [{"uri": f"{web_url.rstrip('/')}/icon.svg", "type": "image/svg+xml"}]},
    }


def attester_view(conn, a: dict, partners: set[str] | None = None) -> dict:
    """`partners`: the on-chain registry's partner list (the badge then never comes from seed data)."""
    compare = int(a["compare_count"] or 0)
    is_partner = (a["pubkey"] in partners) if partners is not None else bool(a["is_partner"])
    return {
        "pubkey": a["pubkey"], "label": a["label"], "isPartner": is_partner,
        "firstSeen": a["first_seen"], "scanCount": a["scan_count"], "certifiedCount": a["certified_count"],
        "agreeCount": a["agree_count"], "compareCount": compare,
        "agreeRate": (a["agree_count"] / compare) if compare else None,
        "escrowsOk": a["escrows_ok"], "escrowsDisputed": a["escrows_disputed"],
        "recentSerials": recent_confirmed_serials_for(conn, a["pubkey"]),
    }


def sim_tag_view(t: dict, seal: dict | None) -> dict:
    return {"uid": t["uid_hex"], "serial": t["serial"], "kind": seal["kind"] if seal else None,
            "counter": t["counter"], "alive": bool(t["alive"]), "lastUrl": t["last_url"], "createdAt": t["created_at"],
            "sealLastCounter": seal["last_counter"] if seal else None}
