-- FlaconVault verify — SQLite schema (briefing §10 plus what the server needs).
-- Hashes are stored as lowercase hex WITHOUT 0x. Timestamps are unix seconds (int).

CREATE TABLE IF NOT EXISTS passports (
  serial        TEXT PRIMARY KEY,
  serial_hash   TEXT NOT NULL UNIQUE,
  brand         TEXT NOT NULL,
  name          TEXT NOT NULL,
  batch         TEXT,
  asset         TEXT,                 -- Metaplex Core asset pubkey (base58) or NULL
  issuer        TEXT,                 -- partner pubkey (base58) or NULL
  issuer_label  TEXT,
  grade         INTEGER NOT NULL DEFAULT 0,
  void          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seals (
  uid_hash      TEXT PRIMARY KEY,
  uid_hex       TEXT NOT NULL UNIQUE, -- 14 hex chars, uppercase
  serial        TEXT NOT NULL REFERENCES passports(serial) ON DELETE CASCADE,
  kind          INTEGER NOT NULL,     -- seal_kind enum (0 BOX, 1 NECK)
  last_counter  INTEGER NOT NULL DEFAULT 0,
  dead          INTEGER NOT NULL DEFAULT 0,
  attached_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seals_serial ON seals(serial);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial        TEXT NOT NULL REFERENCES passports(serial) ON DELETE CASCADE,
  type          INTEGER NOT NULL,     -- event enum
  ts            INTEGER NOT NULL,
  actor_pubkey  TEXT,
  actor_label   TEXT,
  tx_sig        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','reported')),  -- reported: unverified SEAL_DEAD report (no effect)
  seal_uid_hash TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  ar_bundle     TEXT,
  ar_media      TEXT,
  grade_after   INTEGER,
  country       TEXT,
  city          TEXT,
  resume_hash   TEXT                  -- sha256 hex of the one-time resume token of a pending signed scan (GET /api/verify/{id})
);
CREATE INDEX IF NOT EXISTS events_serial_ts ON events(serial, ts);
CREATE INDEX IF NOT EXISTS events_actor ON events(actor_pubkey);

CREATE TABLE IF NOT EXISTS attesters (
  pubkey            TEXT PRIMARY KEY,
  first_seen        INTEGER NOT NULL,
  scan_count        INTEGER NOT NULL DEFAULT 0,
  certified_count   INTEGER NOT NULL DEFAULT 0,
  escrows_ok        INTEGER NOT NULL DEFAULT 0,
  escrows_disputed  INTEGER NOT NULL DEFAULT 0,
  agree_count       INTEGER NOT NULL DEFAULT 0,
  compare_count     INTEGER NOT NULL DEFAULT 0,
  label             TEXT,
  is_partner        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce_hex     TEXT PRIMARY KEY,     -- 64 hex chars
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  media_files   INTEGER NOT NULL DEFAULT 0   -- files uploaded to /api/media under this nonce (at most 6)
);

-- Every /t hit, every /api/verify tap and every simulator no-response; the web /t page reads these by id.
CREATE TABLE IF NOT EXISTS taps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  source        TEXT NOT NULL DEFAULT 't',   -- 't' | 'verify' | 'sim'
  uid_hex       TEXT,
  ctr           INTEGER,
  cmac          TEXT,
  verdict       TEXT NOT NULL,
  serial        TEXT,
  message       TEXT NOT NULL,
  adopt_hash    TEXT,                        -- sha256 hex of the one-time adoption token handed out by /t (VALID taps only)
  adopted_at    INTEGER                      -- set when /api/verify adopted the tap (once)
);
CREATE INDEX IF NOT EXISTS taps_uid ON taps(uid_hex, ctr);

-- Simulator only (FV_DEV_SIMULATOR=true).
CREATE TABLE IF NOT EXISTS sim_tags (
  uid_hex       TEXT PRIMARY KEY,
  key_hex       TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  alive         INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  serial        TEXT,
  last_url      TEXT
);

-- Uploaded seal frames: sha256 of the stored file → Arweave links (filled when FV_ARWEAVE=true).
CREATE TABLE IF NOT EXISTS media (
  sha256        TEXT PRIMARY KEY,     -- lowercase hex, no 0x
  bytes         INTEGER NOT NULL,
  files         INTEGER NOT NULL,
  content_type  TEXT,
  ar            TEXT,                 -- ar://<id> of the stored (concatenated) file
  url           TEXT,                 -- https gateway url of the same
  ar_preview    TEXT,                 -- https gateway url of a viewable image (first frame) or NULL
  created_at    INTEGER NOT NULL
);

