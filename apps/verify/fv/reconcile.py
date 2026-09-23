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

from fv import proof
from fv.chain import (Rpc, RpcError, decode_passport, decode_scan_proof, decode_seal, pda_passport, pda_scan, pda_seal,
                      program_pubkey)
from fv.config import Settings
from fv.db import (Database, all_passports, all_seals, has_pending_events, pending_scan_events, set_event_status,
                   transaction, update_event_payload)

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
    ts = ts if ts is not None else now()
    summary = {"checked": 0, "confirmed": 0, "failed": 0, "pending": 0, "mismatched": 0,
               "refreshed": {"passports": 0, "seals": 0}, "enabled": bool(settings.program_id)}
    if not settings.program_id:
        return summary
    pid = program_pubkey(settings.program_id)

    with db.connect() as conn:
        events = pending_scan_events(conn)
        work = []
        for ev in events:
            payload = json.loads(ev["payload_json"] or "{}")
            counter = payload.get("counter")
            if counter is None:
                continue
            seal_pda = pda_seal(pid, bytes.fromhex(ev["seal_uid_hash"]))
            work.append((ev, payload, pda_scan(pid, seal_pda, int(counter))))
        summary["checked"] = len(work)

        accounts = rpc.get_multiple_accounts([w[2] for w in work]) if work else []
        with transaction(conn):
            for (ev, payload, scan_pda), data in zip(work, accounts):
                rec = dict(payload.get("reconcile") or {})
                rec.update({"checkedAt": ts, "scanPda": str(scan_pda)})
                if data is not None:
                    acct = decode_scan_proof(data)
                    mismatch = _compare(payload, acct)
                    rec["mismatch"] = mismatch
                    rec.pop("reason", None)
                    tx_sig = ev["tx_sig"]
                    if not tx_sig:
                        try:
                            sigs = rpc.get_signatures_for_address(scan_pda, limit=1)
                            tx_sig = sigs[0] if sigs else None
                        except RpcError as exc:
                            log.warning("reconcile: event %s signatures lookup failed: %s", ev["id"], exc)
                    set_event_status(conn, ev["id"], "confirmed", tx_sig)
                    update_event_payload(conn, ev["id"], {**payload, "reconcile": rec})
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
            passports = all_passports(conn)
            seals = all_seals(conn)
            p_pdas = [pda_passport(pid, bytes.fromhex(p["serial_hash"])) for p in passports]
            s_pdas = [pda_seal(pid, bytes.fromhex(s["uid_hash"])) for s in seals]
            datas = rpc.get_multiple_accounts([*p_pdas, *s_pdas]) if (p_pdas or s_pdas) else []
            p_data, s_data = datas[:len(p_pdas)], datas[len(p_pdas):]
            for p, data in zip(passports, p_data):
                if data is None or has_pending_events(conn, p["serial"]):
                    continue
                c = decode_passport(data)
                if c["scanCount"] == 0 and not c["void"]:
                    continue   # a passport without any on-chain scan carries only the mint default — nothing to learn yet
                if int(p["grade"]) != c["grade"] or bool(p["void"]) != c["void"]:
                    conn.execute("UPDATE passports SET grade=?, void=? WHERE serial=?", (c["grade"], int(c["void"]), p["serial"]))
                    summary["refreshed"]["passports"] += 1
                    log.info("reconcile: passport %s grade %s→%s void %s→%s (chain)", p["serial"], p["grade"], c["grade"], bool(p["void"]), c["void"])
            for s, data in zip(seals, s_data):
                if data is None or has_pending_events(conn, s["serial"]):
                    continue
                c = decode_seal(data)
                new_counter = max(int(s["last_counter"]), c["lastCounter"])
                new_dead = bool(s["dead"]) or c["dead"]
                if new_counter != int(s["last_counter"]) or new_dead != bool(s["dead"]):
                    conn.execute("UPDATE seals SET last_counter=?, dead=? WHERE uid_hash=?", (new_counter, int(new_dead), s["uid_hash"]))
                    # keep the virtual tag ahead of the server counter, otherwise every simulated tap would be a REPLAY
                    conn.execute("UPDATE sim_tags SET counter=MAX(counter, ?) WHERE uid_hex=?", (new_counter, s["uid_hex"]))
                    summary["refreshed"]["seals"] += 1
                    log.info("reconcile: seal %s counter %s→%s dead %s→%s (chain)", s["uid_hex"], s["last_counter"], new_counter, bool(s["dead"]), new_dead)
    return summary
