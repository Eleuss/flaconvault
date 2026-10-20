//! Settlement between buyer and seller, without FlaconVault: one party proposes how much of the deposit
//! goes back to the buyer, the other accepts exactly that amount. Possible while DISPUTED and during
//! (and after) a ruling's timelock until the ruling is executed. No fees are taken.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    events::{OrderSettled, SettlementProposed},
    payout::pay,
    rules::{check_accept, check_propose, party_of, settlement_payout},
    state::MarketOrder,
};

#[derive(Accounts)]
pub struct ProposeSettlement<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, MarketOrder>,
    /// The buyer or the seller.
    pub signer: Signer<'info>,
}

/// Buyer or seller: proposes `to_buyer` (base units, at most the deposit); replaces an earlier
/// proposal by either party (a counter-offer).
pub fn handle_propose_settlement(ctx: Context<ProposeSettlement>, to_buyer: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    // the arbiter is no party to a settlement: `Pubkey::default()` never matches a signer
    let party = party_of(&ctx.accounts.signer.key(), &order.buyer, &order.seller, &Pubkey::default());
    let deposit = order.deposit();
    check_propose(order.state, party, to_buyer, deposit)?;
    order.proposal_by = party;
    order.proposal_to_buyer = to_buyer;
    emit!(SettlementProposed {
        order: order.key(),
        by: party,
        to_buyer,
        to_seller: deposit - to_buyer,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptSettlement<'info> {
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
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,
    /// The party that did not make the open proposal.
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// The other party accepts the open proposal; `expected_to_buyer` must equal it, so a proposal
/// changed while this transaction was in flight is not accepted.
pub fn handle_accept_settlement(ctx: Context<AcceptSettlement>, expected_to_buyer: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    let party = party_of(&a.signer.key(), &a.order.buyer, &a.order.seller, &Pubkey::default());
    check_accept(a.order.state, party, a.order.proposal_by, a.order.proposal_to_buyer, expected_to_buyer)?;
    let p = settlement_payout(a.order.deposit(), a.order.proposal_to_buyer)?;
    pay(&a.order, &a.vault, a.buyer_token.to_account_info(), p.to_buyer, &a.token_program)?;
    pay(&a.order, &a.vault, a.seller_token.to_account_info(), p.to_seller, &a.token_program)?;
    let order = &mut a.order;
    order.state = STATE_SETTLED;
    order.resolution = RESOLUTION_SETTLEMENT;
    order.ended_at = now;
    emit!(OrderSettled {
        order: order.key(),
        to_buyer: p.to_buyer,
        to_seller: p.to_seller,
        ts: now,
    });
    Ok(())
}
