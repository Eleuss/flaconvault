//! Parsing of the Solana Ed25519 precompile instruction that must directly precede `open_and_deposit`
//! (the same pattern as `record_scan` in programs/flacon, re-implemented here so this program has no
//! dependency on the passport program).
//!
//! Data layout (solana `ed25519_program`):
//! ```text
//! u8  num_signatures            (must be 1)
//! u8  padding
//! u16 signature_offset
//! u16 signature_instruction_index
//! u16 public_key_offset
//! u16 public_key_instruction_index
//! u16 message_data_offset
//! u16 message_data_size          (must be OFFER_MSG_LEN = 201)
//! u16 message_instruction_index
//! ... pubkey (32) / signature (64) / message at the given offsets
//! ```
//! All values little endian. Instruction indices must be `u16::MAX` ("this instruction", what
//! `Ed25519Program.createInstructionWithPublicKey` emits) or the Ed25519 instruction's own index, so the
//! signed bytes cannot be borrowed from another instruction. The runtime has verified the signature
//! before our instruction runs (a wrong one fails the whole transaction), so only *what* was signed and
//! *by whom* is checked here.

use anchor_lang::prelude::*;

use crate::{error::MarketEscrowError, offer::OFFER_LEN};

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

pub const ED25519_HEADER_LEN: usize = 16;
pub const ED25519_PUBKEY_LEN: usize = 32;
pub const ED25519_SIGNATURE_LEN: usize = 64;

pub struct Ed25519Payload {
    pub pubkey: [u8; ED25519_PUBKEY_LEN],
    pub message: [u8; OFFER_LEN],
}

fn u16_at(data: &[u8], off: usize) -> Result<u16> {
    let b = data
        .get(off..off + 2)
        .ok_or(MarketEscrowError::MalformedEd25519Instruction)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

fn index_ok(idx: u16, own_index: u16) -> bool {
    idx == u16::MAX || idx == own_index
}

/// Parse a single-signature Ed25519 instruction whose pubkey and message live in its own data.
/// `own_index` is the position of the Ed25519 instruction in the transaction.
pub fn parse_single_ed25519(data: &[u8], own_index: u16) -> Result<Ed25519Payload> {
    require!(
        data.len() >= ED25519_HEADER_LEN,
        MarketEscrowError::MalformedEd25519Instruction
    );
    require!(data[0] == 1, MarketEscrowError::MalformedEd25519Instruction);

    let signature_offset = u16_at(data, 2)? as usize;
    let signature_ix = u16_at(data, 4)?;
    let public_key_offset = u16_at(data, 6)? as usize;
    let public_key_ix = u16_at(data, 8)?;
    let message_offset = u16_at(data, 10)? as usize;
    let message_size = u16_at(data, 12)? as usize;
    let message_ix = u16_at(data, 14)?;

    require!(
        index_ok(signature_ix, own_index)
            && index_ok(public_key_ix, own_index)
            && index_ok(message_ix, own_index),
        MarketEscrowError::MalformedEd25519Instruction
    );
    require!(
        message_size == OFFER_LEN,
        MarketEscrowError::MalformedEd25519Instruction
    );

    let pubkey = data
        .get(public_key_offset..public_key_offset + ED25519_PUBKEY_LEN)
        .ok_or(MarketEscrowError::MalformedEd25519Instruction)?;
    let message = data
        .get(message_offset..message_offset + message_size)
        .ok_or(MarketEscrowError::MalformedEd25519Instruction)?;
    // the signature itself must be present too (bounds only; the precompile verified it)
    require!(
        signature_offset + ED25519_SIGNATURE_LEN <= data.len(),
        MarketEscrowError::MalformedEd25519Instruction
    );

    let mut out = Ed25519Payload {
        pubkey: [0u8; ED25519_PUBKEY_LEN],
        message: [0u8; OFFER_LEN],
    };
    out.pubkey.copy_from_slice(pubkey);
    out.message.copy_from_slice(message);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same layout as web3.js `Ed25519Program.createInstructionWithPublicKey`.
    fn build_ix_data(pubkey: &[u8; 32], sig: &[u8; 64], msg: &[u8]) -> Vec<u8> {
        let pk_off = ED25519_HEADER_LEN as u16;
        let sig_off = pk_off + 32;
        let msg_off = sig_off + 64;
        let mut d = vec![1u8, 0u8];
        for v in [sig_off, u16::MAX, pk_off, u16::MAX, msg_off, msg.len() as u16, u16::MAX] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(pubkey);
        d.extend_from_slice(sig);
        d.extend_from_slice(msg);
        d
    }

    #[test]
    fn parses_web3js_layout() {
        let pk = [7u8; 32];
        let sig = [9u8; 64];
        let msg: Vec<u8> = (0..OFFER_LEN as u32).map(|i| i as u8).collect();
        let d = build_ix_data(&pk, &sig, &msg);
        let p = parse_single_ed25519(&d, 0).unwrap();
        assert_eq!(p.pubkey, pk);
        assert_eq!(&p.message[..], &msg[..]);
        // the instruction's own index is accepted as well as u16::MAX
        let mut own = d.clone();
        for off in [4usize, 8, 14] {
            own[off..off + 2].copy_from_slice(&2u16.to_le_bytes());
        }
        assert!(parse_single_ed25519(&own, 2).is_ok());
        assert!(parse_single_ed25519(&own, 3).is_err());
    }

    #[test]
    fn rejects_wrong_len_count_or_truncation() {
        let pk = [7u8; 32];
        let sig = [9u8; 64];
        assert!(parse_single_ed25519(&build_ix_data(&pk, &sig, &[0u8; OFFER_LEN - 1]), 0).is_err());
        assert!(parse_single_ed25519(&build_ix_data(&pk, &sig, &[0u8; OFFER_LEN + 1]), 0).is_err());
        // the 152-byte scan message of programs/flacon is not an offer
        assert!(parse_single_ed25519(&build_ix_data(&pk, &sig, &[0u8; 152]), 0).is_err());
        let msg = vec![0u8; OFFER_LEN];
        let mut two = build_ix_data(&pk, &sig, &msg);
        two[0] = 2;
        assert!(parse_single_ed25519(&two, 0).is_err());
        let d = build_ix_data(&pk, &sig, &msg);
        assert!(parse_single_ed25519(&d[..10], 0).is_err());
        assert!(parse_single_ed25519(&d[..d.len() - 1], 0).is_err());
    }

    #[test]
    fn rejects_data_borrowed_from_another_instruction() {
        let msg = vec![0u8; OFFER_LEN];
        let d = build_ix_data(&[7u8; 32], &[9u8; 64], &msg);
        for off in [4usize, 8, 14] {
            let mut x = d.clone();
            x[off..off + 2].copy_from_slice(&0u16.to_le_bytes());
            assert!(parse_single_ed25519(&x, 1).is_err(), "index field at {off}");
        }
    }
}
