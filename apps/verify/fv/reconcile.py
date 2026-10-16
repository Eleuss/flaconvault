"""
Reconcile job (briefing §10). One cycle:

  1. SCAN events — every pending one, and failed ones of the last FAILED_RECHECK_S (the web app keeps a signed scan
     anchorable, so a ScanProof may appear after the timeout) — are checked against their ScanProof PDA. A valid
     ScanProof → confirmed: fields compared (mismatches recorded under payload.reconcile), actor, label, tier, role and
     site taken from the on-chain proof (payload.chain). Anything else at that address — no data (a plain SOL transfer
     to the PDA), a foreign account, a proof for another seal/counter — counts as "not created" and never aborts the
     cycle. A pending SCAN without a ScanProof after FV_RECONCILE_TIMEOUT_S → failed.
  2. Other pending events (no ScanProof can confirm them) → failed after FV_RECONCILE_TIMEOUT_S, so they never block
     the chain refresh of their passport.
  3. Passport/Seal PDAs refresh grade/void and last_counter/dead (once nothing is pending for that passport and the chain
     has recorded a scan or a void). Nothing sticky is ever lowered: void and dead are OR-ed, the grade is the worse of DB
     and chain, counters only rise (the simulator tag follows a raised seal counter).
  4. Registry partners → attesters.is_partner (the decoded registry is cached in chain_state); escrow Order accounts →
     escrow_orders → attesters.escrows_ok / escrows_disputed.
  5. Arweave: newly confirmed scans first, then a bounded backfill of confirmed scans without an archived bundle.

All RPC reads happen before the write transaction (a slow RPC must never hold the SQLite write lock).
"""
from __future__ import annotations

import json
import logging
import time

from fv import arweave, proof
from fv.chain import (ORDER_LEN, DecodeError, Rpc, RpcError, decode_order, decode_passport, decode_registry, decode_scan_proof,
                      decode_seal, pda_passport, pda_registry, pda_scan, pda_seal, program_pubkey)
from fv.config import Settings
from fv.db import (Database, all_passports, all_seals, get_event, has_pending_events, scan_events_to_reconcile, set_chain_state,
                   stale_pending_events, sync_escrow_counters, sync_registry_partners, transaction, update_event_payload,
                   upsert_escrow_order)
from fv.enums import Grade
from fv.service import apply_confirmed_scan

log = logging.getLogger("fv.reconcile")

FAILED_RECHECK_S = 24 * 3600     # a failed SCAN is re-checked against its ScanProof PDA for this long
SIGNATURE_LOOKUP_LIMIT = 10      # creating tx = oldest successful of the newest N signatures on the ScanProof PDA


def now() -> int:
    return int(time.time())


def _compare(payload: dict, acct: dict) -> list[str]:
    ind = payload.get("indicators") or {}
    media = payload.get("media") or []
    media_hash = proof.strip0x(media[0]["sha256"]) if media else proof.ZERO32.hex()
    att = payload.get("attester") or {}
    expected = {
        "counter": (payload.get("counter"), acct["counter"]),
        "tamper": (payload.get("tamper"), acct["tamper"]),
        "uv": (ind.get("uv"), acct["uv"]),
        "hum": (ind.get("humidity"), acct["hum"]),
        "heat": (ind.get("heat"), acct["heat"]),
        "fill": (payload.get("fill"), acct["fill"]),
        "media_hash": (media_hash.lower(), acct["mediaHash"]),
        "bundle_hash": (proof.strip0x(payload.get("bundleHash") or "").lower() or None, acct["bundleHash"]),
        "tier": (att.get("tier"), acct["tier"]),
        "role": (att.get("role"), acct["role"]),
        "site_id": (payload.get("siteId"), acct["siteId"]),
    }
    if payload.get("heatLevels") is not None:
        expected["heat_levels"] = (proof.heat_levels_to_mask(payload["heatLevels"]), acct["heatLevelsMask"])
    if att.get("pubkey"):
        expected["attester"] = (att["pubkey"], acct["attester"])
    return [k for k, (want, got) in expected.items() if want is not None and want != got]


