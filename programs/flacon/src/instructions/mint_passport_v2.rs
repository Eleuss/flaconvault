//! `mint_passport_v2` (docs/public-record.md §7.4): the birth certificate of a pass held in a FlaconVault account.
//! An issuer partner (or the authority) signs, a separate payer pays. No Core asset and no CPI: `Passport.asset` is the
//! new Holding PDA, which starts in state ACCOUNT at epoch 0 under `commitment`. The Passport layout is the frozen v1
//! one (the escrow deserializes it); the escrow refuses to sell a pass whose asset is a Holding (`PassHeldInAccount`).

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FlaconError,
    events::{HoldingInitialized, PassportMinted},
    state::{Holding, Passport, Registry},
};

#[derive(Accounts)]
#[instruction(serial_hash: [u8; 32])]
pub struct MintPassportV2<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = payer,
        space = 8 + Passport::INIT_SPACE,
        seeds = [PASSPORT_SEED, serial_hash.as_ref()],
        bump
    )]
    pub passport: Account<'info, Passport>,
    #[account(
        init,
        payer = payer,
        space = 8 + Holding::INIT_SPACE,
        seeds = [HOLDING_SEED, passport.key().as_ref()],
        bump
    )]
    pub holding: Box<Account<'info, Holding>>,
    /// Must be a registered partner (or the registry authority); becomes `passport.issuer`.
    pub issuer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_mint_passport_v2(
    ctx: Context<MintPassportV2>,
    serial_hash: [u8; 32],
    binding_hash: [u8; 32],
    commitment: [u8; 32],
) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    require!(
        ctx.accounts.registry.is_partner_or_authority(&issuer),
        FlaconError::NotPartner
    );
    require!(commitment != [0u8; 32], FlaconError::InvalidCommitment);
    let now = Clock::get()?.unix_timestamp;
    let holding_key = ctx.accounts.holding.key();

    let passport = &mut ctx.accounts.passport;
    passport.serial_hash = serial_hash;
    passport.binding_hash = binding_hash;
    passport.asset = holding_key;
    passport.issuer = issuer;
    passport.grade = GRADE_A;
    passport.scan_count = 0;
    passport.seal_count = 0;
    passport.void = false;
    passport.created_at = now;
    passport.bump = ctx.bumps.passport;
    let passport_key = passport.key();

    let h = &mut ctx.accounts.holding;
    h.passport = passport_key;
    h.state = HOLDING_STATE_ACCOUNT;
    h.epoch = 0;
    h.commitment = commitment;
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

    emit!(PassportMinted {
        passport: passport_key,
        serial_hash,
        binding_hash,
        asset: holding_key,
        issuer,
        created_at: now,
    });
    emit!(HoldingInitialized {
        passport: passport_key,
        holding: holding_key,
        state: HOLDING_STATE_ACCOUNT,
        epoch: 0,
        commitment,
    });
    Ok(())
}
