//! Constants shared with `packages/proof` (single source of truth) and mirrored
//! into `docs/enums.json` / `docs/vectors.json`. Every value here is exposed in
//! the IDL via `#[constant]`; `tests/flacon.ts` compares them with the JSON.

use anchor_lang::prelude::*;

// ---- PDA seeds (vectors.constants.PDA_SEEDS) -------------------------------

#[constant]
pub const REGISTRY_SEED: &[u8] = b"registry";
#[constant]
pub const PASSPORT_SEED: &[u8] = b"passport";
#[constant]
pub const SEAL_SEED: &[u8] = b"seal";
#[constant]
pub const SCAN_SEED: &[u8] = b"scan";
/// Reserved for the `Origin` account (`["origin", passport]`, briefing §6).
/// Deliberately not implemented in the hackathon build.
#[constant]
pub const ORIGIN_SEED: &[u8] = b"origin";

// ---- Signature message (briefing §4.3) --------------------------------------

#[constant]
pub const MSG_PREFIX: &[u8] = b"FVSCAN1";
/// Total length of the server-signed message in bytes.
#[constant]
pub const MSG_LEN: u16 = 152;
pub const MSG_LEN_BYTES: usize = MSG_LEN as usize;

// ---- Capacities --------------------------------------------------------------

#[constant]
pub const MAX_SERVER_KEYS: u8 = 8;
#[constant]
pub const MAX_PARTNERS: u8 = 16;
#[constant]
pub const MAX_SITES: u8 = 16;

// ---- Enums (u8) — docs/enums.json ------------------------------------------

// tamper
#[constant]
pub const TAMPER_CLOSED: u8 = 0;
#[constant]
pub const TAMPER_OPENED_NOW: u8 = 1;
#[constant]
pub const TAMPER_OPENED_BEFORE: u8 = 2;
#[constant]
pub const TAMPER_UNKNOWN: u8 = 3;

// indicator
#[constant]
pub const INDICATOR_INTACT: u8 = 0;
#[constant]
pub const INDICATOR_TRIGGERED: u8 = 1;
#[constant]
pub const INDICATOR_UNREADABLE: u8 = 2;
#[constant]
pub const INDICATOR_MISSING: u8 = 3;

// tier
#[constant]
pub const TIER_SIGHTING: u8 = 0;
#[constant]
pub const TIER_SELF: u8 = 1;
#[constant]
pub const TIER_SELF_MEDIA: u8 = 2;
#[constant]
pub const TIER_CERTIFIED: u8 = 3;
#[constant]
pub const TIER_BIRTH: u8 = 4;

// role
#[constant]
pub const ROLE_OWNER: u8 = 0;
#[constant]
pub const ROLE_SELLER: u8 = 1;
#[constant]
pub const ROLE_BUYER: u8 = 2;
#[constant]
pub const ROLE_VAULT: u8 = 3;
#[constant]
pub const ROLE_PARTNER: u8 = 4;

// grade
#[constant]
pub const GRADE_A: u8 = 0;
#[constant]
pub const GRADE_B: u8 = 1;
#[constant]
pub const GRADE_C: u8 = 2;
#[constant]
pub const GRADE_D: u8 = 3;
#[constant]
pub const GRADE_VOID: u8 = 4;

// seal_kind (2 = LOOP is reserved for the optional 213 TT upgrade, briefing §13)
#[constant]
pub const SEAL_KIND_BOX: u8 = 0;
#[constant]
pub const SEAL_KIND_NECK: u8 = 1;

// event (off-chain timeline event types; mirrored for completeness)
#[constant]
pub const EVENT_MINT: u8 = 0;
#[constant]
pub const EVENT_SEAL_ATTACH: u8 = 1;
#[constant]
pub const EVENT_SCAN: u8 = 2;
#[constant]
pub const EVENT_LIST: u8 = 3;
#[constant]
pub const EVENT_RESERVE: u8 = 4;
#[constant]
pub const EVENT_SHIP: u8 = 5;
#[constant]
pub const EVENT_RECEIVE: u8 = 6;
#[constant]
pub const EVENT_RELEASE: u8 = 7;
#[constant]
pub const EVENT_DISPUTE: u8 = 8;
#[constant]
pub const EVENT_SEAL_DEAD: u8 = 9;

// ---- Misc bounds -------------------------------------------------------------

/// Highest valid indicator / tamper code.
pub const MAX_INDICATOR: u8 = 3;
/// Highest valid tier and role code.
pub const MAX_TIER: u8 = 4;
pub const MAX_ROLE: u8 = 4;
/// `heat_levels` is a 6-bit mask (bit i = Thermax field i; bit 4 = the 40 °C field).
pub const HEAT_LEVELS_BITS: u8 = 6;
/// Index of the decisive heat field (vectors.constants.HEAT_DECISIVE_INDEX).
#[constant]
pub const HEAT_DECISIVE_INDEX: u8 = 4;
pub const MAX_FILL: u8 = 100;
