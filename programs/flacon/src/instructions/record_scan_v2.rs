//! `record_scan_v2(server_key_id)` (docs/public-record.md §7.6): records one server-signed FVSCAN2 scan without a
//! wallet, an account or a rent deposit. Whoever sends the transaction pays its fee (the verifier's relayer for a
//! visitor tap); no account is created, so there is no payer account (D7). Checks, in this order, each with its own
//! error (the same order as `record_scan.rs` where they overlap):
//!
//! 0. Top-level instruction only (`CpiNotAllowed`): the Ed25519 check reads the transaction's instruction list (D8).
//! 1. The instruction right before this one is an Ed25519 precompile instruction over a 256-byte message by the
//!    registry server key `server_key_id`; the message is FVSCAN2 for this program id and `holder_config.cluster_tag`;
//!    the key is valid at the signed `ts` and at the cluster clock, `|ts − clock| ≤ MAX_SCAN_TS_SKEW_S`; its
//!    `serial_hash` / `uid_hash` are the passport's and the seal's.
//! 2. `seal.passport == passport`, `!seal.dead`, passport not void, `seal.last_counter < counter <= MAX_COUNTER`.
//! 3. The §3.4 field rules (`message_v2::check_fields_v2`).
//! 4. The actor rule (`message_v2::check_actor_v2`): NONE (a visitor) needs nothing, HOLDER the Holding's current
//!    commitment, RECIPIENT a prepared other one, WALLET the Core-asset owner and PARTNER a registry partner as
//!    co-signers (`actor_signer`).
//! 5. Bump `seal.last_counter` and `passport.scan_count`; only HOLDER, WALLET and PARTNER scans change grade and void
//!    (`grade::passport_after_scan_v2`), visitor and RECIPIENT scans are evidence; fold the message into
//!    `holding.scan_head`, `head_count + 1`, and keep the last actor, purpose and ts. No ScanProof.
//! 6. `emit_cpi!(ScanRecordedV2)` with the full message.
//!
//! The signature is FlaconVault's: anyone can check it and that the folded list is complete (`verify-pass`); the
//! seal's secret check itself is done only by the verifier.

use anchor_lang::{prelude::*, solana_program::instruction::get_stack_height};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    constants::*,
    ed25519::{parse_single_ed25519_n, ED25519_PROGRAM_ID},
    error::FlaconError,
    events::ScanRecordedV2,
    grade::{actor_changes_grade, passport_after_scan_v2},
    instructions::record_scan::check_key_and_freshness,
    message_v2::{check_actor_v2, check_fields_v2, fold_scan_head, has_prefix_v2, parse_scan_message_v2, ActorContext},
    state::{HolderConfig, Holding, Passport, Registry, Seal},
};

#[event_cpi]
#[derive(Accounts)]
pub struct RecordScanV2<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(seeds = [HOLDER_CONFIG_SEED], bump = holder_config.bump)]
    pub holder_config: Box<Account<'info, HolderConfig>>,
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
    #[account(
        mut,
        seeds = [HOLDING_SEED, passport.key().as_ref()],
        bump = holding.bump
    )]
    pub holding: Box<Account<'info, Holding>>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = solana_instructions_sysvar::ID @ FlaconError::InvalidInstructionsSysvar)]
    pub instructions: UncheckedAccount<'info>,
    /// WALLET and PARTNER scans only: the actor co-signs. Otherwise the program id (Anchor's "none").
    pub actor_signer: Option<Signer<'info>>,
    /// CHECK: address, owner program and owner are checked in `check_actor_v2`.
    /// WALLET scans only: the account at `passport.asset`, a Metaplex Core asset owned by the actor. Otherwise the
    /// program id.
    pub asset: Option<UncheckedAccount<'info>>,
}

