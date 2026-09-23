use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::PassportMinted,
    state::{Passport, Registry},
};

#[derive(Accounts)]
#[instruction(serial_hash: [u8; 32])]
pub struct MintPassport<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = issuer,
        space = 8 + Passport::INIT_SPACE,
        seeds = [PASSPORT_SEED, serial_hash.as_ref()],
        bump
    )]
    pub passport: Account<'info, Passport>,
    /// Must be a registered partner (or the registry authority).
    #[account(mut)]
    pub issuer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_mint_passport(
    ctx: Context<MintPassport>,
    serial_hash: [u8; 32],
    binding_hash: [u8; 32],
    asset: Pubkey,
) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    require!(
        ctx.accounts.registry.is_partner_or_authority(&issuer),
        FlaconError::NotPartner
    );
    let now = Clock::get()?.unix_timestamp;

    let passport = &mut ctx.accounts.passport;
    passport.serial_hash = serial_hash;
    passport.binding_hash = binding_hash;
    passport.asset = asset;
    passport.issuer = issuer;
    passport.grade = GRADE_A;
    passport.scan_count = 0;
    passport.seal_count = 0;
    passport.void = false;
    passport.created_at = now;
    passport.bump = ctx.bumps.passport;

    emit!(PassportMinted {
        passport: passport.key(),
        serial_hash,
        binding_hash,
        asset,
        issuer,
        created_at: now,
    });
    Ok(())
}
