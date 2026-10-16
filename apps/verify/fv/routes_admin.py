"""
Operator endpoints (x-admin-token = FV_ADMIN_TOKEN; 403 while it is unset):

  GET  /api/admin/status                   configuration summary and the full Arweave archiving status
  POST /api/admin/purge-seed?dry_run=true  remove what the demo seed (docs/seed/passports.json) put into this database

purge-seed keeps everything that has real on-chain evidence. It deletes
  * seed events whose txSig does not exist on chain (getSignatureStatuses, searched through the full history),
    seed events without any txSig (sightings), and every seed-signed SCAN payload (its session nonce is the seed's
    deterministic nonce) — even if someone anchored that signature on chain, the scan never happened (reported as
    replayedOnChain so the seal can be retired on chain),
  * the seed's fake attesters/partners, unless they still act in a kept event, are registry partners on chain or take
    part in an on-chain escrow order (then only the seeded label, partner flag and counters are removed),
  * sim_tags of the seed (all of them while the simulator is off: they hold derived tag keys),
  * seed passports/seals left without any event and without an on-chain account.
Kept seed passports/seals get grade, void and dead recomputed from what remains (plus the chain), and a seed issuer is
replaced by the on-chain issuer. A kept seed passport that exists on chain is never left without a MINT event (that is
what makes POST /api/events answer a replayed mint tx with the stored event instead of taking the poster's brand/name):
when no MINT of it survives, one is rebuilt from the chain — actor = the on-chain issuer, tx_sig = the passport PDA's
creating mint_passport (verified with getTransaction, else empty), payload.fromChain, no seed flag. Kept rows are marked
payload.seedKept, so the startup warning (seed.count_seed_rows) clears after a complete purge. dry_run=true (the
default) only reports. All RPC reads happen before the write transaction; the deletions re-check their conditions
under the lock.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from fv import arweave, proof
from fv.chain import (DEFAULT_PUBKEY, DecodeError, RpcError, decode_passport, decode_registry, decode_seal, is_account,
                      pda_passport, pda_registry, pda_scan, pda_seal, program_pubkey)
from fv.config import Settings
from fv.db import insert_event, transaction
from fv.deps import get_db, get_rpc, get_settings, require_admin
from fv.enums import EventType, Grade
from fv.ratelimit import rate_limit
from fv.reconcile import creating_signature
from fv.seed import load_seed_index, seed_candidates

log = logging.getLogger("fv.admin")
router = APIRouter(dependencies=[Depends(require_admin)])

SEED_COUNTERS = {"scanCount": "scan_count", "certifiedCount": "certified_count", "agreeCount": "agree_count",
                 "compareCount": "compare_count", "escrowsOk": "escrows_ok", "escrowsDisputed": "escrows_disputed"}


@router.get("/api/admin/status")
def admin_status(settings: Settings = Depends(get_settings)):
    return {"keyMode": settings.key_mode, "sdmDerive": settings.sdm_derive, "simulator": settings.dev_simulator,
            "seedDemo": settings.seed_demo, "programId": settings.program_id or None,
            "escrowProgramId": settings.escrow_program_id or None, "reconcileIntervalS": settings.reconcile_interval_s,
            "arweave": arweave.status(settings)}


# ---------- purge-seed ----------

PASSPORT_SIGNATURE_LIMIT = 1000   # getSignaturesForAddress maximum: every scan/attach/escrow tx touches the passport PDA


def _mint_signature(rpc, settings: Settings, passport_pda: str, issuer: str) -> str | None:
    """The passport PDA's creating mint_passport, signed by the on-chain issuer (None: not found / not readable)."""
    try:
        return creating_signature(rpc, passport_pda, program=settings.program_id, instruction="mint_passport",
                                  accounts={"passport": passport_pda}, signer=issuer, limit=PASSPORT_SIGNATURE_LIMIT)
    except RpcError as exc:
        log.warning("purge-seed: signatures of %s not readable: %s", passport_pda, exc)
        return None


