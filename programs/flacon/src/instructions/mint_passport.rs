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
    /// CHECK: the Metaplex Core asset named by the `asset` argument; the handler checks the address,
    /// that Metaplex Core owns the account and that it is an `AssetV1`. Appended last so the
    /// indices of the accounts above stay unchanged.
    pub core_asset: UncheckedAccount<'info>,
}

/// `true` when an account (owner program + data) is a Metaplex Core `AssetV1`.
pub fn is_core_asset(owner_program: &Pubkey, data: &[u8]) -> bool {
    owner_program == &MPL_CORE_PROGRAM_ID && data.first() == Some(&MPL_CORE_KEY_ASSET_V1)
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
    let core_asset = &ctx.accounts.core_asset;
    require_keys_eq!(core_asset.key(), asset, FlaconError::AssetMismatch);
    require!(
        is_core_asset(core_asset.owner, &core_asset.try_borrow_data()?),
        FlaconError::InvalidAsset
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_asset_detection() {
        let core = MPL_CORE_PROGRAM_ID;
        assert!(is_core_asset(&core, &[1u8, 0, 0]));
        // collection (Key 5), uninitialised, empty, foreign owner, system-owned placeholder
        assert!(!is_core_asset(&core, &[5u8, 0]));
        assert!(!is_core_asset(&core, &[0u8]));
        assert!(!is_core_asset(&core, &[]));
        assert!(!is_core_asset(&Pubkey::new_unique(), &[1u8]));
        assert!(!is_core_asset(&anchor_lang::system_program::ID, &[]));
    }
}
