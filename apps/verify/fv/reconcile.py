"""
Reconcile job (briefing §10): for every SCAN(pending) event read the ScanProof PDA; exists → confirmed
(fields compared, mismatches recorded under payload.reconcile), missing for longer than
FV_RECONCILE_TIMEOUT_S → failed. Then Passport/Seal PDAs refresh grade/void and last_counter/dead
(chain wins — once nothing is pending for that passport and the chain has recorded a scan or a void;
counters are never lowered, and the simulator tag follows a raised seal counter).
"""
from __future__ import annotations

import json
import logging
import time

from fv import arweave, proof
from fv.chain import (Rpc, RpcError, decode_passport, decode_scan_proof, decode_seal, pda_passport, pda_scan, pda_seal,
                      program_pubkey)
from fv.config import Settings
from fv.db import (Database, all_passports, all_seals, get_event, has_pending_events, pending_scan_events, set_event_status,
                   transaction, update_event_payload)
from fv.service import apply_confirmed_scan

log = logging.getLogger("fv.reconcile")


def now() -> int:
    return int(time.time())


def _compare(payload: dict, acct: dict) -> list[str]:
    ind = payload.get("indicators") or {}
    media = payload.get("media") or []
    media_hash = proof.strip0x(media[0]["sha256"]) if media else proof.ZERO32.hex()
    expected = {
        "counter": (payload.get("counter"), acct["counter"]),
        "tamper": (payload.get("tamper"), acct["tamper"]),
        "uv": (ind.get("uv"), acct["uv"]),
        "hum": (ind.get("humidity"), acct["hum"]),
        "heat": (ind.get("heat"), acct["heat"]),
        "fill": (payload.get("fill"), acct["fill"]),
        "media_hash": (media_hash.lower(), acct["mediaHash"]),
        "bundle_hash": (proof.strip0x(payload.get("bundleHash") or "").lower() or None, acct["bundleHash"]),
    }
    if payload.get("heatLevels") is not None:
        expected["heat_levels"] = (proof.heat_levels_to_mask(payload["heatLevels"]), acct["heatLevelsMask"])
    att = (payload.get("attester") or {}).get("pubkey")
    if att:
        expected["attester"] = (att, acct["attester"])
    return [k for k, (want, got) in expected.items() if want is not None and want != got]


