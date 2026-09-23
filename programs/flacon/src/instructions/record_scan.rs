//! `record_scan` — the core instruction (briefing §6). Checks, in this order,
//! each with its own error code:
//!
//! 1. The instruction right before this one is a Solana Ed25519 precompile
//!    instruction; its pubkey is the registry server key `args.server_key_id`,
//!    valid at `args.ts`; its 152-byte message equals the reconstruction from
//!    `args` + `passport.serial_hash` + `seal.uid_hash` byte for byte.
//! 2. `seal.passport == passport`, `!seal.dead`, `!passport.void`,
//!    `args.counter > seal.last_counter`.
//! 3. Role/tier/field validation; tier ≥ 3 or role VAULT/PARTNER needs a partner attester.
//! 4. Create the `ScanProof` PDA, bump `seal.last_counter`, `passport.scan_count`,
//!    recompute `passport.grade`.
//!
//! `scan_proof` uses `init_if_needed` (Anchor creates accounts before the handler
//! runs): a re-used counter then reaches step 2 and fails with the typed
//! `CounterNotIncreasing` instead of a raw "account already in use" system error.
//! Re-initialisation is impossible: a ScanProof for counter N exists only if
//! `seal.last_counter >= N`, and step 2 rejects every `counter <= last_counter`
//! before anything is written.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    constants::*,
    ed25519::{parse_single_ed25519, ED25519_PROGRAM_ID},
    error::FlaconError,
    events::ScanRecorded,
    grade::grade,
    message::{build_scan_message, ScanMessageFields},
    state::{Passport, Registry, ScanProof, Seal},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordScanArgs {
    pub counter: u32,
    pub tier: u8,
    pub role: u8,
    pub tamper: u8,
    pub uv: u8,
    pub hum: u8,
    pub heat: u8,
    /// 6-bit mask, bit i = Thermax field i; bit 4 (40 °C) is the decisive one.
    pub heat_levels: u8,
    pub fill: u8,
    /// 0 = none; otherwise a registered site (only with role VAULT/PARTNER).
    pub site_id: u16,
    pub media_hash: [u8; 32],
    pub bundle_hash: [u8; 32],
    pub nonce: [u8; 32],
    pub ts: i64,
    pub server_key_id: u8,
}

