//! `attach_seal_v2` (docs/public-record.md §7.5): `attach_seal` with a separate payer, so the issuer key at the
//! sealing counter needs no SOL. Checks, writes and the `SealAttached` event exactly as `attach_seal`, in the same
//! order (`attach_seal::apply_attach_seal`).

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    instructions::attach_seal::apply_attach_seal,
    state::{Passport, Registry, Seal},
};

#[derive(Accounts)]
#[instruction(uid_hash: [u8; 32])]
pub struct AttachSealV2<'info> {
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
        payer = payer,
        space = 8 + Seal::INIT_SPACE,
        seeds = [SEAL_SEED, uid_hash.as_ref()],
        bump
    )]
    pub seal: Account<'info, Seal>,
    /// The passport's issuer while it is a partner, or the registry authority.
    pub signer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_attach_seal_v2(ctx: Context<AttachSealV2>, uid_hash: [u8; 32], kind: u8) -> Result<()> {
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
