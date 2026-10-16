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
    /// that Metaplex Core owns the account, that it is an `AssetV1` and that the issuer owns it.
    /// Appended last so the indices of the accounts above stay unchanged.
    pub core_asset: UncheckedAccount<'info>,
}

/// `true` when an account (owner program + data) is a Metaplex Core `AssetV1`.
pub fn is_core_asset(owner_program: &Pubkey, data: &[u8]) -> bool {
    owner_program == &MPL_CORE_PROGRAM_ID && data.first() == Some(&MPL_CORE_KEY_ASSET_V1)
}

/// Owner of a Metaplex Core `AssetV1` (bytes 1..33 after the `Key` byte), or `None` when the account
/// is not one.
pub fn core_asset_owner(owner_program: &Pubkey, data: &[u8]) -> Option<Pubkey> {
    if !is_core_asset(owner_program, data) || data.len() < 33 {
        return None;
    }
    Pubkey::try_from(&data[1..33]).ok()
}

/// The asset checks of `mint_passport`: a Core `AssetV1` (else `InvalidAsset`) owned by the issuer
/// (else `AssetNotOwnedByIssuer`). The escrow lets the owner of the asset sell the bottle, so an asset
/// that belongs to somebody else (or already backs another issuer's passport) must never be bound.
pub fn check_mint_asset(owner_program: &Pubkey, data: &[u8], issuer: &Pubkey) -> Result<()> {
    let owner = core_asset_owner(owner_program, data).ok_or(FlaconError::InvalidAsset)?;
    require_keys_eq!(owner, *issuer, FlaconError::AssetNotOwnedByIssuer);
    Ok(())
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
    check_mint_asset(core_asset.owner, &core_asset.try_borrow_data()?, &issuer)?;
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
    fn asset_data(owner: &Pubkey) -> Vec<u8> {
        let mut d = vec![MPL_CORE_KEY_ASSET_V1];
        d.extend_from_slice(owner.as_ref());
        d.extend_from_slice(&[0u8; 8]);
        d
    }

    #[test]
    fn the_asset_must_belong_to_the_issuer() {
        let (issuer, stranger) = (Pubkey::new_unique(), Pubkey::new_unique());
        let core = MPL_CORE_PROGRAM_ID;
        assert_eq!(core_asset_owner(&core, &asset_data(&issuer)), Some(issuer));
        assert_eq!(code(check_mint_asset(&core, &asset_data(&issuer), &issuer)), None);
        assert_eq!(code(check_mint_asset(&core, &asset_data(&stranger), &issuer)), err(FlaconError::AssetNotOwnedByIssuer));
        // not an AssetV1 at all: InvalidAsset, whoever owns it
        assert_eq!(code(check_mint_asset(&Pubkey::new_unique(), &asset_data(&issuer), &issuer)), err(FlaconError::InvalidAsset));
        let mut collection = asset_data(&issuer);
        collection[0] = 5;
        assert_eq!(code(check_mint_asset(&core, &collection, &issuer)), err(FlaconError::InvalidAsset));
        // too short to hold an owner
        assert_eq!(core_asset_owner(&core, &[MPL_CORE_KEY_ASSET_V1, 1, 2]), None);
        assert_eq!(code(check_mint_asset(&core, &[MPL_CORE_KEY_ASSET_V1], &issuer)), err(FlaconError::InvalidAsset));
    }
}
