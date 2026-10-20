//! Disputes without custody (blueprint §7.3): `dispute` only halts; the arbiter can only rule RELEASE or
//! REFUND, behind a timelock, with a published reason hash; without a ruling by T_max the buyer is
//! refunded. Decision rules: `crate::rules`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::MarketEscrowError as E,
    events::{OrderDisputed, RulingMade},
    instructions::flow::Refund,
    payout::{refund, release},
    rules::{check_dispute, check_execute_ruling, check_refund_after_tmax, check_rule, deadline, party_of, ruling_deadline},
    state::{MarketConfig, MarketOrder},
};

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, MarketOrder>,
    /// The buyer or the arbiter.
    pub signer: Signer<'info>,
}

/// Buyer or arbiter: halts a SHIPPED order inside its review window. Moves no money.
pub fn handle_dispute(ctx: Context<OpenDispute>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let arbiter = ctx.accounts.config.arbiter;
    let order = &mut ctx.accounts.order;
    let party = party_of(&ctx.accounts.signer.key(), &order.buyer, &order.seller, &arbiter);
    check_dispute(order.state, party, order.shipped_at, order.review_window_s, now)?;
    order.state = STATE_DISPUTED;
    order.disputed_at = now;
    order.disputed_by = party;
    emit!(OrderDisputed {
        order: order.key(),
        by: party,
        ruling_deadline: ruling_deadline(now, order.ruling_window_s)?,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Rule<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = arbiter @ E::NotArbiter
    )]
    pub config: Account<'info, MarketConfig>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, MarketOrder>,
    pub arbiter: Signer<'info>,
}

/// Arbiter: RULING_RELEASE or RULING_REFUND on a DISPUTED order before T_max, with the hash of the
/// published reasons. Moves no money; `execute_ruling` can follow after the order's timelock.
pub fn handle_rule(ctx: Context<Rule>, ruling: u8, reason_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    check_rule(order.state, order.disputed_at, order.ruling_window_s, ruling, &reason_hash, now)?;
    order.state = STATE_RULED;
    order.ruling = ruling;
    order.ruled_at = now;
    order.reason_hash = reason_hash;
    emit!(RulingMade {
        order: order.key(),
        ruling,
        reason_hash,
        executable_after: deadline(now, order.timelock_s as i64)?,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteRuling<'info> {
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
    /// Required for a REFUND ruling.
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.buyer
    )]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    /// Required for a RELEASE ruling.
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.seller
    )]
    pub seller_token: Option<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, order.mint.as_ref()],
        bump
    )]
    pub fee_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Anyone, after the timelock: carries out the ruling.
pub fn handle_execute_ruling(ctx: Context<ExecuteRuling>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    let resolution = check_execute_ruling(a.order.state, a.order.ruling, a.order.ruled_at, a.order.timelock_s, now)?;
    if resolution == RESOLUTION_RULING_RELEASE {
        let seller_token = a.seller_token.as_ref().ok_or(E::MissingTokenAccount)?;
        release(
            &mut a.order,
            &a.vault,
            seller_token.to_account_info(),
            a.fee_vault.to_account_info(),
            &a.token_program,
            resolution,
            now,
        )
    } else {
        let buyer_token = a.buyer_token.as_ref().ok_or(E::MissingTokenAccount)?;
        refund(
            &mut a.order,
            &a.vault,
            buyer_token.to_account_info(),
            &a.token_program,
            resolution,
            now,
        )
    }
}

/// Anyone: DISPUTED and no ruling by T_max → everything back to the buyer (FlaconVault bears the
/// seller's loss off chain, §7.3).
pub fn handle_refund_after_tmax(ctx: Context<Refund>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    check_refund_after_tmax(a.order.state, a.order.disputed_at, a.order.ruling_window_s, now)?;
    refund(
        &mut a.order,
        &a.vault,
        a.buyer_token.to_account_info(),
        &a.token_program,
        RESOLUTION_TMAX,
        now,
    )
}
