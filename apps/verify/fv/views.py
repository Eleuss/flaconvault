"""JSON shapes for the web app. Hashes go out as 0x + lowercase hex."""
from __future__ import annotations

import json

from fv.db import (events_for, get_passport, has_event_type, latest_scan_with_indicators, passport_stats,
                   recent_serials_for, seals_for)
from fv.enums import EventType, Grade, Tamper
from fv.proof import serial_hash, uid_hash


def h0x(h: str | None) -> str | None:
    return None if h is None else ("0x" + h.lower())


def tap_view(row: dict, seal: dict | None) -> dict:
    return {
        "tapId": row["id"],
        "ts": row["ts"],
        "verdict": row["verdict"],
        "counter": row["ctr"],
        "uid": row["uid_hex"],
        "serial": row["serial"],
        "serialHash": h0x(serial_hash(row["serial"]).hex()) if row["serial"] else None,
        "uidHash": h0x(uid_hash(bytes.fromhex(row["uid_hex"])).hex()) if row["uid_hex"] and len(row["uid_hex"]) == 14 else None,
        "sealKind": seal["kind"] if seal else None,
        "sealDead": bool(seal["dead"]) if seal else None,
        "message": row["message"],
    }


def event_view(r: dict) -> dict:
    return {
        "id": r["id"], "type": r["type"], "ts": r["ts"],
        "actor": r["actor_pubkey"], "actorLabel": r["actor_label"],
        "txSig": r["tx_sig"], "status": r["status"],
        "sealUidHash": h0x(r["seal_uid_hash"]),
        "payload": json.loads(r["payload_json"] or "{}"),
        "arBundle": r["ar_bundle"], "arMedia": r["ar_media"],
        "gradeAfter": r["grade_after"],
        "location": {"country": r["country"], "city": r["city"]},
    }


def seal_view(s: dict) -> dict:
    return {"uidHash": h0x(s["uid_hash"]), "kind": s["kind"], "lastCounter": s["last_counter"],
            "dead": bool(s["dead"]), "attachedAt": s["attached_at"]}


def passport_view(conn, serial: str) -> dict | None:
    p = get_passport(conn, serial)
    if not p:
        return None
    seals = seals_for(conn, serial)
    events = events_for(conn, serial)
    stats = passport_stats(conn, serial)
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
    any_dead = any(s["dead"] for s in seals) or has_event_type(conn, serial, EventType.SEAL_DEAD)
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
        "events": [event_view(e) for e in events],
    }


def passport_list_view(rows: list[dict]) -> list[dict]:
    return [{"serial": r["serial"], "brand": r["brand"], "name": r["name"],
             "grade": Grade.VOID if r["void"] else r["grade"], "void": bool(r["void"]),
             "scanCount": int(r["scan_count"] or 0), "lastEventTs": r["last_event_ts"]} for r in rows]


def attester_view(conn, a: dict) -> dict:
    compare = int(a["compare_count"] or 0)
    return {
        "pubkey": a["pubkey"], "label": a["label"], "isPartner": bool(a["is_partner"]),
        "firstSeen": a["first_seen"], "scanCount": a["scan_count"], "certifiedCount": a["certified_count"],
        "agreeCount": a["agree_count"], "compareCount": compare,
        "agreeRate": (a["agree_count"] / compare) if compare else None,
        "escrowsOk": a["escrows_ok"], "escrowsDisputed": a["escrows_disputed"],
        "recentSerials": recent_serials_for(conn, a["pubkey"]),
    }


def sim_tag_view(t: dict, seal: dict | None) -> dict:
    return {"uid": t["uid_hex"], "serial": t["serial"], "kind": seal["kind"] if seal else None,
            "counter": t["counter"], "alive": bool(t["alive"]), "lastUrl": t["last_url"], "createdAt": t["created_at"],
            "sealLastCounter": seal["last_counter"] if seal else None}
