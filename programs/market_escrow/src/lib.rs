//! FlaconVault `market_escrow` — non-custodial USDC / EURC escrow for marketplace orders
//! (marketplace blueprint §7.2 and §7.3).
//!
//! ```text
//! open_and_deposit ─▶ PAID ─mark_shipped─▶ SHIPPED ─confirm / release_after_window─▶ RELEASED
//!                      │                     └─dispute─▶ DISPUTED ─rule─▶ RULED ─execute_ruling─▶ RELEASED | REFUNDED
//!                      │                                  │  └─refund_after_tmax─▶ REFUNDED   │
//!                      │                                  └──propose + accept_settlement──────┴─▶ SETTLED
//!                      └─refund_unshipped (after the ship deadline)─▶ REFUNDED
//! RELEASED | REFUNDED | SETTLED ─close_order─▶ accounts closed, rent back to the rent payer
//! ```
//!
//! What no key of FlaconVault can do: move an order's funds, change the config, pause, freeze or sweep.
//! The offer key only fixes the terms the buyer deposits on; the arbiter can only halt a shipped order
//! and rule RELEASE or full REFUND behind a 48–72 h timelock; every state ends after a bounded time
//! through an instruction anyone may send. Money goes only to the buyer, the seller and (on release)
//! the fee vault. The rules live in `rules.rs` (pure, unit-tested). This program reads no accounts of
//! the passport program (`flacon`).

pub mod constants;
pub mod ed25519;
pub mod error;
pub mod events;
pub mod instructions;
pub mod offer;
pub mod payout;
pub mod rules;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::MarketEscrowError;
pub use instructions::*;
pub use offer::OfferArgs;
pub use state::*;

declare_id!("CeyUTXX5CbgUNPM1msfnp6UfLdNh8PGLm8DpvdYJsEXW");

#[program]
pub mod market_escrow {
    use super::*;

    /// Once, by the program's upgrade authority: offer key, arbiter, fee recipient and the two allowed
    /// mints (USDC, EURC; classic SPL Token, 6 decimals). Creates the fee vault of each mint. There is no
    /// instruction that changes any of it.
    pub fn init_config(
        ctx: Context<InitConfig>,
        offer_key: Pubkey,
        arbiter: Pubkey,
        fee_recipient: Pubkey,
    ) -> Result<()> {
        instructions::config::handle_init_config(ctx, offer_key, arbiter, fee_recipient)
    }

    /// Buyer: opens the order `["morder", buyer, order_id]` and deposits `amount + buyer_fee`. Must
    /// directly follow an Ed25519 instruction with the offer key's signature over the terms (`offer.rs`).
    pub fn open_and_deposit(ctx: Context<OpenAndDeposit>, args: OfferArgs) -> Result<()> {
        instructions::open::handle_open_and_deposit(ctx, args)
    }

    /// Seller: shipped (until the ship deadline). Starts the review window of the lane.
    pub fn mark_shipped(ctx: Context<MarkShipped>) -> Result<()> {
        instructions::flow::handle_mark_shipped(ctx)
    }

    /// Buyer: received (SHIPPED), or withdraws a dispute (DISPUTED) → release.
    pub fn confirm(ctx: Context<Confirm>) -> Result<()> {
        instructions::flow::handle_confirm(ctx)
    }

    /// Anyone: SHIPPED and the review window passed without a dispute → release.
    pub fn release_after_window(ctx: Context<Release>) -> Result<()> {
        instructions::flow::handle_release_after_window(ctx)
    }

    /// Anyone: PAID and the ship deadline passed → full refund.
    pub fn refund_unshipped(ctx: Context<Refund>) -> Result<()> {
        instructions::flow::handle_refund_unshipped(ctx)
    }

    /// Buyer or arbiter: halts a SHIPPED order inside its review window (moves no money).
    pub fn dispute(ctx: Context<OpenDispute>) -> Result<()> {
        instructions::dispute::handle_dispute(ctx)
    }

    /// Buyer or seller: proposes how much of the deposit goes back to the buyer (DISPUTED or RULED).
    pub fn propose_settlement(ctx: Context<ProposeSettlement>, to_buyer: u64) -> Result<()> {
        instructions::settle::handle_propose_settlement(ctx, to_buyer)
    }

    /// The other party accepts exactly the open proposal → split, no fees.
    pub fn accept_settlement(ctx: Context<AcceptSettlement>, expected_to_buyer: u64) -> Result<()> {
        instructions::settle::handle_accept_settlement(ctx, expected_to_buyer)
    }

    /// Arbiter: `RULING_RELEASE` or `RULING_REFUND` before T_max, with the hash of the published
    /// reasons; starts the order's timelock (moves no money).
    pub fn rule(ctx: Context<Rule>, ruling: u8, reason_hash: [u8; 32]) -> Result<()> {
        instructions::dispute::handle_rule(ctx, ruling, reason_hash)
    }

    /// Anyone, after the timelock: carries out the ruling.
    pub fn execute_ruling(ctx: Context<ExecuteRuling>) -> Result<()> {
        instructions::dispute::handle_execute_ruling(ctx)
    }

    /// Anyone: DISPUTED and no ruling by T_max → full refund.
    pub fn refund_after_tmax(ctx: Context<Refund>) -> Result<()> {
        instructions::dispute::handle_refund_after_tmax(ctx)
    }

    /// Anyone: forwards a fee vault to the fee recipient's associated token account.
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        instructions::config::handle_collect_fees(ctx)
    }

    /// Anyone: closes a terminal order and its vault after the offer expired; rent → rent payer.
    pub fn close_order(ctx: Context<CloseOrder>) -> Result<()> {
        instructions::close::handle_close_order(ctx)
    }
}
