use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    constants::*,
    error::EscrowError,
    events::{ConfigInitialized, DisputeWindowUpdated},
    program::Escrow,
    rules::check_window,
    state::EscrowConfig,
};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + EscrowConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, EscrowConfig>,
    /// Payer becomes the escrow admin.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// The USDC mint (devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; localnet: a test mint).
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    /// This program; only its upgrade authority may create the config (no front-running a fresh deploy).
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ EscrowError::Unauthorized
    )]
    pub program: Program<'info, Escrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ EscrowError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_init_config(ctx: Context<InitConfig>, dispute_after_s: i64) -> Result<()> {
    check_window(dispute_after_s)?;
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.dispute_after_s = dispute_after_s;
    config.bump = ctx.bumps.config;
    emit!(ConfigInitialized {
        config: config.key(),
        admin: config.admin,
        usdc_mint: config.usdc_mint,
        dispute_after_s,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ EscrowError::Unauthorized
    )]
    pub config: Account<'info, EscrowConfig>,
    pub admin: Signer<'info>,
}

/// Changes the default dispute window for *future* orders (existing orders keep their copy).
pub fn handle_set_dispute_window(ctx: Context<AdminConfig>, dispute_after_s: i64) -> Result<()> {
    check_window(dispute_after_s)?;
    ctx.accounts.config.dispute_after_s = dispute_after_s;
    emit!(DisputeWindowUpdated { dispute_after_s });
    Ok(())
}
