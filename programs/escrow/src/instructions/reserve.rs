use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::EscrowError,
    events::OrderReserved,
    state::{EscrowConfig, Order},
};

#[derive(Accounts)]
pub struct Reserve<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// Buyer's USDC token account (source of `price`).
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint @ EscrowError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    /// USDC vault owned by the Order PDA; rent paid by the buyer, returned on release/dispute.
    /// `init_if_needed` so that a second `reserve` on a funded order reaches the state check
    /// (`InvalidState`) instead of failing with a raw "account already in use"; the vault only
    /// exists while the order is funded, and those states are all rejected below.
    #[account(
        init_if_needed,
        payer = buyer,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = order
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_reserve(ctx: Context<Reserve>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.state == ORDER_STATE_LISTED, EscrowError::InvalidState);
    require_keys_neq!(
        ctx.accounts.buyer.key(),
        order.seller,
        EscrowError::SellerCannotBuy
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.buyer_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        order.price,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.buyer = ctx.accounts.buyer.key();
    order.reserved_at = now;
    order.state = ORDER_STATE_RESERVED;
    order.vault_bump = ctx.bumps.vault;

    emit!(OrderReserved {
        order: order.key(),
        buyer: order.buyer,
        price: order.price,
        vault: ctx.accounts.vault.key(),
        ts: now,
    });
    Ok(())
}
