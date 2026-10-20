//! `init_config` (once, upgrade authority) and `collect_fees` (anyone). There is no instruction that
//! changes the config, pauses the program or moves an order's funds anywhere but to its buyer, its seller
//! or (on release) the fee vault.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::MarketEscrowError as E,
    events::{ConfigInitialized, FeesCollected},
    program::MarketEscrow,
    state::MarketConfig,
};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = MarketConfig::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, MarketConfig>,
    /// The program's upgrade authority; pays the rent of the config and the fee vaults.
    #[account(mut)]
    pub authority: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub eurc_mint: Account<'info, Mint>,
    /// Fee vault of `usdc_mint`, owned by the config PDA. (`init_if_needed`: passing the same mint twice
    /// then fails the duplicate-account check instead of a raw "already in use".)
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [FEE_VAULT_SEED, usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = config
    )]
    pub usdc_fee_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [FEE_VAULT_SEED, eurc_mint.key().as_ref()],
        bump,
        token::mint = eurc_mint,
        token::authority = config
    )]
    pub eurc_fee_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// This program; only its upgrade authority may create the config (no front-running a fresh deploy).
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ E::NotUpgradeAuthority
    )]
    pub program: Program<'info, MarketEscrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ E::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_init_config(
    ctx: Context<InitConfig>,
    offer_key: Pubkey,
    arbiter: Pubkey,
    fee_recipient: Pubkey,
) -> Result<()> {
    for key in [offer_key, arbiter, fee_recipient] {
        require_keys_neq!(key, Pubkey::default(), E::InvalidKey);
    }
    require_keys_neq!(offer_key, arbiter, E::OfferKeyIsArbiter);
    let usdc = &ctx.accounts.usdc_mint;
    let eurc = &ctx.accounts.eurc_mint;
    require_keys_neq!(usdc.key(), eurc.key(), E::DuplicateMint);
    require!(
        usdc.decimals == MINT_DECIMALS && eurc.decimals == MINT_DECIMALS,
        E::InvalidMint
    );

    let config = &mut ctx.accounts.config;
    config.offer_key = offer_key;
    config.arbiter = arbiter;
    config.fee_recipient = fee_recipient;
    config.mints = [usdc.key(), eurc.key()];
    config.bump = ctx.bumps.config;
    config.fee_vault_bumps = [ctx.bumps.usdc_fee_vault, ctx.bumps.eurc_fee_vault];
    emit!(ConfigInitialized {
        config: config.key(),
        offer_key,
        arbiter,
        fee_recipient,
        mints: config.mints,
    });
    Ok(())
}

/// Anyone: forwards the whole fee vault of `mint` to the associated token account of
/// `config.fee_recipient`. Fees reach the fee vault only through a release.
#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
    #[account(constraint = config.allows(&mint.key()) @ E::MintNotAllowed)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub fee_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = config.fee_recipient
    )]
    pub fee_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_collect_fees(ctx: Context<CollectFees>) -> Result<()> {
    let amount = ctx.accounts.fee_vault.amount;
    if amount > 0 {
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.fee_vault.to_account_info(),
                    to: ctx.accounts.fee_destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    emit!(FeesCollected {
        mint: ctx.accounts.mint.key(),
        amount,
        destination: ctx.accounts.fee_destination.key(),
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
