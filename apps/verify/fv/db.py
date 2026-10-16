"""
SQLite (stdlib sqlite3, WAL) + thin repository functions. One short-lived connection per
request via Database.connect(); write flows wrap their checks in `transaction()` (BEGIN IMMEDIATE)
so counter/nonce updates are atomic.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
TABLES = ("passports", "seals", "events", "attesters", "nonces", "taps", "sim_tags", "media", "escrow_orders", "chain_state")
GRADE_VOID = 4          # enums.json grade.VOID
ORDER_RELEASED, ORDER_DISPUTE = 5, 7   # escrow ORDER_STATE_*


def now() -> int:
    return int(time.time())


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            schema = SCHEMA_PATH.read_text(encoding="utf-8")
            conn.executescript(schema)
            migrate(conn, schema)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, isolation_level=None, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def wipe(self) -> None:
        with self.connect() as conn:
            for t in TABLES:
                conn.execute(f"DROP TABLE IF EXISTS {t}")
        self.init()

    def is_empty(self) -> bool:
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM passports").fetchone()[0] == 0


def migrate(conn: sqlite3.Connection, schema: str) -> None:
    """
    Bring a database created by an older schema.sql up to date (CREATE TABLE IF NOT EXISTS never alters a table):
      * taps.adopt_hash / taps.adopted_at (one-time /t adoption tokens),
      * events.status CHECK constraint gains 'reported' — SQLite cannot alter a CHECK, so the table is rebuilt.
    Idempotent; a no-op on a fresh database.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(taps)").fetchall()}
    for col, decl in (("adopt_hash", "TEXT"), ("adopted_at", "INTEGER")):
        if col not in cols:
            conn.execute(f"ALTER TABLE taps ADD COLUMN {col} {decl}")
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").fetchone()
    if row and "'reported'" not in row["sql"]:
        m = re.search(r"CREATE TABLE IF NOT EXISTS events \((.*?)\n\);", schema, re.S)
        if not m:
            raise RuntimeError("schema.sql: events table definition not found")
        old_cols = [r["name"] for r in conn.execute("PRAGMA table_info(events)").fetchall()]
        cols_sql = ", ".join(old_cols)
        conn.execute("BEGIN IMMEDIATE")
        try:
            seq = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='events'").fetchone()
            conn.execute(f"CREATE TABLE events_new ({m.group(1)}\n)")
            conn.execute(f"INSERT INTO events_new({cols_sql}) SELECT {cols_sql} FROM events")
            conn.execute("DROP TABLE events")
            conn.execute("ALTER TABLE events_new RENAME TO events")
            conn.execute("CREATE INDEX IF NOT EXISTS events_serial_ts ON events(serial, ts)")
            conn.execute("CREATE INDEX IF NOT EXISTS events_actor ON events(actor_pubkey)")
            if seq is not None:
                conn.execute("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='events'", (seq[0],))
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


def _rows(rs: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rs]


# ---------- passports ----------

