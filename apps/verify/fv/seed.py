"""
Seed the database from docs/seed/passports.json.

  uv run python -m fv.seed            # wipe + seed using apps/verify/.env
The app also seeds automatically on startup when the passports table is empty.

SCAN events with a `scan` block get a full §4.4 bundle signed by the configured server key
(deterministic nonce/media hashes derived from serial+counter). `sighting` blocks are Tier-0 taps.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from fv import proof
from fv.config import Settings, settings_from_env
from fv.db import Database, transaction
from fv.db import (insert_event, mark_seal_dead, upsert_attester, upsert_passport, upsert_seal,
                   upsert_sim_tag, void_passport)
from fv.enums import EventType, Grade, Indicator, Tamper, VALID
from fv.sdm import key_for_uid


def _ts(v: str | int) -> int:
    if isinstance(v, int):
        return v
    return int(datetime.fromisoformat(v).timestamp())


def _event_type(v: str | int) -> int:
    return v if isinstance(v, int) else getattr(EventType, v)


def _scan_bundle(settings: Settings, serial: str, seal: dict, ts: int, actor: str | None, loc: dict | None,
                 sc: dict) -> tuple[dict, int, bool]:
    uid = bytes.fromhex(sc["uid"])
    sh, uh = proof.serial_hash(serial), proof.uid_hash(uid)
    heat_levels = list(sc["heatLevels"])
    heat = sc.get("heat", heat_levels[proof.HEAT_DECISIVE_INDEX])
    hum, uv, tamper = sc.get("hum", Indicator.INTACT), Indicator.MISSING, Tamper.UNKNOWN
    tier, role, fill, counter = sc["tier"], sc["role"], sc["fill"], sc["counter"]
    media_seed = sc.get("media")
    media_hash = proof.sha256(f"seed:{media_seed}".encode()) if (media_seed and tier >= 2) else proof.ZERO32
    nonce = proof.sha256(f"seed:nonce:{serial}:{counter}".encode())
    msg = proof.build_message(serial_hash=sh, uid_hash=uh, counter=counter, tamper=tamper, uv=uv, hum=hum, heat=heat,
                              fill=fill, media_hash=media_hash, nonce=nonce, ts=ts)
    sig = proof.sign(settings.server_seed, msg)
    grade, review = proof.compute_grade(verdict=VALID, tamper=tamper, heat=heat, hum=hum, fill=fill)
    bundle = proof.build_bundle(
        serial=serial, serial_hash_b=sh, uid_hash_b=uh, counter=counter, seal_kind=seal["kind"], tamper=tamper,
        heat=heat, hum=hum, uv=uv, heat_levels=heat_levels, fill=fill,
        country=(loc or {}).get("country"), city=(loc or {}).get("city"),
        media_hash_b=media_hash if media_hash != proof.ZERO32 else None, media_ar=None,
        nonce_b=nonce, issued_at=ts - 12, platform=sc.get("platform", "SIMULATOR"), role=role, tier=tier,
        attester=actor, key_id=settings.server_key_id, verdict=VALID, server_ts=ts, sig_b=sig, bundle_ts=ts + 3)
    bundle["grade"] = grade
    bundle["reviewRecommended"] = review
    bundle["msgHex"] = msg.hex()
    if sc.get("purpose"):
        bundle["purpose"] = sc["purpose"]
    if sc.get("siteId") is not None:
        bundle["siteId"] = sc["siteId"]
    return bundle, grade, review


def run_seed(db: Database, settings: Settings, path: Path | None = None, *, wipe: bool = False) -> dict:
    path = path or settings.seed_path
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if wipe:
        db.wipe()
    else:
        db.init()
    counts = {"passports": 0, "seals": 0, "events": 0, "attesters": 0, "simTags": 0}
    labels = {a["pubkey"]: a.get("label") for a in data.get("attesters", [])}

    with db.connect() as conn, transaction(conn):
        for a in data.get("attesters", []):
            upsert_attester(conn, pubkey=a["pubkey"], first_seen=_ts(a["firstSeen"]), label=a.get("label"),
                            is_partner=bool(a.get("isPartner")), scan_count=a.get("scanCount", 0),
                            certified_count=a.get("certifiedCount", 0), agree_count=a.get("agreeCount", 0),
                            compare_count=a.get("compareCount", 0), escrows_ok=a.get("escrowsOk", 0),
                            escrows_disputed=a.get("escrowsDisputed", 0))
            counts["attesters"] += 1

        for p in data["passports"]:
            serial = p["serial"]
            upsert_passport(conn, serial=serial, serial_hash=proof.serial_hash(serial).hex(), brand=p["brand"],
                            name=p["name"], batch=p.get("batch"), asset=p.get("asset"), issuer=p.get("issuer"),
                            issuer_label=p.get("issuerLabel"), grade=Grade.A, void=False, created_at=_ts(p["createdAt"]))
            counts["passports"] += 1
            seals_by_uid: dict[str, dict] = {}
            for s in p.get("seals", []):
                uid = bytes.fromhex(s["uid"])
                row = upsert_seal(conn, uid_hash=proof.uid_hash(uid).hex(), uid_hex=s["uid"].upper(), serial=serial,
                                  kind=s["kind"], last_counter=0, dead=False, attached_at=_ts(s["attachedAt"]))
                seals_by_uid[s["uid"].upper()] = row
                counts["seals"] += 1

            grade = Grade.A
            void = False
            for ev in p.get("events", []):
                etype, ts = _event_type(ev["type"]), _ts(ev["ts"])
                actor = ev.get("actor")
                actor_label = ev.get("actorLabel") or labels.get(actor)
                loc = ev.get("location") or {}
                seal_uid_hash = None
                payload = dict(ev.get("payload") or {})
                status = ev.get("status") or ("confirmed" if ev.get("txSig") else "pending")

                if "scan" in ev:
                    sc = ev["scan"]
                    seal = seals_by_uid[sc["uid"].upper()]
                    payload, grade, _ = _scan_bundle(settings, serial, seal, ts, actor, loc, sc)
                    seal_uid_hash = seal["uid_hash"]
                    conn.execute("UPDATE seals SET last_counter=MAX(last_counter, ?) WHERE uid_hash=?", (sc["counter"], seal_uid_hash))
                elif "sighting" in ev:
                    sg = ev["sighting"]
                    seal = seals_by_uid[sg["uid"].upper()]
                    seal_uid_hash = seal["uid_hash"]
                    payload = {"tier": 0, "verdict": VALID, "counter": sg["counter"]}
                    status = "confirmed"
                    conn.execute("UPDATE seals SET last_counter=MAX(last_counter, ?) WHERE uid_hash=?", (sg["counter"], seal_uid_hash))
                elif ev.get("seal"):
                    seal = seals_by_uid[ev["seal"].upper()]
                    seal_uid_hash = seal["uid_hash"]
                    payload.setdefault("uidHash", "0x" + seal_uid_hash)

                if etype == EventType.SEAL_DEAD:
                    void, grade = True, Grade.VOID
                    if seal_uid_hash:
                        mark_seal_dead(conn, seal_uid_hash)

                # MINT/SEAL_ATTACH happen before the birth scan; show the grade the birth scan will set (briefing §10 example).
                grade_after = grade
                if etype in (EventType.MINT, EventType.SEAL_ATTACH):
                    birth = next((e for e in p["events"] if "scan" in e), None)
                    if birth:
                        sc = birth["scan"]
                        grade_after, _ = proof.compute_grade(verdict=VALID, tamper=Tamper.UNKNOWN,
                                                             heat=sc.get("heat", sc["heatLevels"][4]),
                                                             hum=sc.get("hum", 0), fill=sc["fill"])
                insert_event(conn, serial=serial, type=etype, ts=ts, actor_pubkey=actor, actor_label=actor_label,
                             tx_sig=ev.get("txSig"), status=status, seal_uid_hash=seal_uid_hash, payload=payload,
                             grade_after=grade_after, country=loc.get("country"), city=loc.get("city"))
                counts["events"] += 1
                if actor:
                    upsert_attester(conn, pubkey=actor, first_seen=ts, label=actor_label if actor_label else None)

            if void:
                void_passport(conn, serial, Grade.VOID)
            else:
                conn.execute("UPDATE passports SET grade=? WHERE serial=?", (grade, serial))

        for t in data.get("simTags", []):
            uid = bytes.fromhex(t["uid"])
            key = key_for_uid(settings.key_mode, settings.master_key, uid)
            upsert_sim_tag(conn, uid_hex=t["uid"].upper(), key_hex=key.hex(), counter=t.get("counter", 0),
                           alive=bool(t.get("alive", True)), created_at=_ts(data["passports"][0]["createdAt"]), serial=t.get("serial"))
            conn.execute("UPDATE sim_tags SET counter=?, alive=? WHERE uid_hex=?", (t.get("counter", 0), int(bool(t.get("alive", True))), t["uid"].upper()))
            counts["simTags"] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    settings = settings_from_env()
    db = Database(settings.db_path)
    counts = run_seed(db, settings, wipe=("--keep" not in argv))
    print(f"seeded {settings.db_path}: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
