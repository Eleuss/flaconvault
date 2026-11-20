//! Parsing of the Solana Ed25519 precompile instruction that must precede `record_scan` and
//! `record_scan_v2`.
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
//! u16 message_data_size          (must be MSG_LEN = 152 for FVSCAN1, MSG2_LEN = 256 for FVSCAN2)
//! u16 message_instruction_index
//! ... pubkey (32) / signature (64) / message at the given offsets
//! ```
//! All values little endian. Instruction indices must be `u16::MAX` ("this
//! instruction", what `Ed25519Program.createInstructionWithPublicKey` emits) or the
//! ed25519 instruction's own index. The runtime has already verified the
//! signature by the time our instruction runs — if it were wrong the whole
//! transaction would have failed — so we only have to check *what* was signed
//! and *by whom*.

use anchor_lang::prelude::*;

use crate::{
    constants::MSG_LEN_BYTES,
    error::FlaconError,
};
#[cfg(test)]
use crate::constants::MSG2_LEN_BYTES;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

pub const ED25519_HEADER_LEN: usize = 16;
pub const ED25519_PUBKEY_LEN: usize = 32;
pub const ED25519_SIGNATURE_LEN: usize = 64;

/// Public key and signed message of a single-signature Ed25519 instruction with an `N`-byte message.
pub struct Ed25519PayloadN<const N: usize> {
    pub pubkey: [u8; ED25519_PUBKEY_LEN],
    pub message: [u8; N],
}

/// The v1 payload (152-byte FVSCAN1 message).
pub type Ed25519Payload = Ed25519PayloadN<MSG_LEN_BYTES>;

fn u16_at(data: &[u8], off: usize) -> Result<u16> {
    let b = data
        .get(off..off + 2)
        .ok_or(FlaconError::MalformedEd25519Instruction)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

fn index_ok(idx: u16, own_index: u16) -> bool {
    idx == u16::MAX || idx == own_index
}

/// Parse a single-signature ed25519 instruction whose pubkey and message live in
/// its own data, with a 152-byte (FVSCAN1) message. `own_index` is the position of the
/// ed25519 instruction in the tx.
pub fn parse_single_ed25519(data: &[u8], own_index: u16) -> Result<Ed25519Payload> {
    parse_single_ed25519_n::<MSG_LEN_BYTES>(data, own_index)
}

/// Like `parse_single_ed25519`, for an `N`-byte message (`record_scan_v2`: `MSG2_LEN_BYTES`). Any other
/// message size is `MalformedEd25519Instruction`, so a v1 signature never reaches the v2 checks and back.
pub fn parse_single_ed25519_n<const N: usize>(data: &[u8], own_index: u16) -> Result<Ed25519PayloadN<N>> {
    require!(
        data.len() >= ED25519_HEADER_LEN,
        FlaconError::MalformedEd25519Instruction
    );
    require!(data[0] == 1, FlaconError::MalformedEd25519Instruction);

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
        FlaconError::MalformedEd25519Instruction
    );
    require!(message_size == N, FlaconError::MalformedEd25519Instruction);

    let pubkey = data
        .get(public_key_offset..public_key_offset + ED25519_PUBKEY_LEN)
        .ok_or(FlaconError::MalformedEd25519Instruction)?;
    let message = data
        .get(message_offset..message_offset + message_size)
        .ok_or(FlaconError::MalformedEd25519Instruction)?;
    // the signature itself must be present too (bounds only; the precompile verified it)
    require!(
        signature_offset + ED25519_SIGNATURE_LEN <= data.len(),
        FlaconError::MalformedEd25519Instruction
    );

    let mut out = Ed25519PayloadN::<N> {
        pubkey: [0u8; ED25519_PUBKEY_LEN],
        message: [0u8; N],
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
        let msg: Vec<u8> = (0..MSG_LEN_BYTES as u32).map(|i| i as u8).collect();
        let d = build_ix_data(&pk, &sig, &msg);
        let p = parse_single_ed25519(&d, 0).unwrap();
        assert_eq!(p.pubkey, pk);
        assert_eq!(&p.message[..], &msg[..]);
    }

    #[test]
    fn rejects_wrong_len_or_count() {
        let pk = [7u8; 32];
        let sig = [9u8; 64];
        let short = vec![0u8; 151];
        assert!(parse_single_ed25519(&build_ix_data(&pk, &sig, &short), 0).is_err());
        let msg = vec![0u8; MSG_LEN_BYTES];
        let mut d = build_ix_data(&pk, &sig, &msg);
        d[0] = 2;
        assert!(parse_single_ed25519(&d, 0).is_err());
        assert!(parse_single_ed25519(&d[..10], 0).is_err());
    }

    #[test]
    fn v2_parses_256_bytes_only() {
        let pk = [7u8; 32];
        let sig = [9u8; 64];
        let msg: Vec<u8> = (0..MSG2_LEN_BYTES as u32).map(|i| (i * 3) as u8).collect();
        let d = build_ix_data(&pk, &sig, &msg);
        assert_eq!(d.len(), 16 + 32 + 64 + 256);
        let p = parse_single_ed25519_n::<MSG2_LEN_BYTES>(&d, 0).unwrap();
        assert_eq!(p.pubkey, pk);
        assert_eq!(&p.message[..], &msg[..]);
        // a 256-byte message is no v1 message, and a 152-byte one no v2 message
        assert!(parse_single_ed25519(&d, 0).is_err());
        let v1 = build_ix_data(&pk, &sig, &[0u8; MSG_LEN_BYTES]);
        assert!(parse_single_ed25519(&v1, 0).is_ok());
        assert!(parse_single_ed25519_n::<MSG2_LEN_BYTES>(&v1, 0).is_err());
        // truncated data (the message runs past the end)
        assert!(parse_single_ed25519_n::<MSG2_LEN_BYTES>(&d[..d.len() - 1], 0).is_err());
        // data that lives in another instruction
        let mut other = d.clone();
        other[14..16].copy_from_slice(&2u16.to_le_bytes());
        assert!(parse_single_ed25519_n::<MSG2_LEN_BYTES>(&other, 3).is_err());
        assert!(parse_single_ed25519_n::<MSG2_LEN_BYTES>(&other, 2).is_ok());
    }

    /// docs/vectors.json v2.scans[*].ed25519IxHex (368 bytes, the relayer's layout) parses to the vector message.
    #[test]
    fn v2_vector_instruction_data() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/vectors.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let hex = |s: &str| -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() };
        let pk = hex(v["serverTestKey"]["pubkeyHex"].as_str().unwrap());
        for s in v["v2"]["scans"].as_array().unwrap() {
            let d = hex(s["ed25519IxHex"].as_str().unwrap());
            assert_eq!(d.len(), 368, "{}", s["name"]);
            assert_eq!(&d[..16], &hex("01003000ffff1000ffff70000001ffff")[..]);
            let p = parse_single_ed25519_n::<MSG2_LEN_BYTES>(&d, 0).unwrap();
            assert_eq!(&p.pubkey[..], &pk[..]);
            assert_eq!(&p.message[..], &hex(s["msgHex"].as_str().unwrap())[..]);
            assert_eq!(&d[48..112], &hex(s["sigHex"].as_str().unwrap())[..]);
        }
    }

    #[test]
    fn index_rule() {
        assert!(index_ok(u16::MAX, 3));
        assert!(index_ok(3, 3));
        assert!(!index_ok(2, 3));
    }
}
