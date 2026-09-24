use anchor_lang::prelude::*;

/// Seeds `["config"]` — singleton.
///
/// Layout (after the 8-byte discriminator): admin @8 (32) · usdc_mint @40 (32)
/// · dispute_after_s @72 (i64) · bump @80 (u8) → 81 bytes.
#[account]
#[derive(InitSpace)]
pub struct EscrowConfig {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    /// Default window after `ship()` in which the buyer must record a receipt scan.
    pub dispute_after_s: i64,
    pub bump: u8,
}

/// Seeds `["order", passport, seller]`.
///
/// Layout (after the 8-byte discriminator):
/// passport @8 (32) · seller @40 (32) · buyer @72 (32, zero until reserved) · asset @104 (32)
/// · price @136 (u64) · state @144 (u8) · listed_at @145 (i64) · reserved_at @153 (i64)
/// · shipped_at @161 (i64) · seller_scan @169 (32) · buyer_scan @201 (32)
/// · dispute_after_s @233 (i64) · asset_deposited @241 (bool) · bump @242 (u8) · vault_bump @243 (u8)
/// → 244 bytes.
#[account]
#[derive(InitSpace)]
pub struct Order {
    /// flacon `Passport` PDA.
    pub passport: Pubkey,
    pub seller: Pubkey,
    /// `Pubkey::default()` until `reserve`.
    pub buyer: Pubkey,
    /// Metaplex Core asset (copied from `passport.asset` at `list`).
    pub asset: Pubkey,
    /// USDC base units (6 dp).
    pub price: u64,
    /// `ORDER_STATE_*`
    pub state: u8,
    pub listed_at: i64,
    pub reserved_at: i64,
    pub shipped_at: i64,
    /// flacon `ScanProof` PDA of the seller's pre-ship scan (default until recorded).
    pub seller_scan: Pubkey,
    /// flacon `ScanProof` PDA of the buyer's receipt scan (default until recorded).
    pub buyer_scan: Pubkey,
    /// Copied from `EscrowConfig.dispute_after_s` at `list` (fixed for this order).
    pub dispute_after_s: i64,
    /// True once the Core asset sits in the Order PDA's custody (`deposit_asset`).
    pub asset_deposited: bool,
    pub bump: u8,
    /// Bump of the `["vault", order]` token account (set at `reserve`).
    pub vault_bump: u8,
}

impl Order {
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// States in which the USDC vault holds the buyer's funds.
    pub fn is_funded(&self) -> bool {
        matches!(
            self.state,
            crate::constants::ORDER_STATE_RESERVED
                | crate::constants::ORDER_STATE_PRESHIP_SCANNED
                | crate::constants::ORDER_STATE_SHIPPED
                | crate::constants::ORDER_STATE_RECEIPT_SCANNED
                | crate::constants::ORDER_STATE_MISMATCH
        )
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            crate::constants::ORDER_STATE_RELEASED
                | crate::constants::ORDER_STATE_DISPUTE
                | crate::constants::ORDER_STATE_CANCELLED
        )
    }
}

const _: () = assert!(8 + EscrowConfig::INIT_SPACE == 81);
const _: () = assert!(Order::LEN == 244);