def reconcile_once(db: Database, settings: Settings, rpc: Rpc, *, ts: int | None = None) -> dict:
    """
    One cycle. All RPC reads happen first, outside any write transaction (a slow RPC must never hold the SQLite
    write lock); the DB changes are then applied in one BEGIN IMMEDIATE transaction that re-checks each event is
    still pending. Arweave archiving of newly confirmed scans runs after the commit.
    """
    ts = ts if ts is not None else now()
    summary = {"checked": 0, "confirmed": 0, "failed": 0, "pending": 0, "mismatched": 0,
               "refreshed": {"passports": 0, "seals": 0}, "enabled": bool(settings.program_id)}
    if not settings.program_id:
        return summary
    pid = program_pubkey(settings.program_id)

    with db.connect() as conn:
        # ---- 1. read DB state (no write lock) ----
        work = []
        for ev in pending_scan_events(conn):
            payload = json.loads(ev["payload_json"] or "{}")
            counter = payload.get("counter")
            if counter is None:
                continue
            seal_pda = pda_seal(pid, bytes.fromhex(ev["seal_uid_hash"]))
            work.append((ev, payload, pda_scan(pid, seal_pda, int(counter))))
        summary["checked"] = len(work)
        passports = all_passports(conn)
        seals = all_seals(conn)
        p_pdas = [pda_passport(pid, bytes.fromhex(p["serial_hash"])) for p in passports]
        s_pdas = [pda_seal(pid, bytes.fromhex(s["uid_hash"])) for s in seals]

        # ---- 2. RPC reads ----
        accounts = rpc.get_multiple_accounts([w[2] for w in work]) if work else []
        sigs: dict[int, str | None] = {}
        for (ev, _payload, scan_pda), data in zip(work, accounts):
            if data is not None and not ev["tx_sig"]:
                try:
                    found = rpc.get_signatures_for_address(scan_pda, limit=1)
                    sigs[ev["id"]] = found[0] if found else None
                except RpcError as exc:
                    log.warning("reconcile: event %s signatures lookup failed: %s", ev["id"], exc)
        datas = rpc.get_multiple_accounts([*p_pdas, *s_pdas]) if (p_pdas or s_pdas) else []
        p_data, s_data = datas[:len(p_pdas)], datas[len(p_pdas):]

        # ---- 3. apply ----
        newly_confirmed: list[int] = []
        with transaction(conn):
            for (ev, payload, scan_pda), data in zip(work, accounts):
                cur = conn.execute("SELECT status FROM events WHERE id=?", (ev["id"],)).fetchone()
                if not cur or cur["status"] != "pending":
                    continue                       # confirmed/failed meanwhile (e.g. POST /api/events) — never touched again
                rec = dict(payload.get("reconcile") or {})
                rec.update({"checkedAt": ts, "scanPda": str(scan_pda)})
                if data is not None:
                    acct = decode_scan_proof(data)
                    mismatch = _compare(payload, acct)
                    rec["mismatch"] = mismatch
                    rec.pop("reason", None)
                    tx_sig = ev["tx_sig"] or sigs.get(ev["id"])
                    set_event_status(conn, ev["id"], "confirmed", tx_sig)
                    update_event_payload(conn, ev["id"], {**payload, "reconcile": rec})
                    # the ScanProof's attester is the verified signer of record_scan
                    conn.execute("UPDATE events SET actor_pubkey=? WHERE id=?", (acct["attester"], ev["id"]))
                    apply_confirmed_scan(conn, get_event(conn, ev["id"]), acct["attester"], ts)
                    newly_confirmed.append(ev["id"])
                    summary["confirmed"] += 1
                    if mismatch:
                        summary["mismatched"] += 1
                    log.info("reconcile: event %s (%s ctr %s) → confirmed%s%s", ev["id"], ev["serial"], payload.get("counter"),
                             f" tx {tx_sig[:8]}…" if tx_sig else "", f" MISMATCH {mismatch}" if mismatch else "")
                elif ts - int(ev["ts"]) > settings.reconcile_timeout_s:
                    rec["reason"] = f"no ScanProof after {settings.reconcile_timeout_s}s"
                    set_event_status(conn, ev["id"], "failed", None)
                    update_event_payload(conn, ev["id"], {**payload, "reconcile": rec})
                    summary["failed"] += 1
                    log.info("reconcile: event %s (%s ctr %s) → failed (%s)", ev["id"], ev["serial"], payload.get("counter"), rec["reason"])
                else:
                    summary["pending"] += 1

            # chain → DB refresh for passports and seals
            for p, data in zip(passports, p_data):
                if data is None or has_pending_events(conn, p["serial"]):
                    continue
                c = decode_passport(data)
                if c["scanCount"] == 0 and not c["void"]:
                    continue   # a passport without any on-chain scan carries only the mint default — nothing to learn yet
                cur = conn.execute("SELECT grade, void FROM passports WHERE serial=?", (p["serial"],)).fetchone()
                if cur and (int(cur["grade"]) != c["grade"] or bool(cur["void"]) != c["void"]):
                    conn.execute("UPDATE passports SET grade=?, void=? WHERE serial=?", (c["grade"], int(c["void"]), p["serial"]))
                    summary["refreshed"]["passports"] += 1
                    log.info("reconcile: passport %s grade %s→%s void %s→%s (chain)", p["serial"], cur["grade"], c["grade"], bool(cur["void"]), c["void"])
            for s, data in zip(seals, s_data):
                if data is None or has_pending_events(conn, s["serial"]):
                    continue
                c = decode_seal(data)
                cur = conn.execute("SELECT last_counter, dead FROM seals WHERE uid_hash=?", (s["uid_hash"],)).fetchone()
                if not cur:
                    continue
                new_counter = max(int(cur["last_counter"]), c["lastCounter"])
                new_dead = bool(cur["dead"]) or c["dead"]
                if new_counter != int(cur["last_counter"]) or new_dead != bool(cur["dead"]):
                    conn.execute("UPDATE seals SET last_counter=?, dead=? WHERE uid_hash=?", (new_counter, int(new_dead), s["uid_hash"]))
                    # keep the virtual tag ahead of the server counter, otherwise every simulated tap would be a REPLAY
                    conn.execute("UPDATE sim_tags SET counter=MAX(counter, ?) WHERE uid_hex=?", (new_counter, s["uid_hex"]))
                    summary["refreshed"]["seals"] += 1
                    log.info("reconcile: seal %s counter %s→%s dead %s→%s (chain)", s["uid_hex"], cur["last_counter"], new_counter, bool(cur["dead"]), new_dead)

        # ---- 4. Arweave (sidecar subprocess) after the commit ----
        if newly_confirmed and arweave.enabled(settings):
            for event_id in newly_confirmed:
                row = get_event(conn, event_id)
                if row:
                    arweave.archive_scan_event(conn, settings, row)
    return summary