pub fn handle_record_scan_v2(ctx: Context<RecordScanV2>, server_key_id: u8) -> Result<()> {
    // ---- 0. top level only -----------------------------------------------------
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        FlaconError::CpiNotAllowed
    );

    // ---- 1. ed25519 instruction right before us --------------------------------
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
    let payload = parse_single_ed25519_n::<MSG2_LEN_BYTES>(&ed_ix.data, ed_index)?;

    let registry = &ctx.accounts.registry;
    let server_key = registry
        .server_key(server_key_id)
        .ok_or(FlaconError::UnknownServerKey)?;
    require!(
        payload.pubkey == server_key.pubkey,
        FlaconError::ServerKeyMismatch
    );
    require!(has_prefix_v2(&payload.message), FlaconError::InvalidMessagePrefix);
    let msg = parse_scan_message_v2(&payload.message);
    require!(msg.program_id == crate::ID.to_bytes(), FlaconError::WrongProgramId);
    require!(
        msg.cluster_tag == ctx.accounts.holder_config.cluster_tag,
        FlaconError::WrongCluster
    );
    let now = Clock::get()?.unix_timestamp;
    check_key_and_freshness(server_key, msg.ts, now)?;
    require!(
        msg.serial_hash == ctx.accounts.passport.serial_hash && msg.uid_hash == ctx.accounts.seal.uid_hash,
        FlaconError::MessageMismatch
    );

    // ---- 2. seal / passport state ----------------------------------------------
    let seal = &ctx.accounts.seal;
    let passport = &ctx.accounts.passport;
    require_keys_eq!(
        seal.passport,
        passport.key(),
        FlaconError::SealPassportMismatch
    );
    require!(!seal.dead, FlaconError::SealDead);
    require!(!passport.is_voided(), FlaconError::PassportVoid);
    require!(
        msg.counter > seal.last_counter,
        FlaconError::CounterNotIncreasing
    );
    require!(msg.counter <= MAX_COUNTER, FlaconError::CounterOutOfRange);

    // ---- 3. fields ---------------------------------------------------------------
    check_fields_v2(&msg, |site| registry.has_site(site))?;

    // ---- 4. actor ----------------------------------------------------------------
    let holding = &ctx.accounts.holding;
    let asset_info = ctx.accounts.asset.as_ref().map(|a| a.to_account_info());
    let asset_data = match &asset_info {
        Some(a) => Some(a.try_borrow_data()?),
        None => None,
    };
    check_actor_v2(
        &msg,
        &ActorContext {
            holding_state: holding.state,
            held_in_account: holding.is_held_in_account(&holding.key(), passport),
            commitment: &holding.commitment,
            signer: ctx.accounts.actor_signer.as_ref().map(|s| s.key()),
            asset: match (&asset_info, &asset_data) {
                (Some(a), Some(d)) => Some((a.key(), *a.owner, &d[..])),
                _ => None,
            },
            passport_asset: passport.asset,
        },
        |k| registry.is_partner(k),
    )?;
    drop(asset_data);

    // ---- 5. write ------------------------------------------------------------------
    let seal = &mut ctx.accounts.seal;
    seal.last_counter = msg.counter;
    let seal_key = seal.key();

    let passport = &mut ctx.accounts.passport;
    passport.scan_count = passport
        .scan_count
        .checked_add(1)
        .ok_or(FlaconError::ScanCountOverflow)?;
    if actor_changes_grade(msg.actor_kind) {
        let (grade, void) = passport_after_scan_v2(
            passport.grade,
            passport.void,
            msg.tamper,
            msg.heat,
            msg.hum,
            msg.fill,
        );
        passport.grade = grade;
        passport.void = void;
    }
    let (passport_key, grade, void, scan_count) =
        (passport.key(), passport.grade, passport.void, passport.scan_count);

    let holding = &mut ctx.accounts.holding;
    holding.scan_head = fold_scan_head(&holding.scan_head, &payload.message);
    holding.head_count = holding
        .head_count
        .checked_add(1)
        .ok_or(FlaconError::HeadCountOverflow)?;
    holding.last_actor_kind = msg.actor_kind;
    holding.last_actor = msg.actor;
    holding.last_purpose = msg.purpose;
    holding.last_scan_ts = msg.ts;
    let (holding_key, scan_head, head_count) = (holding.key(), holding.scan_head, holding.head_count);

    // ---- 6. event (self-CPI, carries the full message) -------------------------------
    emit_cpi!(ScanRecordedV2 {
        passport: passport_key,
        seal: seal_key,
        holding: holding_key,
        server_key_id,
        message: payload.message,
        grade,
        void,
        scan_count,
        scan_head,
        head_count,
    });
    Ok(())
}
