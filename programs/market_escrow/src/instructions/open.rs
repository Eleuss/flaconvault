//! `open_and_deposit` — the buyer funds an order on terms signed by FlaconVault's offer key. Checks,
//! in this order:
//!
//! 1. The instruction right before this one is the Ed25519 precompile with one signature by
//!    `config.offer_key` over `offer_message(program id, buyer, mint, args)` (201 bytes, `offer.rs`).
//! 2. The terms are within the program's bounds (`rules::check_terms`): offer not expired and valid for
//!    at most an hour, fees ≤ 20 %, lane S or A, ship deadline 1..=30 days, T_max 7..=60 days, timelock
//!    48..=72 h, seller ≠ buyer ≠ arbiter.
//! 3. `amount + buyer_fee` moves from the buyer's token account to the order vault.
//!
//! The rent of the order and the vault is paid by `rent_payer` (the sponsor, or the buyer) and goes
//! back to it at `close_order`. `init_if_needed` lets a replayed offer reach the typed
//! `OrderAlreadyExists` instead of a raw "already in use"; an existing order is never rewritten.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    constants::*,
    ed25519::{parse_single_ed25519, ED25519_PROGRAM_ID},
    error::MarketEscrowError as E,
    events::OrderOpened,
    offer::{offer_message, OfferArgs, OFFER_LEN},
    rules::{check_terms, deposit_total},
    state::{MarketConfig, MarketOrder},
};

#[derive(Accounts)]
#[instruction(args: OfferArgs)]
pub struct OpenAndDeposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(
        init_if_needed,
        payer = rent_payer,
        space = MarketOrder::LEN,
        seeds = [ORDER_SEED, buyer.key().as_ref(), args.order_id.as_ref()],
        bump
    )]
    pub order: Account<'info, MarketOrder>,
    /// Token account `["vault", order]` holding the deposit, authority = the order PDA.
    #[account(
        init_if_needed,
        payer = rent_payer,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = order
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(constraint = config.allows(&mint.key()) @ E::MintNotAllowed)]
    pub mint: Account<'info, Mint>,
    pub buyer: Signer<'info>,
    /// Source of the deposit (any token account of the buyer for `mint`).
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    /// Pays the rent of `order` and `vault`; may be the buyer.
    #[account(mut)]
    pub rent_payer: Signer<'info>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = solana_instructions_sysvar::ID @ E::InvalidInstructionsSysvar)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Step 1: the Ed25519 instruction right before this one signs exactly `expected` with `offer_key`.
fn verify_offer_signature(ix_sysvar: &AccountInfo, offer_key: &Pubkey, expected: &[u8; OFFER_LEN]) -> Result<()> {
    let current_index =
        load_current_index_checked(ix_sysvar).map_err(|_| E::InvalidInstructionsSysvar)?;
    require!(current_index > 0, E::MissingOfferSignature);
    let ed_index = current_index - 1;
    let ed_ix = load_instruction_at_checked(ed_index as usize, ix_sysvar)
        .map_err(|_| E::MissingOfferSignature)?;
    require!(
        ed_ix.program_id.as_ref() == ED25519_PROGRAM_ID.as_ref(),
        E::MissingOfferSignature
    );
    let payload = parse_single_ed25519(&ed_ix.data, ed_index)?;
    require!(
        payload.pubkey == offer_key.to_bytes(),
        E::OfferKeyMismatch
    );
    require!(&payload.message == expected, E::OfferMismatch);
    Ok(())
}

pub fn handle_open_and_deposit(ctx: Context<OpenAndDeposit>, args: OfferArgs) -> Result<()> {
    require!(ctx.accounts.order.state == 0, E::OrderAlreadyExists);
    let config = &ctx.accounts.config;
    let buyer = ctx.accounts.buyer.key();
    let mint = ctx.accounts.mint.key();

    let expected = offer_message(ctx.program_id, &buyer, &mint, &args);
    verify_offer_signature(
        &ctx.accounts.instructions.to_account_info(),
        &config.offer_key,
        &expected,
    )?;
    let now = Clock::get()?.unix_timestamp;
    let review_window_s = check_terms(&args, &buyer, &config.arbiter, now)?;
    let deposit = deposit_total(args.amount, args.buyer_fee)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.buyer_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        deposit,
    )?;

    let order = &mut ctx.accounts.order;
    order.order_id = args.order_id;
    order.buyer = buyer;
    order.seller = args.seller;
    order.mint = mint;
    order.rent_payer = ctx.accounts.rent_payer.key();
    order.amount = args.amount;
    order.buyer_fee = args.buyer_fee;
    order.seller_fee = args.seller_fee;
    order.lane = args.lane;
    order.state = STATE_PAID;
    order.resolution = RESOLUTION_NONE;
    order.review_window_s = review_window_s;
    order.ruling_window_s = args.ruling_window_s;
    order.timelock_s = args.timelock_s;
    order.ship_deadline = args.ship_deadline;
    order.offer_expiry = args.expiry;
    order.opened_at = now;
    order.bump = ctx.bumps.order;
    order.vault_bump = ctx.bumps.vault;

    emit!(OrderOpened {
        order: order.key(),
        order_id: args.order_id,
        buyer,
        seller: args.seller,
        mint,
        amount: args.amount,
        buyer_fee: args.buyer_fee,
        seller_fee: args.seller_fee,
        lane: args.lane,
        ship_deadline: args.ship_deadline,
        rent_payer: order.rent_payer,
        ts: now,
    });
    Ok(())
}
