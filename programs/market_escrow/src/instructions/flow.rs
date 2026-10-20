//! The undisputed path: `mark_shipped` (seller), `confirm` (buyer), `release_after_window` (anyone),
//! `refund_unshipped` (anyone). Decision rules: `crate::rules`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::MarketEscrowError as E,
    events::OrderShipped,
    payout::{refund, release},
    rules::{check_confirm, check_mark_shipped, check_refund_unshipped, check_release_after_window, deadline},
    state::MarketOrder,
};

#[derive(Accounts)]
pub struct MarkShipped<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump,
        has_one = seller @ E::NotSeller
    )]
    pub order: Account<'info, MarketOrder>,
    pub seller: Signer<'info>,
}

/// Seller: the parcel is on its way (no tracking number on chain). Starts the review window; by
/// signing, the seller also accepts the order's terms on chain.
pub fn handle_mark_shipped(ctx: Context<MarkShipped>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    check_mark_shipped(order.state, order.ship_deadline, now)?;
    order.state = STATE_SHIPPED;
    order.shipped_at = now;
    emit!(OrderShipped {
        order: order.key(),
        review_until: deadline(now, order.review_window_s as i64)?,
        ts: now,
    });
    Ok(())
}

/// Accounts of a release to the seller (`release_after_window`; `confirm` adds the buyer).
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, MarketOrder>,
    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    /// The seller's associated token account for the order's mint.
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, order.mint.as_ref()],
        bump
    )]
    pub fee_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Anyone: SHIPPED and the review window passed without a dispute → seller and fee vault.
pub fn handle_release_after_window(ctx: Context<Release>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    check_release_after_window(a.order.state, a.order.shipped_at, a.order.review_window_s, now)?;
    release(
        &mut a.order,
        &a.vault,
        a.seller_token.to_account_info(),
        a.fee_vault.to_account_info(),
        &a.token_program,
        RESOLUTION_WINDOW,
        now,
    )
}

#[derive(Accounts)]
pub struct Confirm<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump,
        has_one = buyer @ E::NotBuyer
    )]
    pub order: Account<'info, MarketOrder>,
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, order.mint.as_ref()],
        bump
    )]
    pub fee_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Buyer: received and fine (in lane S the receipt tap triggers it), or withdraws an open dispute.
pub fn handle_confirm(ctx: Context<Confirm>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    check_confirm(a.order.state)?;
    release(
        &mut a.order,
        &a.vault,
        a.seller_token.to_account_info(),
        a.fee_vault.to_account_info(),
        &a.token_program,
        RESOLUTION_CONFIRMED,
        now,
    )
}

/// Accounts of a full refund to the buyer (`refund_unshipped`, `refund_after_tmax`).
#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, MarketOrder>,
    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    /// The buyer's associated token account for the order's mint.
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Anyone: PAID and the ship deadline passed → everything back to the buyer.
pub fn handle_refund_unshipped(ctx: Context<Refund>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    check_refund_unshipped(a.order.state, a.order.ship_deadline, now)?;
    refund(
        &mut a.order,
        &a.vault,
        a.buyer_token.to_account_info(),
        &a.token_program,
        RESOLUTION_UNSHIPPED,
        now,
    )
}