def get_passport(conn, serial: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM passports WHERE serial=?", (serial,)).fetchone())


def upsert_passport(conn, *, serial: str, serial_hash: str, brand: str, name: str, batch: str | None,
                    asset: str | None, issuer: str | None, issuer_label: str | None, grade: int, void: bool,
                    created_at: int) -> dict:
    conn.execute(
        """INSERT INTO passports(serial, serial_hash, brand, name, batch, asset, issuer, issuer_label, grade, void, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(serial) DO UPDATE SET brand=excluded.brand, name=excluded.name, batch=excluded.batch,
             asset=COALESCE(excluded.asset, passports.asset), issuer=COALESCE(excluded.issuer, passports.issuer),
             issuer_label=COALESCE(excluded.issuer_label, passports.issuer_label)""",
        (serial, serial_hash, brand, name, batch, asset, issuer, issuer_label, grade, int(void), created_at))
    return get_passport(conn, serial)  # type: ignore[return-value]


def set_passport_grade(conn, serial: str, grade: int) -> None:
    """
    Apply a confirmed scan's grade. The off-chain grade only ever gets worse (A=0 … D=3, VOID=4): a heat-triggered C or
    an opened (VOID) bottle is never reset by a later, better-looking scan. A VOID grade also sets the sticky void flag.
    """
    grade = int(grade)
    conn.execute("UPDATE passports SET grade=MAX(grade, ?), void=MAX(void, ?) WHERE serial=?",
                 (grade, 1 if grade >= GRADE_VOID else 0, serial))


def void_passport(conn, serial: str, grade_void: int) -> None:
    conn.execute("UPDATE passports SET void=1, grade=? WHERE serial=?", (grade_void, serial))


def list_passports(conn) -> list[dict]:
    return _rows(conn.execute(
        """SELECT p.serial, p.brand, p.name, p.grade, p.void,
                  (SELECT COUNT(*) FROM events e WHERE e.serial=p.serial AND e.type=2 AND e.status='confirmed') AS scan_count,
                  (SELECT MAX(ts) FROM events e WHERE e.serial=p.serial) AS last_event_ts
           FROM passports p ORDER BY p.serial""").fetchall())


# ---------- seals ----------

def get_seal_by_uid(conn, uid_hex: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM seals WHERE uid_hex=?", (uid_hex.upper(),)).fetchone())


def get_seal_by_hash(conn, uid_hash: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM seals WHERE uid_hash=?", (uid_hash.lower(),)).fetchone())


def seals_for(conn, serial: str) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM seals WHERE serial=? ORDER BY attached_at", (serial,)).fetchall())


def upsert_seal(conn, *, uid_hash: str, uid_hex: str, serial: str, kind: int, last_counter: int = 0,
                dead: bool = False, attached_at: int) -> dict:
    """
    Create/update a seal. The counter is seeded with the highest counter of any CMAC-valid tap already seen for this
    uid (taken while it was unregistered), so a SUN URL captured before the attach can never be replayed afterwards.
    """
    last_counter = max(int(last_counter), last_counter_unregistered(conn, uid_hex))
    conn.execute(
        """INSERT INTO seals(uid_hash, uid_hex, serial, kind, last_counter, dead, attached_at) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(uid_hash) DO UPDATE SET serial=excluded.serial, kind=excluded.kind,
             dead=MAX(seals.dead, excluded.dead), last_counter=MAX(seals.last_counter, excluded.last_counter)""",
        (uid_hash.lower(), uid_hex.upper(), serial, kind, last_counter, int(dead), attached_at))
    return get_seal_by_hash(conn, uid_hash)  # type: ignore[return-value]


def advance_seal_counter(conn, uid_hash: str, counter: int) -> None:
    conn.execute("UPDATE seals SET last_counter=? WHERE uid_hash=? AND last_counter<?", (counter, uid_hash.lower(), counter))


def mark_seal_dead(conn, uid_hash: str) -> None:
    conn.execute("UPDATE seals SET dead=1 WHERE uid_hash=?", (uid_hash.lower(),))


def last_counter_unregistered(conn, uid_hex: str) -> int:
    """Replay memory for uids without a seal row: highest counter of a CMAC-valid tap seen so far."""
    r = conn.execute("SELECT MAX(ctr) FROM taps WHERE uid_hex=? AND verdict IN ('VALID','UNREGISTERED')",
                     (uid_hex.upper(),)).fetchone()
    return int(r[0] or 0)


# ---------- events ----------

def insert_event(conn, *, serial: str, type: int, ts: int, actor_pubkey: str | None, actor_label: str | None,
                 tx_sig: str | None, status: str, seal_uid_hash: str | None, payload: dict, ar_bundle: str | None = None,
                 ar_media: str | None = None, grade_after: int | None, country: str | None, city: str | None) -> dict:
    cur = conn.execute(
        """INSERT INTO events(serial, type, ts, actor_pubkey, actor_label, tx_sig, status, seal_uid_hash, payload_json,
                              ar_bundle, ar_media, grade_after, country, city)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (serial, type, ts, actor_pubkey, actor_label, tx_sig, status, seal_uid_hash.lower() if seal_uid_hash else None,
         json.dumps(payload, ensure_ascii=False, sort_keys=True), ar_bundle, ar_media, grade_after, country, city))
    return get_event(conn, cur.lastrowid)  # type: ignore[return-value]


def get_event(conn, event_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone())


def events_for(conn, serial: str) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM events WHERE serial=? ORDER BY ts ASC, id ASC", (serial,)).fetchall())


MISSING_INDICATOR = 3   # enums.json indicator.MISSING


def _reads_indicators(payload: dict) -> bool:
    ind = payload.get("indicators")
    if not isinstance(ind, dict):
        return False
    return ind.get("heat", MISSING_INDICATOR) != MISSING_INDICATOR or ind.get("humidity", MISSING_INDICATOR) != MISSING_INDICATOR


def latest_scan_with_indicators(conn, serial: str) -> dict | None:
    """
    Latest *confirmed* SCAN that actually read an indicator (heat or humidity not MISSING) — the passport header.
    Pending/failed scans and no-photo scans (both indicators MISSING) never blank or overwrite it.
    """
    for r in conn.execute("SELECT * FROM events WHERE serial=? AND type=2 AND status='confirmed' ORDER BY ts DESC, id DESC",
                          (serial,)).fetchall():
        if _reads_indicators(json.loads(r["payload_json"] or "{}")):
            return dict(r)
    return None


def previous_scan_before(conn, serial: str, before_id: int) -> dict | None:
    """The confirmed bundle-carrying SCAN right before `before_id` (attester agreement statistics)."""
    for r in conn.execute("SELECT * FROM events WHERE serial=? AND type=2 AND id<? AND status='confirmed' ORDER BY id DESC",
                          (serial, before_id)).fetchall():
        payload = json.loads(r["payload_json"] or "{}")
        if "indicators" in payload:
            return dict(r)
    return None


def newer_confirmed_scan_exists(conn, serial: str, event_id: int, ts: int) -> bool:
    """True if a confirmed bundle-carrying SCAN newer than (ts, event_id) exists — its grade then stays authoritative."""
    for r in conn.execute("""SELECT payload_json FROM events WHERE serial=? AND type=2 AND status='confirmed' AND id!=?
                             AND (ts>? OR (ts=? AND id>?))""", (serial, event_id, ts, ts, event_id)).fetchall():
        if "indicators" in json.loads(r["payload_json"] or "{}"):
            return True
    return False


# tier of a confirmed SCAN: the on-chain ScanProof tier (payload.chain, written on confirmation) wins over the claim
_SCAN_TIER = ("COALESCE(json_extract(payload_json, '$.chain.tier'), json_extract(payload_json, '$.attester.tier'), "
              "json_extract(payload_json, '$.tier'), 0)")
# a SCAN the program counted in passport.scan_count: a bundle scan (Tier-0 /t sightings never go on chain) backed by
# its record_scan tx or by the ScanProof PDA the reconcile job found; seeded demo rows are never on chain
_ON_CHAIN_SCAN = ("json_extract(payload_json, '$.indicators') IS NOT NULL AND COALESCE(json_extract(payload_json, '$.seed'), 0) = 0 "
                  "AND (tx_sig IS NOT NULL OR json_extract(payload_json, '$.reconcile.scanPda') IS NOT NULL)")


def passport_stats(conn, serial: str) -> dict:
    """
    Scan statistics from *confirmed* SCAN events only (pending scans and their claimed attesters never count).
    onChainScanCount is the number the program's passport.scan_count should equal ('Check live on-chain').
    """
    r = conn.execute(
        f"""SELECT COUNT(*) AS scan_count,
                  COUNT(DISTINCT actor_pubkey) AS attester_count,
                  SUM(CASE WHEN {_SCAN_TIER} >= 3 THEN 1 ELSE 0 END) AS certified_count,
                  SUM(CASE WHEN {_ON_CHAIN_SCAN} THEN 1 ELSE 0 END) AS on_chain_count
           FROM events WHERE serial=? AND type=2 AND status='confirmed'""", (serial,)).fetchone()
    return {"scanCount": int(r["scan_count"] or 0), "attesterCount": int(r["attester_count"] or 0),
            "certifiedCount": int(r["certified_count"] or 0), "onChainScanCount": int(r["on_chain_count"] or 0)}


def has_event_type(conn, serial: str, type: int, *, status: str | None = None) -> bool:
    if status is None:
        return conn.execute("SELECT 1 FROM events WHERE serial=? AND type=? LIMIT 1", (serial, type)).fetchone() is not None
    return conn.execute("SELECT 1 FROM events WHERE serial=? AND type=? AND status=? LIMIT 1", (serial, type, status)).fetchone() is not None


def event_actors(conn, serial: str, type: int) -> list[str]:
    """Distinct actor pubkeys of the events of one type for a serial (e.g. the sellers that listed it)."""
    return [r[0] for r in conn.execute("SELECT DISTINCT actor_pubkey FROM events WHERE serial=? AND type=? AND actor_pubkey IS NOT NULL",
                                       (serial, type)).fetchall()]


# ---------- attesters ----------

def get_attester(conn, pubkey: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM attesters WHERE pubkey=?", (pubkey,)).fetchone())


def upsert_attester(conn, *, pubkey: str, first_seen: int, label: str | None = None, is_partner: bool | None = None,
                    **counts: int) -> dict:
    conn.execute("INSERT INTO attesters(pubkey, first_seen) VALUES(?,?) ON CONFLICT(pubkey) DO NOTHING", (pubkey, first_seen))
    if label is not None:
        conn.execute("UPDATE attesters SET label=? WHERE pubkey=?", (label, pubkey))
    if is_partner is not None:
        conn.execute("UPDATE attesters SET is_partner=? WHERE pubkey=?", (int(is_partner), pubkey))
    for col, v in counts.items():
        if col not in ("scan_count", "certified_count", "escrows_ok", "escrows_disputed", "agree_count", "compare_count"):
            raise ValueError(col)
        conn.execute(f"UPDATE attesters SET {col}=? WHERE pubkey=?", (int(v), pubkey))
    return get_attester(conn, pubkey)  # type: ignore[return-value]


def bump_attester(conn, pubkey: str, ts: int, *, scans: int = 0, certified: int = 0, agree: int = 0, compare: int = 0) -> None:
    conn.execute("INSERT INTO attesters(pubkey, first_seen) VALUES(?,?) ON CONFLICT(pubkey) DO NOTHING", (pubkey, ts))
    conn.execute("""UPDATE attesters SET scan_count=scan_count+?, certified_count=certified_count+?,
                    agree_count=agree_count+?, compare_count=compare_count+? WHERE pubkey=?""",
                 (scans, certified, agree, compare, pubkey))


def recent_serials_for(conn, pubkey: str, limit: int = 10) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT serial FROM events WHERE actor_pubkey=? GROUP BY serial ORDER BY MAX(ts) DESC LIMIT ?", (pubkey, limit)).fetchall()]


# ---------- nonces ----------

def insert_nonce(conn, nonce_hex: str, issued_at: int, expires_at: int) -> None:
    conn.execute("INSERT INTO nonces(nonce_hex, issued_at, expires_at) VALUES(?,?,?)", (nonce_hex.lower(), issued_at, expires_at))


def get_nonce(conn, nonce_hex: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM nonces WHERE nonce_hex=?", (nonce_hex.lower(),)).fetchone())


def consume_nonce(conn, nonce_hex: str, used_at: int) -> None:
    conn.execute("UPDATE nonces SET used_at=? WHERE nonce_hex=?", (used_at, nonce_hex.lower()))


def purge_nonces(conn, before: int) -> None:
    conn.execute("DELETE FROM nonces WHERE expires_at < ? AND (used_at IS NOT NULL OR expires_at < ?)", (before, before - 3600))


# ---------- taps ----------

def insert_tap(conn, *, ts: int, source: str, uid_hex: str | None, ctr: int | None, cmac: str | None, verdict: str,
               serial: str | None, message: str, adopt_hash: str | None = None) -> dict:
    cur = conn.execute("INSERT INTO taps(ts, source, uid_hex, ctr, cmac, verdict, serial, message, adopt_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                       (ts, source, uid_hex.upper() if uid_hex else None, ctr, cmac.upper() if cmac else None, verdict, serial,
                        message, adopt_hash))
    return get_tap(conn, cur.lastrowid)  # type: ignore[return-value]


def mark_tap_adopted(conn, tap_id: int, ts: int) -> bool:
    """Atomically claim a tap for adoption; False if it was already adopted (single use)."""
    return conn.execute("UPDATE taps SET adopted_at=? WHERE id=? AND adopted_at IS NULL", (ts, tap_id)).rowcount == 1


def get_tap(conn, tap_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM taps WHERE id=?", (tap_id,)).fetchone())


# ---------- simulator ----------

def get_sim_tag(conn, uid_hex: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM sim_tags WHERE uid_hex=?", (uid_hex.upper(),)).fetchone())


def list_sim_tags(conn) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM sim_tags ORDER BY created_at, uid_hex").fetchall())


def upsert_sim_tag(conn, *, uid_hex: str, key_hex: str, counter: int, alive: bool, created_at: int, serial: str | None) -> dict:
    conn.execute(
        """INSERT INTO sim_tags(uid_hex, key_hex, counter, alive, created_at, serial) VALUES(?,?,?,?,?,?)
           ON CONFLICT(uid_hex) DO UPDATE SET serial=COALESCE(excluded.serial, sim_tags.serial), key_hex=excluded.key_hex""",
        (uid_hex.upper(), key_hex, counter, int(alive), created_at, serial))
    return get_sim_tag(conn, uid_hex)  # type: ignore[return-value]


def update_sim_tag(conn, uid_hex: str, **fields: Any) -> dict | None:
    allowed = {"counter", "alive", "serial", "last_url", "key_hex"}
    for k in fields:
        if k not in allowed:
            raise ValueError(k)
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE sim_tags SET {sets} WHERE uid_hex=?", (*[int(v) if isinstance(v, bool) else v for v in fields.values()], uid_hex.upper()))
    return get_sim_tag(conn, uid_hex)


# ---------- reconcile / registry helpers ----------

def pending_scan_events(conn) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM events WHERE type=2 AND status='pending' AND seal_uid_hash IS NOT NULL ORDER BY id").fetchall())


def set_event_status(conn, event_id: int, status: str, tx_sig: str | None) -> None:
    conn.execute("UPDATE events SET status=?, tx_sig=COALESCE(tx_sig, ?) WHERE id=?", (status, tx_sig, event_id))


def update_event_payload(conn, event_id: int, payload: dict) -> None:
    conn.execute("UPDATE events SET payload_json=? WHERE id=?", (json.dumps(payload, ensure_ascii=False, sort_keys=True), event_id))


def has_pending_events(conn, serial: str) -> bool:
    return conn.execute("SELECT 1 FROM events WHERE serial=? AND status='pending' LIMIT 1", (serial,)).fetchone() is not None


def all_passports(conn) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM passports ORDER BY serial").fetchall())


def all_seals(conn) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM seals ORDER BY attached_at").fetchall())


def find_event(conn, serial: str, type: int, seal_uid_hash: str | None = None) -> dict | None:
    if seal_uid_hash:
        r = conn.execute("SELECT * FROM events WHERE serial=? AND type=? AND seal_uid_hash=? ORDER BY id LIMIT 1",
                         (serial, type, seal_uid_hash.lower())).fetchone()
    else:
        r = conn.execute("SELECT * FROM events WHERE serial=? AND type=? ORDER BY id LIMIT 1", (serial, type)).fetchone()
    return _row(r)


def partner_pubkeys(conn) -> list[str]:
    return [r[0] for r in conn.execute("SELECT pubkey FROM attesters WHERE is_partner=1 ORDER BY first_seen").fetchall()]


def scan_events_to_reconcile(conn, failed_since: int) -> list[dict]:
    """
    SCAN events the reconcile job checks against their ScanProof PDA: every pending one, plus failed ones newer than
    `failed_since` — a signed scan stays anchorable in the web app, so a ScanProof may still appear after the timeout.
    """
    return _rows(conn.execute(
        """SELECT * FROM events WHERE type=2 AND seal_uid_hash IS NOT NULL AND json_extract(payload_json, '$.counter') IS NOT NULL
             AND (status='pending' OR (status='failed' AND ts>=?)) ORDER BY id""", (failed_since,)).fetchall())


def stale_pending_events(conn, before: int) -> list[dict]:
    """Pending events that no ScanProof can ever confirm (other types, or a SCAN without seal/counter), older than `before`."""
    return _rows(conn.execute(
        """SELECT * FROM events WHERE status='pending' AND ts<?
             AND NOT (type=2 AND seal_uid_hash IS NOT NULL AND json_extract(payload_json, '$.counter') IS NOT NULL)
           ORDER BY id""", (before,)).fetchall())


def sync_registry_partners(conn, partners: list[str], ts: int) -> int:
    """is_partner follows the on-chain registry: partners get a row (if new) and the flag, everybody else loses it."""
    for pk in partners:
        conn.execute("INSERT INTO attesters(pubkey, first_seen) VALUES(?,?) ON CONFLICT(pubkey) DO NOTHING", (pk, ts))
    marks = ",".join("?" * len(partners)) or "NULL"
    cur = conn.execute(f"UPDATE attesters SET is_partner=CASE WHEN pubkey IN ({marks}) THEN 1 ELSE 0 END "
                       f"WHERE is_partner != CASE WHEN pubkey IN ({marks}) THEN 1 ELSE 0 END", (*partners, *partners))
    return cur.rowcount


def upsert_escrow_order(conn, order_pda: str, o: dict, ts: int) -> None:
    conn.execute(
        """INSERT INTO escrow_orders(order_pda, listed_at, passport, seller, buyer, price, state, updated_at) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(order_pda, listed_at) DO UPDATE SET buyer=excluded.buyer, price=excluded.price, state=excluded.state,
             updated_at=excluded.updated_at
           WHERE escrow_orders.state != excluded.state OR COALESCE(escrow_orders.buyer, '') != COALESCE(excluded.buyer, '')
             OR escrow_orders.price != excluded.price""",
        (order_pda, int(o["listedAt"]), o["passport"], o["seller"], o["buyer"], int(o["price"]), int(o["state"]), ts))


def sync_escrow_counters(conn, ts: int) -> int:
    """
    attesters.escrows_ok / escrows_disputed from the on-chain orders: RELEASED counts as an escrow without dispute and
    DISPUTE as a disputed one, for seller and buyer alike. Every order participant gets an attester row.
    """
    conn.execute("""INSERT INTO attesters(pubkey, first_seen)
                    SELECT pk, MIN(t) FROM (SELECT seller AS pk, listed_at AS t FROM escrow_orders
                                            UNION ALL SELECT buyer, listed_at FROM escrow_orders WHERE buyer IS NOT NULL)
                    GROUP BY pk ON CONFLICT(pubkey) DO NOTHING""")
    cur = conn.execute(
        """UPDATE attesters SET
             escrows_ok=(SELECT COUNT(*) FROM escrow_orders o WHERE o.state=? AND (o.seller=attesters.pubkey OR o.buyer=attesters.pubkey)),
             escrows_disputed=(SELECT COUNT(*) FROM escrow_orders o WHERE o.state=? AND (o.seller=attesters.pubkey OR o.buyer=attesters.pubkey))
           WHERE escrows_ok != (SELECT COUNT(*) FROM escrow_orders o WHERE o.state=? AND (o.seller=attesters.pubkey OR o.buyer=attesters.pubkey))
              OR escrows_disputed != (SELECT COUNT(*) FROM escrow_orders o WHERE o.state=? AND (o.seller=attesters.pubkey OR o.buyer=attesters.pubkey))""",
        (ORDER_RELEASED, ORDER_DISPUTE, ORDER_RELEASED, ORDER_DISPUTE))
    return cur.rowcount


def get_chain_state(conn, key: str) -> dict | None:
    r = conn.execute("SELECT value_json, updated_at FROM chain_state WHERE key=?", (key,)).fetchone()
    return {"value": json.loads(r["value_json"]), "updatedAt": r["updated_at"]} if r else None


def set_chain_state(conn, key: str, value: Any, ts: int) -> None:
    conn.execute("""INSERT INTO chain_state(key, value_json, updated_at) VALUES(?,?,?)
                    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at""",
                 (key, json.dumps(value, ensure_ascii=False, sort_keys=True), ts))


# ---------- media / arweave ----------

def get_media(conn, sha256_hex: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM media WHERE sha256=?", (sha256_hex.lower(),)).fetchone())


def upsert_media(conn, *, sha256_hex: str, bytes_: int, files: int, content_type: str | None, ar: str | None, url: str | None,
                 ar_preview: str | None, created_at: int) -> dict:
    conn.execute(
        """INSERT INTO media(sha256, bytes, files, content_type, ar, url, ar_preview, created_at) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(sha256) DO UPDATE SET ar=COALESCE(excluded.ar, media.ar), url=COALESCE(excluded.url, media.url),
             ar_preview=COALESCE(excluded.ar_preview, media.ar_preview), content_type=COALESCE(excluded.content_type, media.content_type)""",
        (sha256_hex.lower(), bytes_, files, content_type, ar, url, ar_preview, created_at))
    return get_media(conn, sha256_hex)  # type: ignore[return-value]


def set_event_arweave(conn, event_id: int, ar_bundle: str | None, ar_media: str | None) -> None:
    conn.execute("UPDATE events SET ar_bundle=COALESCE(?, ar_bundle), ar_media=COALESCE(?, ar_media) WHERE id=?", (ar_bundle, ar_media, event_id))
