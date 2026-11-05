//! `init_holder_config` · `set_holder_config` (docs/public-record.md §7.1, §7.2). Registry authority only.
//! `cluster_tag` is set once: a program cannot tell which cluster it runs on, and devnet and mainnet may share the
//! program id, so every FVSCAN2 must carry the tag stored here.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::{HolderConfigInitialized, HolderConfigUpdated},
    state::{HolderConfig, Registry},
};

/// `cluster_tag ∈ {MAINNET, DEVNET, LOCALNET}`; 0 is never valid.
pub fn check_cluster_tag(cluster_tag: u8) -> Result<()> {
    require!(
        matches!(cluster_tag, CLUSTER_MAINNET | CLUSTER_DEVNET | CLUSTER_LOCALNET),
        FlaconError::InvalidClusterTag
    );
    Ok(())
}

/// Both delays within `MIN_HOLD_DELAY_S..=MAX_HOLD_DELAY_S` (1 day ..= 30 days).
pub fn check_delays(claim_delay_s: i64, notap_delay_s: i64) -> Result<()> {
    let ok = |d: i64| (MIN_HOLD_DELAY_S..=MAX_HOLD_DELAY_S).contains(&d);
    require!(ok(claim_delay_s) && ok(notap_delay_s), FlaconError::InvalidDelay);
    Ok(())
}

#[derive(Accounts)]
pub struct InitHolderConfig<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = payer,
        space = 8 + HolderConfig::INIT_SPACE,
        seeds = [HOLDER_CONFIG_SEED],
        bump
    )]
    pub holder_config: Account<'info, HolderConfig>,
    /// Must be the registry authority; becomes `holder_config.authority`.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_holder_config(
    ctx: Context<InitHolderConfig>,
    cluster_tag: u8,
    guardian: Pubkey,
    holder_key: Pubkey,
    registrar_key: Pubkey,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    require!(ctx.accounts.registry.is_authority(&authority), FlaconError::Unauthorized);
    check_cluster_tag(cluster_tag)?;

    let c = &mut ctx.accounts.holder_config;
    c.authority = authority;
    c.guardian = guardian;
    c.holder_key = holder_key;
    c.registrar_key = registrar_key;
    c.cluster_tag = cluster_tag;
    c.claim_delay_s = DEFAULT_CLAIM_DELAY_S;
    c.notap_delay_s = DEFAULT_NOTAP_DELAY_S;
    c.paused = false;
    c.last_heartbeat = 0;
    c.bump = ctx.bumps.holder_config;
    c.reserved = [0u8; 64];

    emit!(HolderConfigInitialized {
        holder_config: c.key(),
        authority,
        cluster_tag,
        guardian,
        holder_key,
        registrar_key,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetHolderConfig<'info> {
    #[account(mut, seeds = [HOLDER_CONFIG_SEED], bump = holder_config.bump)]
    pub holder_config: Account<'info, HolderConfig>,
    /// Must be the registry authority (not the copy in `holder_config.authority`).
    pub authority: Signer<'info>,
    /// Appended after `authority`, so the IDL positions 0 and 1 stay as they were.
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
}

/// Gated on the *current* registry authority: after `transfer_authority` the old key can no longer change the keys
/// and delays here, and the new one can. `holder_config.authority` is re-synced to it (it is a record of the registry
/// authority at the last init or set, never a governance root of its own). `cluster_tag`, `paused` and
/// `last_heartbeat` are not changeable here.
pub fn handle_set_holder_config(
    ctx: Context<SetHolderConfig>,
    guardian: Pubkey,
    holder_key: Pubkey,
    registrar_key: Pubkey,
    claim_delay_s: i64,
    notap_delay_s: i64,
) -> Result<()> {
    require!(
        ctx.accounts.registry.is_authority(&ctx.accounts.authority.key()),
        FlaconError::Unauthorized
    );
    check_delays(claim_delay_s, notap_delay_s)?;
    let c = &mut ctx.accounts.holder_config;
    c.authority = ctx.accounts.registry.authority;
    c.guardian = guardian;
    c.holder_key = holder_key;
    c.registrar_key = registrar_key;
    c.claim_delay_s = claim_delay_s;
    c.notap_delay_s = notap_delay_s;

    emit!(HolderConfigUpdated {
        guardian,
        holder_key,
        registrar_key,
        claim_delay_s,
        notap_delay_s,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(r: Result<()>) -> Option<u32> {
        match r {
            Ok(()) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Err(_) => Some(0),
        }
    }
    fn err(e: FlaconError) -> Option<u32> {
        Some(anchor_lang::error::ERROR_CODE_OFFSET + e as u32)
    }

    #[test]
    fn cluster_tags() {
        for t in [CLUSTER_MAINNET, CLUSTER_DEVNET, CLUSTER_LOCALNET] {
            assert_eq!(code(check_cluster_tag(t)), None);
        }
        for t in [0u8, 4, 255] {
            assert_eq!(code(check_cluster_tag(t)), err(FlaconError::InvalidClusterTag), "tag {t}");
        }
    }

    #[test]
    fn delay_bounds() {
        assert_eq!(code(check_delays(DEFAULT_CLAIM_DELAY_S, DEFAULT_NOTAP_DELAY_S)), None);
        assert_eq!(code(check_delays(MIN_HOLD_DELAY_S, MAX_HOLD_DELAY_S)), None);
        assert_eq!(code(check_delays(MIN_HOLD_DELAY_S - 1, DEFAULT_NOTAP_DELAY_S)), err(FlaconError::InvalidDelay));
        assert_eq!(code(check_delays(DEFAULT_CLAIM_DELAY_S, MAX_HOLD_DELAY_S + 1)), err(FlaconError::InvalidDelay));
        assert_eq!(code(check_delays(0, 0)), err(FlaconError::InvalidDelay));
        assert_eq!(code(check_delays(i64::MIN, i64::MAX)), err(FlaconError::InvalidDelay));
    }
}
