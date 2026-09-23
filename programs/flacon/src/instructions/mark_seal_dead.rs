use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::SealMarkedDead,
    state::{Passport, Registry, Seal},
};

#[derive(Accounts)]
pub struct MarkSealDead<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [PASSPORT_SEED, passport.serial_hash.as_ref()],
        bump = passport.bump
    )]
    pub passport: Account<'info, Passport>,
    #[account(
        mut,
        seeds = [SEAL_SEED, seal.uid_hash.as_ref()],
        bump = seal.bump,
        constraint = seal.passport == passport.key() @ FlaconError::SealPassportMismatch
    )]
    pub seal: Account<'info, Seal>,
    /// Must be a registered partner (or the registry authority) — after a
    /// confirmed no-response (escrow dispute or certification).
    pub signer: Signer<'info>,
}

pub fn handle_mark_seal_dead(ctx: Context<MarkSealDead>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    require!(
        ctx.accounts.registry.is_partner_or_authority(&signer),
        FlaconError::NotPartner
    );
    let now = Clock::get()?.unix_timestamp;

    let seal = &mut ctx.accounts.seal;
    let passport = &mut ctx.accounts.passport;
    seal.dead = true;
    passport.void = true;
    passport.grade = GRADE_VOID;

    emit!(SealMarkedDead {
        passport: passport.key(),
        seal: seal.key(),
        by: signer,
        ts: now,
    });
    Ok(())
}
