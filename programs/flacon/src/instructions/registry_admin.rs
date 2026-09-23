use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::{PartnerAdded, ServerKeyAdded, SiteAdded},
    state::{Registry, ServerKey, Site},
};

/// Shared account set for the authority-only registry mutations.
#[derive(Accounts)]
pub struct AdminRegistry<'info> {
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ FlaconError::Unauthorized
    )]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
}

pub fn handle_add_server_key(
    ctx: Context<AdminRegistry>,
    key_id: u8,
    pubkey: [u8; 32],
    valid_from: i64,
    valid_to: i64,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    require!(
        valid_to == 0 || valid_to >= valid_from,
        FlaconError::InvalidKeyValidity
    );
    require!(
        registry.server_key(key_id).is_none(),
        FlaconError::DuplicateServerKey
    );
    require!(
        registry.server_keys.len() < MAX_SERVER_KEYS as usize,
        FlaconError::ServerKeysFull
    );
    registry.server_keys.push(ServerKey {
        key_id,
        pubkey,
        valid_from,
        valid_to,
    });
    emit!(ServerKeyAdded {
        key_id,
        pubkey,
        valid_from,
        valid_to,
    });
    Ok(())
}

pub fn handle_add_partner(ctx: Context<AdminRegistry>, partner: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    require!(!registry.is_partner(&partner), FlaconError::DuplicatePartner);
    require!(
        registry.partners.len() < MAX_PARTNERS as usize,
        FlaconError::PartnersFull
    );
    registry.partners.push(partner);
    emit!(PartnerAdded { partner });
    Ok(())
}

pub fn handle_add_site(ctx: Context<AdminRegistry>, site_id: u16, label: [u8; 32]) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    require!(site_id != 0, FlaconError::InvalidSiteId);
    require!(!registry.has_site(site_id), FlaconError::DuplicateSite);
    require!(
        registry.sites.len() < MAX_SITES as usize,
        FlaconError::SitesFull
    );
    registry.sites.push(Site { site_id, label });
    emit!(SiteAdded { site_id, label });
    Ok(())
}
