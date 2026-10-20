//! `close_order` — anyone, once an order is terminal and its offer has expired: closes the vault and the
//! order and returns their rent to `order.rent_payer`. Tokens that reached the empty vault after the
//! payout (nobody can be stopped from sending some) go to the buyer.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};

use crate::{
    constants::*,
    error::MarketEscrowError as E,
    events::OrderClosed,
    payout::pay,
    rules::check_close,
    state::MarketOrder,
};

#[derive(Accounts)]
pub struct CloseOrder<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.buyer.as_ref(), order.order_id.as_ref()],
        bump = order.bump,
        close = rent_payer
    )]
    pub order: Account<'info, MarketOrder>,
    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: receives the rent; must be the account that paid it.
    #[account(mut, address = order.rent_payer @ E::RentPayerMismatch)]
    pub rent_payer: UncheckedAccount<'info>,
    /// Required only when the vault is not empty.
    #[account(
        mut,
        associated_token::mint = order.mint,
        associated_token::authority = order.buyer
    )]
    pub buyer_token: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_close_order(ctx: Context<CloseOrder>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    check_close(a.order.state, a.order.offer_expiry, now)?;
    let leftover = a.vault.amount;
    if leftover > 0 {
        let buyer_token = a.buyer_token.as_ref().ok_or(E::MissingTokenAccount)?;
        pay(&a.order, &a.vault, buyer_token.to_account_info(), leftover, &a.token_program)?;
    }
    let bump = [a.order.bump];
    let seeds: &[&[u8]] = &[
        ORDER_SEED,
        a.order.buyer.as_ref(),
        a.order.order_id.as_ref(),
        &bump,
    ];
    token::close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount {
            account: a.vault.to_account_info(),
            destination: a.rent_payer.to_account_info(),
            authority: a.order.to_account_info(),
        },
        &[seeds],
    ))?;
    emit!(OrderClosed {
        order: a.order.key(),
        rent_payer: a.order.rent_payer,
        swept_to_buyer: leftover,
        ts: now,
    });
    Ok(())
}