def _plan(conn, settings: Settings, rpc, seed: dict) -> dict[str, Any]:
    pid = program_pubkey(settings.program_id)
    candidates, payloads, signed = seed_candidates(conn, seed)

    # ---- RPC (no write lock) ----
    tx_sigs = sorted({r["tx_sig"] for r in candidates if r["tx_sig"]})
    statuses = dict(zip(tx_sigs, rpc.get_signature_statuses(tx_sigs))) if tx_sigs else {}
    serials = sorted(seed["serials"])
    seal_rows = {r["uid_hex"]: dict(r) for r in conn.execute("SELECT * FROM seals").fetchall() if r["uid_hex"] in seed["seals"]}
    seal_uids = sorted(seal_rows)
    signed_rows = [r for r in candidates if r["id"] in signed and r["seal_uid_hash"] and payloads[r["id"]].get("counter") is not None]
    scan_pdas = [pda_scan(pid, pda_seal(pid, bytes.fromhex(r["seal_uid_hash"])), int(payloads[r["id"]]["counter"])) for r in signed_rows]
    keys = [*(pda_passport(pid, proof.serial_hash(s)) for s in serials),
            *(pda_seal(pid, bytes.fromhex(seal_rows[u]["uid_hash"])) for u in seal_uids), *scan_pdas, pda_registry(pid)]
    datas = rpc.get_multiple_accounts(keys)
    n_p, n_s = len(serials), len(seal_uids)
    chain_passports = {}
    for s, d in zip(serials, datas[:n_p]):
        try:
            chain_passports[s] = decode_passport(d) if d is not None else None
        except DecodeError:
            chain_passports[s] = None
    chain_seals = {}
    for u, d in zip(seal_uids, datas[n_p:n_p + n_s]):
        try:
            chain_seals[u] = decode_seal(d) if d is not None else None
        except DecodeError:
            chain_seals[u] = None
    replayed = [{"eventId": r["id"], "serial": r["serial"], "counter": payloads[r["id"]]["counter"], "scanPda": str(pda)}
                for r, pda, d in zip(signed_rows, scan_pdas, datas[n_p + n_s:-1]) if is_account(d, "ScanProof")]
    partners: set[str] | None = None
    try:
        partners = set(decode_registry(datas[-1])["partners"]) if datas[-1] is not None else None
    except DecodeError:
        partners = None

    delete, keep = [], []
    for r in candidates:
        item = {"id": r["id"], "serial": r["serial"], "type": EventType.name(r["type"]), "txSig": r["tx_sig"]}
        if r["id"] in signed:
            delete.append({**item, "reason": "seed-signed scan"})
        elif r["tx_sig"] and statuses.get(r["tx_sig"]) is not None:
            keep.append({**item, "reason": "transaction exists on chain"})
        elif r["tx_sig"]:
            delete.append({**item, "reason": "seed transaction does not exist on chain"})
        else:
            delete.append({**item, "reason": "seed event without a transaction"})

    # a kept passport that exists on chain must keep a MINT: rebuilt from chain when none survives the purge
    deleted = {d["id"] for d in delete}
    mints: list[dict[str, Any]] = []
    for serial in serials:
        chain = chain_passports.get(serial)
        if not chain or conn.execute("SELECT 1 FROM passports WHERE serial=?", (serial,)).fetchone() is None:
            continue
        left = [r[0] for r in conn.execute("SELECT id FROM events WHERE serial=? AND type=?", (serial, EventType.MINT)).fetchall()
                if r[0] not in deleted]
        if left:
            continue
        pda = str(pda_passport(pid, proof.serial_hash(serial)))
        mints.append({"serial": serial, "issuer": chain["issuer"], "createdAt": chain["createdAt"],
                      "txSig": _mint_signature(rpc, settings, pda, chain["issuer"])})
    return {"delete": delete, "keep": keep, "replayed": replayed, "chainPassports": chain_passports, "chainSeals": chain_seals,
            "partners": partners, "sealRows": seal_rows, "mintFromChain": mints}


def _rebuild_mint(conn, serial: str, chain: dict, plan_item: dict, ts: int) -> dict | None:
    """The MINT of an on-chain passport, from chain facts (and the passport row's names); None if a MINT exists again."""
    if conn.execute("SELECT 1 FROM events WHERE serial=? AND type=? LIMIT 1", (serial, EventType.MINT)).fetchone():
        return None
    p = conn.execute("SELECT * FROM passports WHERE serial=?", (serial,)).fetchone()
    issuer = chain["issuer"]
    conn.execute("INSERT INTO attesters(pubkey, first_seen) VALUES(?,?) ON CONFLICT(pubkey) DO NOTHING",
                 (issuer, int(chain["createdAt"] or 0) or ts))
    label = conn.execute("SELECT label FROM attesters WHERE pubkey=?", (issuer,)).fetchone()
    label = label[0] if label else None
    asset = chain["asset"] if chain["asset"] != DEFAULT_PUBKEY else None
    payload = {"brand": p["brand"], "name": p["name"], "fromChain": True, "bindingHash": "0x" + chain["bindingHash"]}
    if p["batch"]:
        payload["batch"] = p["batch"]
    if asset:
        payload["asset"] = asset
    conn.execute("UPDATE passports SET issuer=?, issuer_label=?, asset=COALESCE(?, asset) WHERE serial=?", (issuer, label, asset, serial))
    created = int(chain["createdAt"] or 0) or ts
    row = insert_event(conn, serial=serial, type=EventType.MINT, ts=created, actor_pubkey=issuer, actor_label=label,
                       tx_sig=plan_item["txSig"], status="confirmed", seal_uid_hash=None, payload=payload,
                       grade_after=Grade.VOID if p["void"] else p["grade"], country=None, city=None)
    return {"eventId": row["id"], "issuer": issuer, "txSig": plan_item["txSig"]}


