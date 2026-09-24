//! Escrow constants — exposed in the IDL via `#[constant]`; `packages/proof` mirrors them in TS.

use anchor_lang::prelude::*;

// ---- PDA seeds ---------------------------------------------------------------

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const ORDER_SEED: &[u8] = b"order";
/// USDC vault: SPL token account `["vault", order]`, authority = the Order PDA.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

// ---- Order states (u8) -------------------------------------------------------

#[constant]
pub const ORDER_STATE_LISTED: u8 = 0;
#[constant]
pub const ORDER_STATE_RESERVED: u8 = 1;
#[constant]
pub const ORDER_STATE_PRESHIP_SCANNED: u8 = 2;
#[constant]
pub const ORDER_STATE_SHIPPED: u8 = 3;
#[constant]
pub const ORDER_STATE_RECEIPT_SCANNED: u8 = 4;
#[constant]
pub const ORDER_STATE_RELEASED: u8 = 5;
#[constant]
pub const ORDER_STATE_MISMATCH: u8 = 6;
#[constant]
pub const ORDER_STATE_DISPUTE: u8 = 7;
#[constant]
pub const ORDER_STATE_CANCELLED: u8 = 8;

// ---- Dispute reasons (u8, in the `OrderDisputed` event) ----------------------

#[constant]
pub const DISPUTE_REASON_ADMIN: u8 = 0;
#[constant]
pub const DISPUTE_REASON_TIMEOUT: u8 = 1;
#[constant]
pub const DISPUTE_REASON_SEAL_DEAD: u8 = 2;
#[constant]
pub const DISPUTE_REASON_MISMATCH: u8 = 3;

// ---- Rule parameters ----------------------------------------------------------

/// Default dispute window after `ship()` without a receipt scan: 7 days.
#[constant]
pub const DEFAULT_DISPUTE_AFTER_S: i64 = 7 * 24 * 60 * 60;
/// `release` requires |fill_buyer − fill_seller| ≤ FILL_TOLERANCE (briefing §11).
#[constant]
pub const FILL_TOLERANCE: u8 = 5;

/// Metaplex Core program (asset custody CPI).
#[constant]
pub const MPL_CORE_PROGRAM_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
