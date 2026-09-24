use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    constants::*,
    error::EscrowError,
    events::{ConfigInitialized, DisputeWindowUpdated},
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
}

pub fn handle_init_config(ctx: Context<InitConfig>, dispute_after_s: i64) -> Result<()> {
    require!(dispute_after_s > 0, EscrowError::InvalidDisputeWindow);
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
    require!(dispute_after_s > 0, EscrowError::InvalidDisputeWindow);
    ctx.accounts.config.dispute_after_s = dispute_after_s;
    emit!(DisputeWindowUpdated { dispute_after_s });
    Ok(())
}