def _recompute_passport(conn, serial: str, chain: dict | None) -> dict:
    """grade/void from the remaining confirmed events (and the chain); the off-chain 'only worse' rule starts over."""
    void = bool(chain and chain["void"]) or conn.execute(
        "SELECT 1 FROM events WHERE serial=? AND type=? AND status='confirmed' LIMIT 1", (serial, EventType.SEAL_DEAD)).fetchone() is not None
    grade = int(chain["grade"]) if chain and chain["scanCount"] > 0 else Grade.A
    for (g,) in conn.execute("""SELECT json_extract(payload_json, '$.grade') FROM events WHERE serial=? AND type=2
                                AND status='confirmed' AND json_extract(payload_json, '$.grade') IS NOT NULL""", (serial,)).fetchall():
        grade = max(grade, int(g))
    if grade >= Grade.VOID:
        void = True
    grade = Grade.VOID if void else grade
    conn.execute("UPDATE passports SET grade=?, void=? WHERE serial=?", (grade, int(void), serial))
    return {"grade": grade, "void": void}


def _apply(conn, settings: Settings, seed: dict, plan: dict[str, Any], ts: int) -> dict[str, Any]:
    res: dict[str, Any] = {"events": 0, "kept": 0, "attesters": {"deleted": [], "cleaned": []}, "simTags": [],
                           "seals": {"deleted": [], "updated": []}, "passports": {"deleted": [], "updated": []}, "mintFromChain": []}
    ids = [d["id"] for d in plan["delete"]]
    touched = {d["serial"] for d in plan["delete"]}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        res["events"] += conn.execute(f"DELETE FROM events WHERE id IN ({','.join('?' * len(chunk))})", chunk).rowcount
    # kept seed rows (their tx exists on chain) are marked, so the startup warning does not count them again
    for d in plan["keep"]:
        res["kept"] += conn.execute("""UPDATE events SET payload_json=json_set(payload_json, '$.seedKept', json('true'))
                                       WHERE id=? AND COALESCE(json_extract(payload_json, '$.seedKept'), 0) = 0""",
                                    (d["id"],)).rowcount

    # attesters of the seed
    in_orders = {r[0] for r in conn.execute("SELECT seller FROM escrow_orders UNION SELECT buyer FROM escrow_orders WHERE buyer IS NOT NULL")}
    partners = plan["partners"]
    for pk, a in seed["attesters"].items():
        row = conn.execute("SELECT * FROM attesters WHERE pubkey=?", (pk,)).fetchone()
        if not row:
            continue
        acts = conn.execute("SELECT 1 FROM events WHERE actor_pubkey=? LIMIT 1", (pk,)).fetchone() is not None
        is_partner = partners is not None and pk in partners
        if not acts and not is_partner and pk not in in_orders:
            conn.execute("DELETE FROM attesters WHERE pubkey=?", (pk,))
            res["attesters"]["deleted"].append(pk)
            continue
        if not ids:
            continue      # seed rows were already purged earlier: the seeded counters are gone, never subtract twice
        # the seed wrote absolute counters; everything above them was earned later (bumps on confirmed events)
        sets = {col: max(0, int(row[col]) - int(a.get(key) or 0)) for key, col in SEED_COUNTERS.items()}
        sets["is_partner"] = int(is_partner)
        label = row["label"]
        if label and a.get("label") and label == a["label"]:
            label = None
        conn.execute(f"UPDATE attesters SET {', '.join(f'{k}=?' for k in sets)}, label=? WHERE pubkey=?", (*sets.values(), label, pk))
        res["attesters"]["cleaned"].append(pk)

    # virtual tags: the seed's, and every one while the simulator is off (they hold derived tag keys)
    uids = [r[0] for r in conn.execute("SELECT uid_hex FROM sim_tags").fetchall()
            if not settings.dev_simulator or r[0] in seed["simTags"]]
    for u in uids:
        conn.execute("DELETE FROM sim_tags WHERE uid_hex=?", (u,))
    res["simTags"] = uids

    # seals and passports of the seed
    for uid, s in plan["sealRows"].items():
        cur = conn.execute("SELECT * FROM seals WHERE uid_hex=?", (uid,)).fetchone()
        if not cur:
            continue
        chain = plan["chainSeals"].get(uid)
        used = conn.execute("SELECT 1 FROM events WHERE seal_uid_hash=? LIMIT 1", (cur["uid_hash"],)).fetchone() is not None
        if not used and chain is None:
            conn.execute("DELETE FROM seals WHERE uid_hash=?", (cur["uid_hash"],))
            res["seals"]["deleted"].append(uid)
        elif cur["serial"] in touched:
            dead = bool(chain and chain["dead"]) or conn.execute(
                "SELECT 1 FROM events WHERE seal_uid_hash=? AND type=? AND status='confirmed' LIMIT 1",
                (cur["uid_hash"], EventType.SEAL_DEAD)).fetchone() is not None
            counter = max(int(cur["last_counter"]), int(chain["lastCounter"]) if chain else 0)   # never lowered (replay memory)
            conn.execute("UPDATE seals SET dead=?, last_counter=? WHERE uid_hash=?", (int(dead), counter, cur["uid_hash"]))
            res["seals"]["updated"].append({"uid": uid, "dead": dead, "lastCounter": counter})
    for serial in sorted(seed["serials"]):
        p = conn.execute("SELECT * FROM passports WHERE serial=?", (serial,)).fetchone()
        if not p:
            continue
        chain = plan["chainPassports"].get(serial)
        has_events = conn.execute("SELECT 1 FROM events WHERE serial=? LIMIT 1", (serial,)).fetchone() is not None
        if not has_events and chain is None:
            conn.execute("DELETE FROM passports WHERE serial=?", (serial,))          # cascades its seals
            res["passports"]["deleted"].append(serial)
            continue
        if serial not in touched:
            continue
        upd = {"serial": serial, **_recompute_passport(conn, serial, chain)}
        if chain and p["issuer"] in seed["attesters"] and p["issuer"] != chain["issuer"]:
            label = conn.execute("SELECT label FROM attesters WHERE pubkey=?", (chain["issuer"],)).fetchone()
            conn.execute("UPDATE passports SET issuer=?, issuer_label=? WHERE serial=?", (chain["issuer"], label[0] if label else None, serial))
            upd["issuer"] = chain["issuer"]
        upd["hasMint"] = conn.execute("SELECT 1 FROM events WHERE serial=? AND type=? LIMIT 1", (serial, EventType.MINT)).fetchone() is not None
        res["passports"]["updated"].append(upd)
    # never an on-chain passport without a MINT (also for databases an earlier purge already left without one)
    for item in plan.get("mintFromChain", []):
        chain = plan["chainPassports"].get(item["serial"])
        if chain and conn.execute("SELECT 1 FROM passports WHERE serial=?", (item["serial"],)).fetchone():
            rebuilt = _rebuild_mint(conn, item["serial"], chain, item, ts)
            if rebuilt:
                res["mintFromChain"].append({"serial": item["serial"], **rebuilt})
                for u in res["passports"]["updated"]:
                    if u["serial"] == item["serial"]:
                        u.update(hasMint=True, issuer=rebuilt["issuer"])
    return res


