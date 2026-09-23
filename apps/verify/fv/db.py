"""
SQLite (stdlib sqlite3, WAL) + thin repository functions. One short-lived connection per
request via Database.connect(); write flows wrap their checks in `transaction()` (BEGIN IMMEDIATE)
so counter/nonce updates are atomic.
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
TABLES = ("passports", "seals", "events", "attesters", "nonces", "taps", "sim_tags")


def now() -> int:
    return int(time.time())


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

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
    conn.execute("UPDATE passports SET grade=? WHERE serial=? AND void=0", (grade, serial))


def void_passport(conn, serial: str, grade_void: int) -> None:
    conn.execute("UPDATE passports SET void=1, grade=? WHERE serial=?", (grade_void, serial))


def list_passports(conn) -> list[dict]:
    return _rows(conn.execute(
        """SELECT p.serial, p.brand, p.name, p.grade, p.void,
                  (SELECT COUNT(*) FROM events e WHERE e.serial=p.serial AND e.type=2 AND e.status!='failed') AS scan_count,
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


def confirm_event(conn, event_id: int, tx_sig: str | None, status: str = "confirmed") -> dict | None:
    conn.execute("UPDATE events SET tx_sig=COALESCE(?, tx_sig), status=? WHERE id=?", (tx_sig, status, event_id))
    return get_event(conn, event_id)


def events_for(conn, serial: str) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM events WHERE serial=? ORDER BY ts ASC, id ASC", (serial,)).fetchall())


def latest_scan_with_indicators(conn, serial: str) -> dict | None:
    """Most recent SCAN event (tier ≥ 1, i.e. one that carries a bundle), not failed."""
    for r in conn.execute("SELECT * FROM events WHERE serial=? AND type=2 AND status!='failed' ORDER BY ts DESC, id DESC",
                          (serial,)).fetchall():
        payload = json.loads(r["payload_json"] or "{}")
        if "indicators" in payload:
            return dict(r)
    return None


def previous_scan_before(conn, serial: str, before_id: int) -> dict | None:
    for r in conn.execute("SELECT * FROM events WHERE serial=? AND type=2 AND id<? AND status!='failed' ORDER BY id DESC",
                          (serial, before_id)).fetchall():
        payload = json.loads(r["payload_json"] or "{}")
        if "indicators" in payload:
            return dict(r)
    return None


def passport_stats(conn, serial: str) -> dict:
    r = conn.execute(
        """SELECT COUNT(*) AS scan_count,
                  COUNT(DISTINCT actor_pubkey) AS attester_count,
                  SUM(CASE WHEN json_extract(payload_json, '$.attester.tier') >= 3
                            OR json_extract(payload_json, '$.tier') >= 3 THEN 1 ELSE 0 END) AS certified_count
           FROM events WHERE serial=? AND type=2 AND status!='failed'""", (serial,)).fetchone()
    return {"scanCount": int(r["scan_count"] or 0), "attesterCount": int(r["attester_count"] or 0),
            "certifiedCount": int(r["certified_count"] or 0)}


def has_event_type(conn, serial: str, type: int) -> bool:
    return conn.execute("SELECT 1 FROM events WHERE serial=? AND type=? LIMIT 1", (serial, type)).fetchone() is not None


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
               serial: str | None, message: str) -> dict:
    cur = conn.execute("INSERT INTO taps(ts, source, uid_hex, ctr, cmac, verdict, serial, message) VALUES(?,?,?,?,?,?,?,?)",
                       (ts, source, uid_hex.upper() if uid_hex else None, ctr, cmac.upper() if cmac else None, verdict, serial, message))
    return get_tap(conn, cur.lastrowid)  # type: ignore[return-value]


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
           ON CONFLICT(uid_hex) DO UPDATE SET serial=COALESCE(excluded.serial, sim_tags.serial)""",
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
