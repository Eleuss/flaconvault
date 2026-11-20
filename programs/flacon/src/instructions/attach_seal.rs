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
    /// The passport's issuer while it is a partner, or the registry authority.
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_attach_seal(ctx: Context<AttachSeal>, uid_hash: [u8; 32], kind: u8) -> Result<()> {
    let bump = ctx.bumps.seal;
    apply_attach_seal(
        &ctx.accounts.registry,
        &mut ctx.accounts.passport,
        &mut ctx.accounts.seal,
        &ctx.accounts.signer.key(),
        uid_hash,
        kind,
        bump,
    )
}

/// Checks and writes of `attach_seal`, shared with `attach_seal_v2` (which only adds a separate payer):
/// `NotIssuerOrAuthority`, `InvalidSealKind`, `PassportVoid`, `TooManySeals`, in this order.
pub fn apply_attach_seal<'info>(
    registry: &Account<'info, Registry>,
    passport: &mut Account<'info, Passport>,
    seal: &mut Account<'info, Seal>,
    signer: &Pubkey,
    uid_hash: [u8; 32],
    kind: u8,
    bump: u8,
) -> Result<()> {
    require!(
        registry.may_manage_passport(signer, passport),
        FlaconError::NotIssuerOrAuthority
    );
    require!(
        kind == SEAL_KIND_BOX || kind == SEAL_KIND_NECK,
        FlaconError::InvalidSealKind
    );
    require!(!passport.is_voided(), FlaconError::PassportVoid);
    require!(
        passport.seal_count < MAX_SEALS_PER_PASSPORT,
        FlaconError::TooManySeals
    );
    let now = Clock::get()?.unix_timestamp;

    passport.seal_count = passport
        .seal_count
        .checked_add(1)
        .ok_or(FlaconError::SealCountOverflow)?;

    seal.passport = passport.key();
    seal.kind = kind;
    seal.uid_hash = uid_hash;
    seal.last_counter = 0;
    seal.dead = false;
    seal.attached_at = now;
    seal.bump = bump;

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
