//! FlaconVault `flacon` program — passport, seals and server-signed scan proofs
//! for collectible perfume bottles (Dev-Briefing v2 §6).
//!
//! Deliberately NOT here: Merkle batching, role tokens, encryption, multisig,
//! the `Origin` account. One PDA per scan.

pub mod constants;
pub mod ed25519;
pub mod error;
pub mod events;
pub mod grade;
pub mod instructions;
pub mod message;
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

    /// Creates the singleton registry; the payer becomes `authority`.
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

    /// Authority only.
    pub fn add_partner(ctx: Context<AdminRegistry>, partner: Pubkey) -> Result<()> {
        instructions::registry_admin::handle_add_partner(ctx, partner)
    }

    /// Authority only. `label` is UTF-8, zero padded to 32 bytes.
    pub fn add_site(ctx: Context<AdminRegistry>, site_id: u16, label: [u8; 32]) -> Result<()> {
        instructions::registry_admin::handle_add_site(ctx, site_id, label)
    }

    /// Partner (or authority) only. Birth certificate of a bottle.
    pub fn mint_passport(
        ctx: Context<MintPassport>,
        serial_hash: [u8; 32],
        binding_hash: [u8; 32],
        asset: Pubkey,
    ) -> Result<()> {
        instructions::mint_passport::handle_mint_passport(ctx, serial_hash, binding_hash, asset)
    }

    /// Partner (or authority) only. `kind` ∈ {BOX, NECK}.
    pub fn attach_seal(ctx: Context<AttachSeal>, uid_hash: [u8; 32], kind: u8) -> Result<()> {
        instructions::attach_seal::handle_attach_seal(ctx, uid_hash, kind)
    }

    /// Partner (or authority) only. Seal no longer answers → seal dead, passport void, grade VOID.
    pub fn mark_seal_dead(ctx: Context<MarkSealDead>) -> Result<()> {
        instructions::mark_seal_dead::handle_mark_seal_dead(ctx)
    }

    /// The core: anchors one server-signed scan. Must be preceded in the same
    /// transaction by an `Ed25519Program` instruction over the §4.3 message.
    pub fn record_scan(ctx: Context<RecordScan>, args: RecordScanArgs) -> Result<()> {
        instructions::record_scan::handle_record_scan(ctx, args)
    }
}