-- Escrow Order accounts as last seen on chain by the reconcile job. One row per listing: a re-list on the same Order
-- PDA (after close_order) has a new listed_at, so finished orders keep counting for the escrow statistics.
CREATE TABLE IF NOT EXISTS escrow_orders (
  order_pda     TEXT NOT NULL,        -- escrow Order PDA (base58)
  listed_at     INTEGER NOT NULL,
  passport      TEXT NOT NULL,        -- flacon Passport PDA (base58)
  seller        TEXT NOT NULL,
  buyer         TEXT,                 -- NULL until reserved
  price         INTEGER NOT NULL,     -- USDC base units (6 dp)
  state         INTEGER NOT NULL,     -- ORDER_STATE_* (5 RELEASED, 7 DISPUTE, …)
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (order_pda, listed_at)
);
CREATE INDEX IF NOT EXISTS escrow_orders_seller ON escrow_orders(seller);
CREATE INDEX IF NOT EXISTS escrow_orders_buyer ON escrow_orders(buyer);

-- Arweave archiving queue (reconcile backfill): per confirmed SCAN, failed attempts and when to try again, so one row
-- that keeps failing (e.g. media the Irys balance cannot pay for) never blocks the bundles of the others. done = nothing
-- left to archive (bundle uploaded, media uploaded or not available). No row = never tried.
CREATE TABLE IF NOT EXISTS arweave_queue (
  event_id      INTEGER PRIMARY KEY,  -- events.id (AUTOINCREMENT: never reused)
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_at       INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,                 -- error code of the last failed upload (insufficient_balance, timeout, …)
  updated_at    INTEGER NOT NULL
);

-- Decoded chain state cached by the reconcile job (key 'registry': authority, server keys, partners, sites).
CREATE TABLE IF NOT EXISTS chain_state (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Public-record relay (docs/public-record.md §9.3): one row per FVSCAN2 the relayer may send. The message is built and
-- signed once, when the row is created (D13). The partial unique index is the idempotency guarantee: at most one live
-- row per (seal, counter). `lamports`: while `sending` the fee estimate charged to relay_budget, once terminal the fee
-- actually paid (meta.fee). Added by CREATE TABLE IF NOT EXISTS, so an older database gains the tables on start.
CREATE TABLE IF NOT EXISTS relay_tx (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'scan',     -- 'scan' (P1); later 'holding', 'claim'
  ref           TEXT NOT NULL,                    -- idempotency key; kind 'scan': '<seal uid_hash hex>:<counter>'
  event_id      INTEGER REFERENCES events(id) ON DELETE SET NULL,   -- the SCAN event this row records
  seal_uid_hash TEXT NOT NULL,
  counter       INTEGER NOT NULL,
  purpose       INTEGER NOT NULL,                 -- purpose enum
  actor_kind    INTEGER NOT NULL,                 -- actor_kind enum
  msg_hex       TEXT,                             -- FVSCAN2 (256 bytes)
  server_sig    TEXT,                             -- hex, Ed25519 over msg
  key_id        INTEGER,
  server_pubkey TEXT,                             -- hex, the scan key that signed msg (sent in the Ed25519 instruction)
  bundle_json   TEXT,                             -- canonical v2 bundle
  due_at        INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,                 -- msg ts + 570
  status        TEXT NOT NULL CHECK (status IN ('queued','sending','recorded','over_cap','failed','replaced')),
  reason        TEXT,                             -- §9.6
  sig           TEXT,                             -- tx signature of the current attempt; the landed one once recorded
  last_valid_height INTEGER,                      -- lastValidBlockHeight of the current attempt
  attempts      INTEGER NOT NULL DEFAULT 0,
  lamports      INTEGER NOT NULL DEFAULT 0,       -- fee actually paid (meta.fee); the charged estimate while sending
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS relay_tx_live_ref ON relay_tx(kind, ref) WHERE status IN ('queued','sending','recorded');
CREATE INDEX IF NOT EXISTS relay_tx_seal ON relay_tx(seal_uid_hash, created_at);
CREATE INDEX IF NOT EXISTS relay_tx_due ON relay_tx(status, due_at);
CREATE TABLE IF NOT EXISTS relay_budget (day TEXT PRIMARY KEY, lamports INTEGER NOT NULL DEFAULT 0);  -- 'YYYY-MM-DD' UTC