@router.post("/api/admin/purge-seed", dependencies=[Depends(rate_limit)])
def purge_seed(dry_run: bool = True, db=Depends(get_db), settings: Settings = Depends(get_settings), rpc=Depends(get_rpc)):
    if not settings.program_id:
        raise HTTPException(503, "chain_not_configured")     # nothing is deleted without checking the chain first
    path = Path(settings.seed_path)
    if not path.exists():
        raise HTTPException(404, "seed file not found")
    seed = load_seed_index(path)
    with db.connect() as conn:
        try:
            plan = _plan(conn, settings, rpc, seed)
        except RpcError as exc:
            log.warning("purge-seed: chain read failed: %s", exc)
            raise HTTPException(503, "rpc_unavailable") from exc
        report = {"dryRun": dry_run, "seedFile": str(path), "events": {"delete": plan["delete"], "keep": plan["keep"]},
                  "replayedOnChain": plan["replayed"],
                  "chainAccounts": {"passports": sorted(s for s, c in plan["chainPassports"].items() if c),
                                    "seals": sorted(u for u, c in plan["chainSeals"].items() if c)},
                  "registryPartners": sorted(plan["partners"]) if plan["partners"] is not None else None,
                  "mintFromChain": plan["mintFromChain"]}
        if dry_run:
            return report
        with transaction(conn):
            # the plan was made without the write lock: only rows that still look exactly as planned are deleted
            still = {r["id"] for r in conn.execute(
                f"SELECT id FROM events WHERE id IN ({','.join('?' * len(plan['delete'])) or 'NULL'})",
                [d["id"] for d in plan["delete"]]).fetchall()}
            plan["delete"] = [d for d in plan["delete"] if d["id"] in still]
            report["applied"] = _apply(conn, settings, seed, plan, int(time.time()))
    log.warning("purge-seed applied: %s events, attesters %s, sim_tags %s, seals %s, passports %s", report["applied"]["events"],
                report["applied"]["attesters"], len(report["applied"]["simTags"]), report["applied"]["seals"]["deleted"],
                report["applied"]["passports"]["deleted"])
    return report