def _scan_proof(data: bytes | None, seal_pda, counter: int) -> tuple[dict | None, str | None]:
    """(decoded ScanProof, None) — or (None, why it does not count) for anything that is not this scan's proof."""
    if data is None:
        return None, None
    try:
        acct = decode_scan_proof(data)
    except DecodeError as exc:
        return None, str(exc)
    if acct["seal"] != str(seal_pda) or acct["counter"] != int(counter):
        return None, "ScanProof of another seal/counter"
    return acct, None


def _confirm_scan(conn, ev: dict, payload: dict, rec: dict, acct: dict, scan_pda, tx_sig: str | None, ts: int) -> list[str]:
    mismatch = _compare(payload, acct)
    rec["mismatch"] = mismatch
    rec.pop("reason", None)
    rec.pop("ignoredAccount", None)
    if ev["status"] == "failed":
        rec["recoveredFrom"] = "failed"
    chain = {"attester": acct["attester"], "tier": acct["tier"], "role": acct["role"], "siteId": acct["siteId"],
             "counter": acct["counter"], "scanPda": str(scan_pda)}
    new_payload = {**payload, "reconcile": rec, "chain": chain}
    label = conn.execute("SELECT label FROM attesters WHERE pubkey=?", (acct["attester"],)).fetchone()
    # the ScanProof's attester is the verified signer of record_scan: actor, label (never the claimed partner's) and,
    # for a recovered failed scan, the signature found on chain instead of the client's failed one
    conn.execute(
        f"""UPDATE events SET status='confirmed', actor_pubkey=?, actor_label=?,
              tx_sig={'COALESCE(?, tx_sig)' if ev['status'] == 'failed' else 'COALESCE(tx_sig, ?)'} WHERE id=?""",
        (acct["attester"], label["label"] if label else None, tx_sig, ev["id"]))
    update_event_payload(conn, ev["id"], new_payload)
    # stats, payload.tier/role and payload.confirmed are credited with the on-chain tier/role/site, never with what the
    # client claimed at /api/verify; the signed claim in payload.attester stays as it was
    apply_confirmed_scan(conn, get_event(conn, ev["id"]), acct["attester"], ts, chain={**acct, "mismatch": ["siteId" if m == "site_id" else m for m in mismatch]})
    return mismatch


