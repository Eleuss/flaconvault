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
/// `["holder_config"]`: the singleton HolderConfig (docs/public-record.md §6.1).
#[constant]
pub const HOLDER_CONFIG_SEED: &[u8] = b"holder_config";
/// `["holding", passport]`: one Holding per passport (docs/public-record.md §6.2).
#[constant]
pub const HOLDING_SEED: &[u8] = b"holding";

// ---- Signature message (briefing §4.3) --------------------------------------

#[constant]
pub const MSG_PREFIX: &[u8] = b"FVSCAN1";
/// Total length of the server-signed message in bytes.
#[constant]
pub const MSG_LEN: u16 = 152;
pub const MSG_LEN_BYTES: usize = MSG_LEN as usize;

// ---- v2 public record (docs/public-record.md §2.2, §3, §4) --------------------

/// Prefix of the 256-byte FVSCAN2 message that `record_scan_v2` parses out of the Ed25519 instruction.
#[constant]
pub const MSG2_PREFIX: &[u8] = b"FVSCAN2";
#[constant]
pub const MSG2_LEN: u16 = 256;
pub const MSG2_LEN_BYTES: usize = MSG2_LEN as usize;
/// `scan_head_n = sha256("FVHEAD1" ‖ scan_head_(n−1) ‖ sha256(msg_n))`
#[constant]
pub const SCAN_HEAD_PREFIX: &[u8] = b"FVHEAD1";
/// `commitment = sha256("FVHOLD1" ‖ passport ‖ epoch u32 LE ‖ secret32)`
#[constant]
pub const COMMITMENT_PREFIX: &[u8] = b"FVHOLD1";
/// `fill` value of a scan without a fill reading (every tier-0 sighting, and only those).
#[constant]
pub const FILL_NONE: u8 = 255;
/// Schema of the off-chain v2 bundle whose sha256 FVSCAN2 signs as `bundle_hash` (not used on chain).
pub const BUNDLE2_SCHEMA: &str = "flaconvault.scanbundle.v2";

// ---- Capacities --------------------------------------------------------------

#[constant]
pub const MAX_SERVER_KEYS: u8 = 8;
#[constant]
pub const MAX_PARTNERS: u8 = 16;
#[constant]
pub const MAX_SITES: u8 = 16;
/// A passport carries at most one BOX and one NECK seal.
#[constant]
pub const MAX_SEALS_PER_PASSPORT: u8 = 2;

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

// purpose (FVSCAN2: why the scan was made)
#[constant]
pub const PURPOSE_TAP: u8 = 0;
#[constant]
pub const PURPOSE_CHECK: u8 = 1;
#[constant]
pub const PURPOSE_LIST: u8 = 2;
#[constant]
pub const PURPOSE_SHIP: u8 = 3;
#[constant]
pub const PURPOSE_RECEIPT: u8 = 4;
#[constant]
pub const PURPOSE_CLAIM: u8 = 5;
#[constant]
pub const PURPOSE_BIRTH: u8 = 6;

// actor_kind (FVSCAN2: who scanned; only HOLDER, WALLET and PARTNER scans change grade and void)
#[constant]
pub const ACTOR_KIND_NONE: u8 = 0;
#[constant]
pub const ACTOR_KIND_HOLDER: u8 = 1;
#[constant]
pub const ACTOR_KIND_WALLET: u8 = 2;
#[constant]
pub const ACTOR_KIND_PARTNER: u8 = 3;
#[constant]
pub const ACTOR_KIND_RECIPIENT: u8 = 4;

// cluster (FVSCAN2 cluster_tag; 0 is never valid)
#[constant]
pub const CLUSTER_MAINNET: u8 = 1;
#[constant]
pub const CLUSTER_DEVNET: u8 = 2;
#[constant]
pub const CLUSTER_LOCALNET: u8 = 3;

// holding_state
#[constant]
pub const HOLDING_STATE_ACCOUNT: u8 = 0;
#[constant]
pub const HOLDING_STATE_CLAIM_PENDING: u8 = 1;
#[constant]
pub const HOLDING_STATE_WALLET: u8 = 2;

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
/// Highest valid purpose and actor_kind code (FVSCAN2).
pub const MAX_PURPOSE: u8 = 6;
pub const MAX_ACTOR_KIND: u8 = 4;

// ---- Holding delays (HolderConfig; used from P3/P4) ------------------------------

/// Public delay of a move to a wallet (72 h).
#[constant]
pub const DEFAULT_CLAIM_DELAY_S: i64 = 259_200;
/// Public delay of a move without a tap (7 days).
#[constant]
pub const DEFAULT_NOTAP_DELAY_S: i64 = 604_800;
/// `set_holder_config` accepts delays only within 1 day ..= 30 days.
#[constant]
pub const MIN_HOLD_DELAY_S: i64 = 86_400;
#[constant]
pub const MAX_HOLD_DELAY_S: i64 = 2_592_000;

// ---- Freshness ----------------------------------------------------------------

/// `record_scan` accepts a signed message only while |msg.ts − cluster clock| ≤ this (seconds).
#[constant]
pub const MAX_SCAN_TS_SKEW_S: i64 = 600;
/// NTAG 424 DNA SUN counters are 24 bit; anything above cannot come from a real tap.
#[constant]
pub const MAX_COUNTER: u32 = 0x00FF_FFFF;
/// `get_stack_height()` of a transaction-level instruction (`record_scan_v2` refuses to run as a CPI).
pub const TRANSACTION_LEVEL_STACK_HEIGHT: usize = 1;

// ---- External programs ----------------------------------------------------------

/// Metaplex Core: `mint_passport` only accepts an asset account owned by this program.
#[constant]
pub const MPL_CORE_PROGRAM_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/// First byte (`Key`) of a Metaplex Core `AssetV1` account.
pub const MPL_CORE_KEY_ASSET_V1: u8 = 1;
