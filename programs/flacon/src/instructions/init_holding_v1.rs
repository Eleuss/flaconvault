//! `init_holding_v1` (docs/public-record.md §7.3): the Holding of a passport minted with v1 `mint_passport`, so it can
//! take `record_scan_v2` scans. The registry authority or a registered partner signs (the check `mint_passport` applies
//! to its issuer), a separate payer pays. Every v1 mint path (the partner console, `scripts/bind-chip.ts`,
//! `scripts/seed-passports.ts`) sends it in the same transaction right after `mint_passport`, so a passport minted after
//! the public-record rollout takes relay scans at once; `scripts/init-holdings.ts` covers the passports minted before.
//! A v1 passport points at a Core asset (or, for very old ones, a placeholder), so its Holding starts in state WALLET:
//! the Core-asset owner rule applies, no commitment. The content is fixed (nothing the signer chooses), so letting any
//! current partner create it gives nobody power over a passport. A v2 passport already has its Holding from
//! `mint_passport_v2`, so `init` fails there.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::HoldingInitialized,
    state::{Holding, Passport, Registry},
};

#[derive(Accounts)]
pub struct InitHoldingV1<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        seeds = [PASSPORT_SEED, passport.serial_hash.as_ref()],
        bump = passport.bump
    )]
    pub passport: Account<'info, Passport>,
    #[account(
        init,
        payer = payer,
        space = 8 + Holding::INIT_SPACE,
        seeds = [HOLDING_SEED, passport.key().as_ref()],
        bump
    )]
    pub holding: Account<'info, Holding>,
    /// The registry authority or a registered partner (as the issuer of `mint_passport`).
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_holding_v1(ctx: Context<InitHoldingV1>) -> Result<()> {
    require!(
        ctx.accounts.registry.is_partner_or_authority(&ctx.accounts.authority.key()),
        FlaconError::Unauthorized
    );
    let passport = ctx.accounts.passport.key();
    let h = &mut ctx.accounts.holding;
    h.passport = passport;
    h.state = HOLDING_STATE_WALLET;
    h.epoch = 0;
    h.commitment = [0u8; 32];
    h.scan_head = [0u8; 32];
    h.head_count = 0;
    h.last_actor_kind = 0;
    h.last_actor = [0u8; 32];
    h.last_purpose = 0;
    h.last_scan_ts = 0;
    h.pending_kind = 0;
    h.pending_target = [0u8; 32];
    h.unlock_at = 0;
    h.bump = ctx.bumps.holding;
    h.reserved = [0u8; 32];

    emit!(HoldingInitialized {
        passport,
        holding: h.key(),
        state: h.state,
        epoch: h.epoch,
        commitment: h.commitment,
    });
    Ok(())
}
