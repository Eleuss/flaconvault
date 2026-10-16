//! FlaconVault `escrow` — USDC escrow with scan-verified handover (Dev-Briefing v2 §11).
//!
//! ```text
//! LISTED → RESERVED → PRESHIP_SCANNED → SHIPPED → RECEIPT_SCANNED → RELEASED
//!                                          │      └─────────────→ MISMATCH ──(admin resolve)──→ RELEASED | DISPUTE
//!                                          └──(no receipt scan within the window: release_after_timeout)──→ RELEASED
//! RESERVED / PRESHIP_SCANNED ──(buyer, not shipped within the window after reserve)──→ DISPUTE
//! RESERVED / PRESHIP_SCANNED ──(buyer with a dead seal)──→ DISPUTE
//! RESERVED / PRESHIP_SCANNED / SHIPPED ──(admin)──→ DISPUTE
//! LISTED ──(seller)──→ CANCELLED
//! ```
//! The rules live in `rules.rs` (pure, unit-tested).
//! USDC vault: SPL token account `["vault", order]` with the Order PDA as authority
//! (created at `reserve`, rent paid by and returned to the buyer). Core asset
//! custody is optional (`deposit_asset`) and uses a hand-rolled mpl-core `TransferV1` CPI.
//! flacon accounts (`Passport`, `Seal`, `ScanProof`) are typed through the `flacon`
//! crate, so owner + discriminator are enforced by Anchor.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod mpl_core;
pub mod rules;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::EscrowError;
pub use instructions::*;
pub use state::*;

declare_id!("9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL");

#[program]
pub mod escrow {
    use super::*;

    /// Singleton config; payer becomes admin and must be the program's upgrade authority.
    /// `usdc_mint` is passed as an account; `dispute_after_s` in 1 h ..= 60 days.
    pub fn init_config(ctx: Context<InitConfig>, dispute_after_s: i64) -> Result<()> {
        instructions::admin::handle_init_config(ctx, dispute_after_s)
    }

    /// Admin only: default dispute window for future orders (1 h ..= 60 days).
    pub fn set_dispute_window(ctx: Context<AdminConfig>, dispute_after_s: i64) -> Result<()> {
        instructions::admin::handle_set_dispute_window(ctx, dispute_after_s)
    }

    /// Seller lists a (non-void) flacon passport for `price` USDC base units. The seller must own the
    /// passport's Core asset (or, when there is no Core asset behind `passport.asset`, be the issuer
    /// while still a registry partner).
    pub fn list(ctx: Context<List>, price: u64) -> Result<()> {
        instructions::list::handle_list(ctx, price)
    }

    /// Seller moves the Core asset into escrow custody (optional; LISTED only).
    pub fn deposit_asset(ctx: Context<DepositAsset>) -> Result<()> {
        instructions::list::handle_deposit_asset(ctx)
    }

    /// Seller cancels a LISTED order (asset returned if deposited).
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::list::handle_cancel(ctx)
    }

    /// Seller reclaims a terminal order account (allows re-listing the same passport).
    pub fn close_order(ctx: Context<CloseOrder>) -> Result<()> {
        instructions::list::handle_close_order(ctx)
    }

    /// Buyer funds the vault with `price` USDC; `expected_price` must equal `order.price`. Unless the
    /// asset is in the order's custody, the seller must still pass the `list` ownership rule.
    pub fn reserve(ctx: Context<Reserve>, expected_price: u64) -> Result<()> {
        instructions::reserve::handle_reserve(ctx, expected_price)
    }

    /// Seller links their flacon pre-ship ScanProof (signed no earlier than `reserved_at` − 600 s).
    pub fn record_pre_ship_scan(ctx: Context<RecordPreShipScan>) -> Result<()> {
        instructions::scans::handle_record_pre_ship_scan(ctx)
    }

    /// Seller marks the parcel as shipped (starts the dispute window).
    pub fn ship(ctx: Context<Ship>) -> Result<()> {
        instructions::scans::handle_ship(ctx)
    }

    /// Buyer links their receipt ScanProof (signed no earlier than `shipped_at` − 600 s); compared with
    /// the pre-ship scan → RECEIPT_SCANNED or MISMATCH.
    pub fn record_receipt_scan(ctx: Context<RecordReceiptScan>) -> Result<()> {
        instructions::scans::handle_record_receipt_scan(ctx)
    }

    /// Permissionless settlement after a matching receipt scan.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        instructions::settle::handle_release(ctx)
    }

    /// Permissionless: SHIPPED and no receipt scan within `dispute_after_s` after `ship` → USDC to the
    /// seller (the buyer had the window to scan). Same accounts as `release`.
    pub fn release_after_timeout(ctx: Context<Release>) -> Result<()> {
        instructions::settle::handle_release_after_timeout(ctx)
    }

    /// Refund path: admin (RESERVED / PRESHIP_SCANNED / SHIPPED), or the buyer when the seller did not
    /// ship within the window after `reserve`, or with a dead seal before `ship` (after `ship` a dead
    /// seal is the admin's call).
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        instructions::settle::handle_dispute(ctx)
    }

    /// Escrow admin only: settles a MISMATCH order. `to_seller` → USDC to the seller (RELEASED),
    /// else → USDC back to the buyer (DISPUTE).
    pub fn resolve(ctx: Context<Resolve>, to_seller: bool) -> Result<()> {
        instructions::settle::handle_resolve(ctx, to_seller)
    }
}
