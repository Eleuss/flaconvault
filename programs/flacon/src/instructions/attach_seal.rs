use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::SealAttached,
    state::{Passport, Registry, Seal},
};

#[derive(Accounts)]
#[instruction(uid_hash: [u8; 32])]
pub struct AttachSeal<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [PASSPORT_SEED, passport.serial_hash.as_ref()],
        bump = passport.bump
    )]
    pub passport: Account<'info, Passport>,
    #[account(
        init,
        payer = signer,
        space = 8 + Seal::INIT_SPACE,
        seeds = [SEAL_SEED, uid_hash.as_ref()],
        bump
    )]
    pub seal: Account<'info, Seal>,
    /// Must be a registered partner (or the registry authority).
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_attach_seal(ctx: Context<AttachSeal>, uid_hash: [u8; 32], kind: u8) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    require!(
        ctx.accounts.registry.is_partner_or_authority(&signer),
        FlaconError::NotPartner
    );
    require!(
        kind == SEAL_KIND_BOX || kind == SEAL_KIND_NECK,
        FlaconError::InvalidSealKind
    );
    let now = Clock::get()?.unix_timestamp;

    let passport = &mut ctx.accounts.passport;
    passport.seal_count = passport
        .seal_count
        .checked_add(1)
        .ok_or(FlaconError::SealCountOverflow)?;

    let seal = &mut ctx.accounts.seal;
    seal.passport = passport.key();
    seal.kind = kind;
    seal.uid_hash = uid_hash;
    seal.last_counter = 0;
    seal.dead = false;
    seal.attached_at = now;
    seal.bump = ctx.bumps.seal;

    emit!(SealAttached {
        passport: passport.key(),
        seal: seal.key(),
        uid_hash,
        kind,
        seal_count: passport.seal_count,
        attached_at: now,
    });
    Ok(())
}
