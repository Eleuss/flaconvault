//! FlaconVault `flacon` program — passport, seals and server-signed scan proofs
//! for collectible perfume bottles (Dev-Briefing v2 §6).
//!
//! v1 (`record_scan`, FVSCAN1): one ScanProof PDA per scan, paid by the attesting wallet.
//! v2 public record (docs/public-record.md, P1): `record_scan_v2` (FVSCAN2) creates no account; FlaconVault's
//! relayer pays only the fee, and the scan is folded into the passport's `Holding.scan_head`.
//!
//! Deliberately NOT here: Merkle batching, role tokens, encryption, multisig,
//! the `Origin` account.

pub mod constants;
pub mod ed25519;
pub mod error;
pub mod events;
pub mod grade;
pub mod instructions;
pub mod message;
pub mod message_v2;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::FlaconError;
pub use instructions::*;
pub use state::*;

declare_id!("7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL");

#[program]
pub mod flacon {
    use super::*;

    /// Creates the singleton registry; the payer becomes `authority`. Only the program's upgrade
    /// authority (checked through the ProgramData account) may call it.
    pub fn init_registry(ctx: Context<InitRegistry>) -> Result<()> {
        instructions::init_registry::handle_init_registry(ctx)
    }

    /// Authority only. `valid_to == 0` = open-ended.
    pub fn add_server_key(
        ctx: Context<AdminRegistry>,
        key_id: u8,
        pubkey: [u8; 32],
        valid_from: i64,
        valid_to: i64,
    ) -> Result<()> {
        instructions::registry_admin::handle_add_server_key(ctx, key_id, pubkey, valid_from, valid_to)
    }

    /// Authority only. Ends the key's validity now (`valid_to = clock − 1`); the entry is kept.
    pub fn revoke_server_key(ctx: Context<AdminRegistry>, key_id: u8) -> Result<()> {
        instructions::registry_admin::handle_revoke_server_key(ctx, key_id)
    }

    /// Authority only.
    pub fn add_partner(ctx: Context<AdminRegistry>, partner: Pubkey) -> Result<()> {
        instructions::registry_admin::handle_add_partner(ctx, partner)
    }

    /// Authority only. The removed wallet also loses `attach_seal` / `mark_seal_dead` on its passports.
    pub fn remove_partner(ctx: Context<AdminRegistry>, partner: Pubkey) -> Result<()> {
        instructions::registry_admin::handle_remove_partner(ctx, partner)
    }

    /// Current and new authority both sign.
    pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
        instructions::registry_admin::handle_transfer_authority(ctx)
    }

    /// Authority only. `label` is UTF-8, zero padded to 32 bytes.
    pub fn add_site(ctx: Context<AdminRegistry>, site_id: u16, label: [u8; 32]) -> Result<()> {
        instructions::registry_admin::handle_add_site(ctx, site_id, label)
    }

    /// Partner (or authority) only. Birth certificate of a bottle. `asset` must be a Metaplex Core
    /// asset owned by the issuer, passed again as the `core_asset` account.
    pub fn mint_passport(
        ctx: Context<MintPassport>,
        serial_hash: [u8; 32],
        binding_hash: [u8; 32],
        asset: Pubkey,
    ) -> Result<()> {
        instructions::mint_passport::handle_mint_passport(ctx, serial_hash, binding_hash, asset)
    }

    /// The passport's issuer (while a partner) or the authority. `kind` ∈ {BOX, NECK}; at most
    /// `MAX_SEALS_PER_PASSPORT` seals; not on a void passport.
    pub fn attach_seal(ctx: Context<AttachSeal>, uid_hash: [u8; 32], kind: u8) -> Result<()> {
        instructions::attach_seal::handle_attach_seal(ctx, uid_hash, kind)
    }

    /// The passport's issuer (while a partner) or the authority. Seal no longer answers → seal dead,
    /// passport void, grade VOID.
    pub fn mark_seal_dead(ctx: Context<MarkSealDead>) -> Result<()> {
        instructions::mark_seal_dead::handle_mark_seal_dead(ctx)
    }

    /// The core: anchors one server-signed scan. Must be preceded in the same
    /// transaction by an `Ed25519Program` instruction over the §4.3 message.
    pub fn record_scan(ctx: Context<RecordScan>, args: RecordScanArgs) -> Result<()> {
        instructions::record_scan::handle_record_scan(ctx, args)
    }

    // ---- v2 public record (docs/public-record.md §7) ----------------------------------

    /// Registry authority only, once. `cluster_tag` ∈ {1 MAINNET, 2 DEVNET, 3 LOCALNET} is immutable; every
    /// FVSCAN2 must carry it.
    pub fn init_holder_config(
        ctx: Context<InitHolderConfig>,
        cluster_tag: u8,
        guardian: Pubkey,
        holder_key: Pubkey,
        registrar_key: Pubkey,
    ) -> Result<()> {
        instructions::holder_config::handle_init_holder_config(ctx, cluster_tag, guardian, holder_key, registrar_key)
    }

    /// Registry authority only (the current one; `holder_config.authority` is re-synced to it). Delays within
    /// `MIN_HOLD_DELAY_S..=MAX_HOLD_DELAY_S`.
    pub fn set_holder_config(
        ctx: Context<SetHolderConfig>,
        guardian: Pubkey,
        holder_key: Pubkey,
        registrar_key: Pubkey,
        claim_delay_s: i64,
        notap_delay_s: i64,
    ) -> Result<()> {
        instructions::holder_config::handle_set_holder_config(ctx, guardian, holder_key, registrar_key, claim_delay_s, notap_delay_s)
    }

    /// Registry authority or a registered partner, separate payer. The Holding (state WALLET) of a passport minted
    /// with v1 `mint_passport`, so it can take `record_scan_v2` scans; v1 mints send it right after `mint_passport`.
    pub fn init_holding_v1(ctx: Context<InitHoldingV1>) -> Result<()> {
        instructions::init_holding_v1::handle_init_holding_v1(ctx)
    }

    /// Partner (or authority) signs, separate payer. A pass held in a FlaconVault account: no Core asset,
    /// `passport.asset` = the new Holding PDA (state ACCOUNT, epoch 0, `commitment` ≠ 0).
    pub fn mint_passport_v2(
        ctx: Context<MintPassportV2>,
        serial_hash: [u8; 32],
        binding_hash: [u8; 32],
        commitment: [u8; 32],
    ) -> Result<()> {
        instructions::mint_passport_v2::handle_mint_passport_v2(ctx, serial_hash, binding_hash, commitment)
    }

    /// `attach_seal` with a separate payer.
    pub fn attach_seal_v2(ctx: Context<AttachSealV2>, uid_hash: [u8; 32], kind: u8) -> Result<()> {
        instructions::attach_seal_v2::handle_attach_seal_v2(ctx, uid_hash, kind)
    }

    /// Records one server-signed FVSCAN2 scan; must be a top-level instruction right after an `Ed25519Program`
    /// instruction over the 256-byte message. Creates nothing; any fee payer. Only HOLDER, WALLET and PARTNER
    /// scans change grade and void.
    pub fn record_scan_v2(ctx: Context<RecordScanV2>, server_key_id: u8) -> Result<()> {
        instructions::record_scan_v2::handle_record_scan_v2(ctx, server_key_id)
    }
}
