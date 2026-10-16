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
  city          TEXT
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
  used_at       INTEGER
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

-- Decoded chain state cached by the reconcile job (key 'registry': authority, server keys, partners, sites).
CREATE TABLE IF NOT EXISTS chain_state (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
