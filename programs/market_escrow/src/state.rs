use anchor_lang::prelude::*;

use crate::constants::*;

/// Seeds `["config"]`, singleton, created once by the program's upgrade authority. It has no setter:
/// nothing in this program can change the offer key, the arbiter, the fee recipient or the mints.
///
/// Layout (after the 8-byte discriminator): offer_key @8 (32) · arbiter @40 (32) · fee_recipient @72 (32)
/// · mints @104 (2 × 32) · bump @168 (u8) · fee_vault_bumps @169 (2 × u8) → 171 bytes.
#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    /// Ed25519 key of FlaconVault that signs order terms (`open_and_deposit`). It cannot move funds.
    pub offer_key: Pubkey,
    /// May open a dispute on a shipped order and rule RELEASE or REFUND on a disputed one.
    pub arbiter: Pubkey,
    /// Owner of the token accounts `collect_fees` forwards the fee vaults to.
    pub fee_recipient: Pubkey,
    /// Allowed mints: `[USDC, EURC]` (classic SPL Token, 6 decimals).
    pub mints: [Pubkey; 2],
    pub bump: u8,
    /// Bumps of the fee vaults `["fees", mints[i]]`.
    pub fee_vault_bumps: [u8; 2],
}

impl MarketConfig {
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    pub fn allows(&self, mint: &Pubkey) -> bool {
        self.mints.contains(mint)
    }
}

/// Seeds `["morder", buyer, order_id]` (`order_id`: 16 random bytes, not the marketplace order number).
///
/// Layout (after the 8-byte discriminator):
/// order_id @8 (16) · buyer @24 (32) · seller @56 (32) · mint @88 (32) · rent_payer @120 (32)
/// · amount @152 (u64) · buyer_fee @160 (u64) · seller_fee @168 (u64) · lane @176 (u8) · state @177 (u8)
/// · resolution @178 (u8) · review_window_s @179 (u32) · ruling_window_s @183 (u32) · timelock_s @187 (u32)
/// · ship_deadline @191 (i64) · offer_expiry @199 (i64) · opened_at @207 (i64) · shipped_at @215 (i64)
/// · disputed_at @223 (i64) · disputed_by @231 (u8) · ruled_at @232 (i64) · ruling @240 (u8)
/// · reason_hash @241 (32) · proposal_by @273 (u8) · proposal_to_buyer @274 (u64) · ended_at @282 (i64)
/// · bump @290 (u8) · vault_bump @291 (u8) → 292 bytes.
#[account]
#[derive(InitSpace)]
pub struct MarketOrder {
    pub order_id: [u8; 16],
    pub buyer: Pubkey,
    /// The seller's own wallet (from the signed offer); proceeds go to its associated token account.
    pub seller: Pubkey,
    /// USDC or EURC.
    pub mint: Pubkey,
    /// Paid the rent of this account and of the vault; gets it back at `close_order`.
    pub rent_payer: Pubkey,
    /// Item price in base units.
    pub amount: u64,
    /// Buyer protection, paid by the buyer on top of `amount`.
    pub buyer_fee: u64,
    /// Seller commission, deducted from `amount` on release.
    pub seller_fee: u64,
    /// `LANE_*`
    pub lane: u8,
    /// `STATE_*`
    pub state: u8,
    /// `RESOLUTION_*` (set with the terminal state).
    pub resolution: u8,
    /// Review window after `mark_shipped`, fixed by the lane.
    pub review_window_s: u32,
    /// T_max after `dispute` (signed).
    pub ruling_window_s: u32,
    /// Timelock after `rule` (signed).
    pub timelock_s: u32,
    /// After this instant `mark_shipped` is closed and the buyer can be refunded (signed).
    pub ship_deadline: i64,
    /// Expiry of the signed offer; the account can be closed only after it (no replay of the offer).
    pub offer_expiry: i64,
    pub opened_at: i64,
    pub shipped_at: i64,
    pub disputed_at: i64,
    /// `PARTY_BUYER` or `PARTY_ARBITER`.
    pub disputed_by: u8,
    pub ruled_at: i64,
    /// `RULING_*`
    pub ruling: u8,
    /// Hash of the published reasons of the ruling.
    pub reason_hash: [u8; 32],
    /// `PARTY_BUYER` / `PARTY_SELLER` of the open settlement proposal, `PARTY_NONE` if there is none.
    pub proposal_by: u8,
    /// Base units the proposal gives the buyer; the rest of the deposit goes to the seller.
    pub proposal_to_buyer: u64,
    /// When the terminal state was reached.
    pub ended_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl MarketOrder {
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// What the buyer deposited: `amount + buyer_fee` (checked at `open_and_deposit`).
    pub fn deposit(&self) -> u64 {
        self.amount.saturating_add(self.buyer_fee)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.state, STATE_RELEASED | STATE_REFUNDED | STATE_SETTLED)
    }
}

const _: () = assert!(MarketConfig::LEN == 171);
const _: () = assert!(MarketOrder::LEN == 292);
