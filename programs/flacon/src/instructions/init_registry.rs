use anchor_lang::prelude::*;

use crate::{
    constants::*, error::FlaconError, events::RegistryInitialized, program::Flacon, state::Registry,
};

/// Only the program's upgrade authority may create the registry (so a fresh deploy cannot be
/// front-run by whoever sends `init_registry` first). It becomes the registry authority.
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
    /// Payer becomes the registry authority; must be the program's upgrade authority.
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// This program (its ProgramData address is checked below).
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ FlaconError::NotUpgradeAuthority
    )]
    pub program: Program<'info, Flacon>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ FlaconError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
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
