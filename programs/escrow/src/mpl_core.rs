//! Minimal hand-rolled CPI to Metaplex Core `TransferV1`.
//!
//! The `mpl-core` crate (0.12) only supports anchor-lang ≤ 0.32 / solana-program 2.x,
//! whose `AccountInfo`/`Pubkey` types are incompatible with Anchor 1.2 (solana-* 3.x),
//! so we build the instruction by hand. Layout (mpl-core IDL):
//!
//! ```text
//! data:     [14u8 /* TransferV1 */, 0u8 /* compression_proof: None */]
//! accounts: 0 asset (writable) · 1 collection (optional) · 2 payer (signer, writable)
//!           3 authority (optional, signer) · 4 new_owner · 5 system_program (optional)
//!           6 log_wrapper (optional)
//! ```
//! Optional accounts that are absent are passed as the mpl-core program id (Metaplex convention).

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};

use crate::{constants::MPL_CORE_PROGRAM_ID, error::EscrowError};

pub const TRANSFER_V1_DISCRIMINATOR: u8 = 14;

pub struct CoreTransfer<'a, 'info> {
    pub asset: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    /// Current owner (or its delegate) — signs the CPI (a PDA via `signer_seeds`).
    pub authority: &'a AccountInfo<'info>,
    pub new_owner: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub core_program: &'a AccountInfo<'info>,
}

/// Transfers a Core asset (no collection) to `new_owner`. `signer_seeds` is empty when
/// `authority` is a real signer, or the PDA seeds when `authority` is the Order PDA.
pub fn transfer_v1(t: &CoreTransfer, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    require_keys_eq!(
        *t.core_program.key,
        MPL_CORE_PROGRAM_ID,
        EscrowError::InvalidCoreProgram
    );
    require_keys_eq!(*t.asset.owner, MPL_CORE_PROGRAM_ID, EscrowError::InvalidAsset);

    let ix = Instruction {
        program_id: MPL_CORE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*t.asset.key, false),
            AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // collection: none
            AccountMeta::new(*t.payer.key, true),
            AccountMeta::new_readonly(*t.authority.key, true),
            AccountMeta::new_readonly(*t.new_owner.key, false),
            AccountMeta::new_readonly(*t.system_program.key, false),
            AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // log wrapper: none
        ],
        data: vec![TRANSFER_V1_DISCRIMINATOR, 0],
    };
    invoke_signed(
        &ix,
        &[
            t.asset.clone(),
            t.core_program.clone(),
            t.payer.clone(),
            t.authority.clone(),
            t.new_owner.clone(),
            t.system_program.clone(),
            t.core_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}