#[derive(Accounts)]
#[instruction(args: RecordScanArgs)]
pub struct RecordScan<'info> {
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
        bump = seal.bump
    )]
    pub seal: Account<'info, Seal>,
    /// One PDA per accepted scan: `["scan", seal, counter LE]` (see module docs for `init_if_needed`).
    #[account(
        init_if_needed,
        payer = attester,
        space = 8 + ScanProof::INIT_SPACE,
        seeds = [SCAN_SEED, seal.key().as_ref(), &args.counter.to_le_bytes()],
        bump
    )]
    pub scan_proof: Account<'info, ScanProof>,
    /// The wallet that attests the scan; pays for the ScanProof.
    #[account(mut)]
    pub attester: Signer<'info>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = solana_instructions_sysvar::ID @ FlaconError::InvalidInstructionsSysvar)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_record_scan(ctx: Context<RecordScan>, args: RecordScanArgs) -> Result<()> {
    let registry = &ctx.accounts.registry;
    let attester = ctx.accounts.attester.key();

    // ---- 1. ed25519 instruction right before us -----------------------------
    let ix_sysvar = ctx.accounts.instructions.to_account_info();
    let current_index = load_current_index_checked(&ix_sysvar)
        .map_err(|_| FlaconError::InvalidInstructionsSysvar)?;
    require!(current_index > 0, FlaconError::MissingEd25519Instruction);
    let ed_index = current_index - 1;
    let ed_ix = load_instruction_at_checked(ed_index as usize, &ix_sysvar)
        .map_err(|_| FlaconError::MissingEd25519Instruction)?;
    require!(
        ed_ix.program_id.as_ref() == ED25519_PROGRAM_ID.as_ref(),
        FlaconError::MissingEd25519Instruction
    );
    let payload = parse_single_ed25519(&ed_ix.data, ed_index)?;

    let server_key = registry
        .server_key(args.server_key_id)
        .ok_or(FlaconError::UnknownServerKey)?;
    require!(
        payload.pubkey == server_key.pubkey,
        FlaconError::ServerKeyMismatch
    );
    require!(
        args.ts >= server_key.valid_from
            && (server_key.valid_to == 0 || args.ts <= server_key.valid_to),
        FlaconError::ServerKeyNotValidAtTs
    );

    let expected = build_scan_message(&ScanMessageFields {
        serial_hash: &ctx.accounts.passport.serial_hash,
        uid_hash: &ctx.accounts.seal.uid_hash,
        counter: args.counter,
        tamper: args.tamper,
        uv: args.uv,
        hum: args.hum,
        heat: args.heat,
        fill: args.fill,
        media_hash: &args.media_hash,
        nonce: &args.nonce,
        ts: args.ts,
    });
    require!(payload.message == expected, FlaconError::MessageMismatch);

    // ---- 2. seal / passport state ------------------------------------------
    let seal = &ctx.accounts.seal;
    let passport = &ctx.accounts.passport;
    require_keys_eq!(
        seal.passport,
        passport.key(),
        FlaconError::SealPassportMismatch
    );
    require!(!seal.dead, FlaconError::SealDead);
    require!(!passport.void, FlaconError::PassportVoid);
    require!(
        args.counter > seal.last_counter,
        FlaconError::CounterNotIncreasing
    );

    // ---- 3. role / tier / fields --------------------------------------------
    require!(args.role <= MAX_ROLE, FlaconError::InvalidRole);
    require!(args.tier <= MAX_TIER, FlaconError::InvalidTier);
    let role_is_pro = args.role == ROLE_VAULT || args.role == ROLE_PARTNER;
    if !role_is_pro {
        require!(
            args.tier <= TIER_SELF_MEDIA,
            FlaconError::TierNotAllowedForRole
        );
    }
    if role_is_pro || args.tier >= TIER_CERTIFIED {
        require!(registry.is_partner(&attester), FlaconError::NotPartner);
    }
    if args.site_id != 0 {
        require!(role_is_pro, FlaconError::SiteIdNotAllowed);
        require!(registry.has_site(args.site_id), FlaconError::UnknownSite);
    }
    require!(
        args.tamper <= MAX_INDICATOR
            && args.uv <= MAX_INDICATOR
            && args.hum <= MAX_INDICATOR
            && args.heat <= MAX_INDICATOR,
        FlaconError::InvalidIndicator
    );
    require!(args.fill <= MAX_FILL, FlaconError::InvalidFill);
    require!(
        args.heat_levels < (1u8 << HEAT_LEVELS_BITS),
        FlaconError::InvalidHeatLevels
    );
    if args.heat == INDICATOR_INTACT || args.heat == INDICATOR_TRIGGERED {
        let decisive = (args.heat_levels >> HEAT_DECISIVE_INDEX) & 1;
        require!(args.heat == decisive, FlaconError::HeatInconsistent);
    }

    // ---- 4. write ----------------------------------------------------------
    let new_grade = grade(args.tamper, args.heat, args.hum, args.fill);
    let seal_key = seal.key();

    let sp = &mut ctx.accounts.scan_proof;
    sp.seal = seal_key;
    sp.counter = args.counter;
    sp.tier = args.tier;
    sp.role = args.role;
    sp.tamper = args.tamper;
    sp.uv = args.uv;
    sp.hum = args.hum;
    sp.heat = args.heat;
    sp.heat_levels = args.heat_levels;
    sp.fill = args.fill;
    sp.site_id = args.site_id;
    sp.media_hash = args.media_hash;
    sp.bundle_hash = args.bundle_hash;
    sp.attester = attester;
    sp.server_key_id = args.server_key_id;
    sp.ts = args.ts;
    sp.bump = ctx.bumps.scan_proof;
    let scan_proof_key = sp.key();

    let seal = &mut ctx.accounts.seal;
    let passport = &mut ctx.accounts.passport;
    seal.last_counter = args.counter;
    passport.scan_count = passport
        .scan_count
        .checked_add(1)
        .ok_or(FlaconError::ScanCountOverflow)?;
    passport.grade = new_grade;

    emit!(ScanRecorded {
        passport: passport.key(),
        seal: seal_key,
        scan_proof: scan_proof_key,
        attester,
        counter: args.counter,
        tier: args.tier,
        role: args.role,
        tamper: args.tamper,
        uv: args.uv,
        hum: args.hum,
        heat: args.heat,
        heat_levels: args.heat_levels,
        fill: args.fill,
        site_id: args.site_id,
        grade: new_grade,
        scan_count: passport.scan_count,
        server_key_id: args.server_key_id,
        ts: args.ts,
    });
    Ok(())
}