def reconcile_once(db: Database, settings: Settings, rpc: Rpc, *, ts: int | None = None) -> dict:
    """
    One cycle. All RPC reads happen first, outside any write transaction; the DB changes are then applied in one
    BEGIN IMMEDIATE transaction that re-checks each event's status. Arweave archiving runs after the commit.
    """
    ts = ts if ts is not None else now()
    summary = {"checked": 0, "confirmed": 0, "recovered": 0, "failed": 0, "pending": 0, "mismatched": 0, "ignoredAccounts": 0,
               "refreshed": {"passports": 0, "seals": 0}, "registry": None, "escrow": None, "arweave": None,
               "enabled": bool(settings.program_id)}
    if not settings.program_id:
        return summary
    pid = program_pubkey(settings.program_id)

    with db.connect() as conn:
        # ---- 1. read DB state (no write lock) ----
        work = []
        for ev in scan_events_to_reconcile(conn, ts - FAILED_RECHECK_S):
            payload = json.loads(ev["payload_json"] or "{}")
            counter = int(payload["counter"])
            seal_pda = pda_seal(pid, bytes.fromhex(ev["seal_uid_hash"]))
            work.append((ev, payload, seal_pda, counter, pda_scan(pid, seal_pda, counter)))
        summary["checked"] = len(work)
        passports = all_passports(conn)
        seals = all_seals(conn)
        p_pdas = [pda_passport(pid, bytes.fromhex(p["serial_hash"])) for p in passports]
        s_pdas = [pda_seal(pid, bytes.fromhex(s["uid_hash"])) for s in seals]

        # ---- 2. RPC reads ----
        accounts = rpc.get_multiple_accounts([w[4] for w in work]) if work else []
        proofs = [_scan_proof(data, w[2], w[3]) for w, data in zip(work, accounts)]
        sigs: dict[int, str | None] = {}
        for (ev, _p, _s, _c, scan_pda), (acct, _why) in zip(work, proofs):
            if acct is not None and (not ev["tx_sig"] or ev["status"] == "failed"):
                try:
                    found = rpc.get_signatures_for_address(scan_pda, limit=SIGNATURE_LOOKUP_LIMIT)
                    sigs[ev["id"]] = found[-1] if found else None      # newest first → the oldest is the creating tx
                except RpcError as exc:
                    log.warning("reconcile: event %s signatures lookup failed: %s", ev["id"], exc)
        datas = rpc.get_multiple_accounts([*p_pdas, *s_pdas, pda_registry(pid)])
        p_data, s_data, reg_data = datas[:len(p_pdas)], datas[len(p_pdas):len(p_pdas) + len(s_pdas)], datas[-1]
        orders = None
        if settings.escrow_program_id:
            try:
                orders = rpc.get_program_accounts(settings.escrow_program_id, data_size=ORDER_LEN)
            except RpcError as exc:
                log.warning("reconcile: escrow orders lookup failed: %s", exc)

        # ---- 3. apply ----
        newly_confirmed: list[int] = []
        with transaction(conn):
            for (ev, payload, _seal, counter, scan_pda), (acct, why) in zip(work, proofs):
                cur = conn.execute("SELECT status FROM events WHERE id=?", (ev["id"],)).fetchone()
                if not cur or cur["status"] != ev["status"]:
                    continue                       # confirmed/failed meanwhile (e.g. POST /api/events) — never touched again
                rec = dict(payload.get("reconcile") or {})
                rec.update({"checkedAt": ts, "scanPda": str(scan_pda)})
                if why:
                    rec["ignoredAccount"] = why
                    summary["ignoredAccounts"] += 1
                    log.warning("reconcile: event %s (%s ctr %s): account at the ScanProof PDA ignored (%s)", ev["id"], ev["serial"],
                                counter, why)
                if acct is not None:
                    tx_sig = sigs.get(ev["id"]) if ev["status"] == "failed" else (ev["tx_sig"] or sigs.get(ev["id"]))
                    mismatch = _confirm_scan(conn, ev, payload, rec, acct, scan_pda, tx_sig, ts)
                    newly_confirmed.append(ev["id"])
                    summary["confirmed"] += 1
                    summary["recovered"] += ev["status"] == "failed"
                    summary["mismatched"] += bool(mismatch)
                    log.info("reconcile: event %s (%s ctr %s) %s → confirmed%s%s", ev["id"], ev["serial"], counter, ev["status"],
                             f" tx {tx_sig[:8]}…" if tx_sig else "", f" MISMATCH {mismatch}" if mismatch else "")
                elif ev["status"] == "failed":
                    continue                       # still no ScanProof: stays failed, checked again next cycle
                elif ts - int(ev["ts"]) > settings.reconcile_timeout_s:
                    rec["reason"] = f"no ScanProof after {settings.reconcile_timeout_s}s"
                    conn.execute("UPDATE events SET status='failed' WHERE id=? AND status='pending'", (ev["id"],))
                    update_event_payload(conn, ev["id"], {**payload, "reconcile": rec})
                    summary["failed"] += 1
                    log.info("reconcile: event %s (%s ctr %s) → failed (%s)", ev["id"], ev["serial"], counter, rec["reason"])
                else:
                    if why:
                        update_event_payload(conn, ev["id"], {**payload, "reconcile": rec})
                    summary["pending"] += 1

            # pending events no ScanProof can ever confirm: time out, so they never block the chain refresh
            for ev in stale_pending_events(conn, ts - settings.reconcile_timeout_s):
                payload = json.loads(ev["payload_json"] or "{}")
                rec = {**(payload.get("reconcile") or {}), "checkedAt": ts,
                       "reason": f"no on-chain confirmation after {settings.reconcile_timeout_s}s"}
                conn.execute("UPDATE events SET status='failed' WHERE id=? AND status='pending'", (ev["id"],))
                update_event_payload(conn, ev["id"], {**payload, "reconcile": rec})
                summary["failed"] += 1
                log.info("reconcile: event %s (%s type %s) → failed (%s)", ev["id"], ev["serial"], ev["type"], rec["reason"])

            # chain → DB refresh for passports and seals
            for p, data in zip(passports, p_data):
                if data is None or has_pending_events(conn, p["serial"]):
                    continue
                try:
                    c = decode_passport(data)
                except DecodeError as exc:
                    summary["ignoredAccounts"] += 1
                    log.warning("reconcile: passport %s account ignored (%s)", p["serial"], exc)
                    continue
                if c["scanCount"] == 0 and not c["void"]:
                    continue   # a passport without any on-chain scan carries only the mint default — nothing to learn yet
                cur = conn.execute("SELECT grade, void FROM passports WHERE serial=?", (p["serial"],)).fetchone()
                if not cur:
                    continue
                # void is sticky: MAX(db, chain); a VOID grade on chain counts as void (record_scan: Passport::is_voided)
                new_void = bool(cur["void"]) or bool(c["void"]) or int(c["grade"]) >= Grade.VOID
                new_grade = Grade.VOID if new_void else max(int(cur["grade"]), int(c["grade"]))   # the worse grade wins
                if new_grade != int(cur["grade"]) or new_void != bool(cur["void"]):
                    conn.execute("UPDATE passports SET grade=?, void=? WHERE serial=?", (new_grade, int(new_void), p["serial"]))
                    summary["refreshed"]["passports"] += 1
                    log.info("reconcile: passport %s grade %s→%s void %s→%s (chain grade %s void %s)", p["serial"], cur["grade"],
                             new_grade, bool(cur["void"]), new_void, c["grade"], c["void"])
            for s, data in zip(seals, s_data):
                if data is None or has_pending_events(conn, s["serial"]):
                    continue
                try:
                    c = decode_seal(data)
                except DecodeError as exc:
                    summary["ignoredAccounts"] += 1
                    log.warning("reconcile: seal %s account ignored (%s)", s["uid_hex"], exc)
                    continue
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

            # registry partners → is_partner (the seed's partner flags are never trusted once the registry is readable)
            if reg_data is not None:
                try:
                    reg = decode_registry(reg_data)
                except DecodeError as exc:
                    summary["ignoredAccounts"] += 1
                    log.warning("reconcile: registry account ignored (%s)", exc)
                else:
                    changed = sync_registry_partners(conn, reg["partners"], ts)
                    set_chain_state(conn, "registry", {"programId": settings.program_id, **reg}, ts)
                    summary["registry"] = {"partners": len(reg["partners"]), "sites": len(reg["sites"]), "changed": changed}
            # escrow orders → escrows_ok / escrows_disputed
            if orders is not None:
                n = 0
                for order_pda, data in orders:
                    try:
                        o = decode_order(data)
                    except DecodeError:
                        continue
                    upsert_escrow_order(conn, order_pda, o, ts)
                    n += 1
                summary["escrow"] = {"orders": n, "changed": sync_escrow_counters(conn, ts)}

        # ---- 4. Arweave (sidecar subprocess) after the commit ----
        if arweave.enabled(settings):
            for event_id in newly_confirmed:
                row = get_event(conn, event_id)
                if row:
                    arweave.archive_scan_event(conn, settings, row)
            summary["arweave"] = arweave.backfill(conn, settings, skip_ids=frozenset(newly_confirmed))
    return summary
