use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::{
        AuthorityTransferred, PartnerAdded, PartnerRemoved, ServerKeyAdded, ServerKeyRevoked,
        SiteAdded,
    },
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

/// Ends a server key's validity now (`valid_to = clock − 1`). The entry stays in the registry so the
/// key_id cannot be reused for a different key and old ScanProofs keep their meaning.
pub fn handle_revoke_server_key(ctx: Context<AdminRegistry>, key_id: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx
        .accounts
        .registry
        .server_key_mut(key_id)
        .ok_or(FlaconError::UnknownServerKey)?;
    let valid_to = revoked_valid_to(key.valid_to, now)?;
    key.valid_to = valid_to;
    emit!(ServerKeyRevoked { key_id, valid_to });
    Ok(())
}

/// `valid_to` after a revocation at `now`: one second before `now`, so the key is invalid at once.
/// A key that already ended before `now` cannot be revoked again.
pub fn revoked_valid_to(current_valid_to: i64, now: i64) -> Result<i64> {
    require!(
        current_valid_to == 0 || current_valid_to >= now,
        FlaconError::ServerKeyAlreadyRevoked
    );
    // never 0: that would mean open-ended again
    Ok(now.saturating_sub(1).max(1))
}

pub fn handle_remove_partner(ctx: Context<AdminRegistry>, partner: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let idx = registry
        .partners
        .iter()
        .position(|p| p == &partner)
        .ok_or(FlaconError::PartnerNotFound)?;
    registry.partners.remove(idx);
    emit!(PartnerRemoved { partner });
    Ok(())
}

/// Hands the registry to a new authority. Both the current and the new authority sign, so a typo
/// cannot lock the registry.
#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ FlaconError::Unauthorized
    )]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
    pub new_authority: Signer<'info>,
}

pub fn handle_transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let previous = registry.authority;
    registry.authority = ctx.accounts.new_authority.key();
    emit!(AuthorityTransferred {
        previous,
        new_authority: registry.authority,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocation_sets_valid_to_in_the_past() {
        assert_eq!(revoked_valid_to(0, 1_000).unwrap(), 999);
        assert_eq!(revoked_valid_to(5_000, 1_000).unwrap(), 999);
        assert_eq!(revoked_valid_to(1_000, 1_000).unwrap(), 999);
        assert!(revoked_valid_to(999, 1_000).is_err());
        // never the open-ended sentinel 0
        assert_eq!(revoked_valid_to(0, 1).unwrap(), 1);
        assert_eq!(revoked_valid_to(0, 0).unwrap(), 1);
    }
}
