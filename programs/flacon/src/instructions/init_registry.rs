use anchor_lang::prelude::*;

use crate::{constants::*, events::RegistryInitialized, state::Registry};

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, Registry>,
    /// Payer becomes the registry authority.
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_registry(ctx: Context<InitRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.authority = ctx.accounts.authority.key();
    registry.server_keys = Vec::new();
    registry.partners = Vec::new();
    registry.sites = Vec::new();
    registry.bump = ctx.bumps.registry;

    emit!(RegistryInitialized {
        registry: registry.key(),
        authority: registry.authority,
    });
    Ok(())
}
