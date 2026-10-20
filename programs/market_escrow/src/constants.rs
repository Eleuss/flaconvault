//! Market escrow constants, exposed in the IDL via `#[constant]`.

use anchor_lang::prelude::*;

// ---- PDA seeds ---------------------------------------------------------------

/// Singleton config `["config"]`.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
/// `MarketOrder` `["morder", buyer, order_id (16 random bytes)]`.
#[constant]
pub const ORDER_SEED: &[u8] = b"morder";
/// Order vault: SPL token account `["vault", order]`, authority = the order PDA.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
/// Fee vault: SPL token account `["fees", mint]`, authority = the config PDA (one per allowed mint).
#[constant]
pub const FEE_VAULT_SEED: &[u8] = b"fees";

// ---- Order states (u8) -------------------------------------------------------

/// Funded, waiting for `mark_shipped`.
#[constant]
pub const STATE_PAID: u8 = 1;
/// Shipped, the buyer's review window runs.
#[constant]
pub const STATE_SHIPPED: u8 = 2;
/// Halted by `dispute`; waits for a ruling, a settlement or `refund_after_tmax`.
#[constant]
pub const STATE_DISPUTED: u8 = 3;
/// The arbiter ruled; the timelock runs, then `execute_ruling`. A settlement is still possible.
#[constant]
pub const STATE_RULED: u8 = 4;
/// Terminal: the seller was paid, the fees went to the fee vault.
#[constant]
pub const STATE_RELEASED: u8 = 5;
/// Terminal: the buyer got the whole deposit back.
#[constant]
pub const STATE_REFUNDED: u8 = 6;
/// Terminal: buyer and seller split the deposit (no fees).
#[constant]
pub const STATE_SETTLED: u8 = 7;

// ---- Resolution (u8, why a terminal state was reached) -----------------------

#[constant]
pub const RESOLUTION_NONE: u8 = 0;
/// `confirm` by the buyer.
#[constant]
pub const RESOLUTION_CONFIRMED: u8 = 1;
/// `release_after_window`.
#[constant]
pub const RESOLUTION_WINDOW: u8 = 2;
/// `execute_ruling` of a RELEASE ruling.
#[constant]
pub const RESOLUTION_RULING_RELEASE: u8 = 3;
/// `refund_unshipped`.
#[constant]
pub const RESOLUTION_UNSHIPPED: u8 = 4;
/// `execute_ruling` of a REFUND ruling.
#[constant]
pub const RESOLUTION_RULING_REFUND: u8 = 5;
/// `refund_after_tmax`: no ruling by T_max.
#[constant]
pub const RESOLUTION_TMAX: u8 = 6;
/// `accept_settlement`.
#[constant]
pub const RESOLUTION_SETTLEMENT: u8 = 7;

// ---- Lanes (u8, blueprint §4.1) ----------------------------------------------

/// Lane S (sealed bottle): review window 10 days after `mark_shipped`.
#[constant]
pub const LANE_S: u8 = 1;
/// Lane A (photos): review window 14 days after `mark_shipped`.
#[constant]
pub const LANE_A: u8 = 2;
/// Lane G (inspection hub): not available with crypto until the hub steps are on chain (§7.2).
#[constant]
pub const LANE_G: u8 = 3;

// ---- Rulings and parties (u8) --------------------------------------------------

#[constant]
pub const RULING_NONE: u8 = 0;
#[constant]
pub const RULING_RELEASE: u8 = 1;
#[constant]
pub const RULING_REFUND: u8 = 2;

#[constant]
pub const PARTY_NONE: u8 = 0;
#[constant]
pub const PARTY_BUYER: u8 = 1;
#[constant]
pub const PARTY_SELLER: u8 = 2;
#[constant]
pub const PARTY_ARBITER: u8 = 3;

// ---- Rule parameters -----------------------------------------------------------

pub const HOUR: i64 = 60 * 60;
pub const DAY: i64 = 24 * HOUR;

/// Review window after `mark_shipped`, lane S.
#[constant]
pub const REVIEW_WINDOW_S_LANE_S: u32 = (10 * DAY) as u32;
/// Review window after `mark_shipped`, lane A.
#[constant]
pub const REVIEW_WINDOW_S_LANE_A: u32 = (14 * DAY) as u32;

/// The signed ship deadline must lie 1 ..= 30 days after `open_and_deposit`.
#[constant]
pub const MIN_SHIP_WINDOW_S: i64 = DAY;
#[constant]
pub const MAX_SHIP_WINDOW_S: i64 = 30 * DAY;

/// T_max: the arbiter must rule within 7 ..= 60 days (signed per order) after the dispute opened.
#[constant]
pub const MIN_RULING_WINDOW_S: u32 = (7 * DAY) as u32;
#[constant]
pub const MAX_RULING_WINDOW_S: u32 = (60 * DAY) as u32;

/// Timelock between `rule` and `execute_ruling`: 48 ..= 72 h (signed per order).
#[constant]
pub const MIN_TIMELOCK_S: u32 = (48 * HOUR) as u32;
#[constant]
pub const MAX_TIMELOCK_S: u32 = (72 * HOUR) as u32;

/// A signed offer may be valid for at most one hour (the USDC rate holds 10 minutes, §7.1).
#[constant]
pub const MAX_OFFER_TTL_S: i64 = HOUR;

/// Buyer fee and seller commission are each capped at 20 % of the item amount, so even a misused
/// offer key cannot sign away the seller's proceeds.
#[constant]
pub const MAX_FEE_BPS: u64 = 2_000;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Allowed mints: classic SPL Token mints with 6 decimals (USDC, EURC).
#[constant]
pub const MINT_DECIMALS: u8 = 6;

// ---- Offer message ---------------------------------------------------------------

/// Domain prefix of the signed offer message (8 bytes).
#[constant]
pub const OFFER_PREFIX: &[u8] = b"FVMKTOF1";
/// Length of the signed offer message (see `offer.rs`).
#[constant]
pub const OFFER_MSG_LEN: u16 = 201;
