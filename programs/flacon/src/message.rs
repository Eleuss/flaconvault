//! Server signature message (briefing §4.3) — exactly these 152 bytes.
//!
//! ```text
//! "FVSCAN1" (7) ‖ serial_hash (32) ‖ uid_hash (32) ‖ counter u32 LE ‖ tamper ‖ uv ‖ hum ‖ heat ‖ fill
//! ‖ media_hash (32) ‖ nonce (32) ‖ ts i64 LE
//! ```
//! The server signs this; `record_scan` rebuilds it from the arguments and the
//! passport/seal accounts and compares it byte for byte with the message inside
//! the Ed25519 instruction.

use crate::constants::{MSG_LEN_BYTES, MSG_PREFIX};

pub struct ScanMessageFields<'a> {
    pub serial_hash: &'a [u8; 32],
    pub uid_hash: &'a [u8; 32],
    pub counter: u32,
    pub tamper: u8,
    pub uv: u8,
    pub hum: u8,
    pub heat: u8,
    pub fill: u8,
    pub media_hash: &'a [u8; 32],
    pub nonce: &'a [u8; 32],
    pub ts: i64,
}

pub const OFF_SERIAL_HASH: usize = 7;
pub const OFF_UID_HASH: usize = OFF_SERIAL_HASH + 32; // 39
pub const OFF_COUNTER: usize = OFF_UID_HASH + 32; // 71
pub const OFF_TAMPER: usize = OFF_COUNTER + 4; // 75
pub const OFF_UV: usize = OFF_TAMPER + 1; // 76
pub const OFF_HUM: usize = OFF_UV + 1; // 77
pub const OFF_HEAT: usize = OFF_HUM + 1; // 78
pub const OFF_FILL: usize = OFF_HEAT + 1; // 79
pub const OFF_MEDIA_HASH: usize = OFF_FILL + 1; // 80
pub const OFF_NONCE: usize = OFF_MEDIA_HASH + 32; // 112
pub const OFF_TS: usize = OFF_NONCE + 32; // 144
const _: () = assert!(OFF_TS + 8 == MSG_LEN_BYTES);
const _: () = assert!(MSG_PREFIX.len() == OFF_SERIAL_HASH);

pub fn build_scan_message(f: &ScanMessageFields) -> [u8; MSG_LEN_BYTES] {
    let mut m = [0u8; MSG_LEN_BYTES];
    m[..OFF_SERIAL_HASH].copy_from_slice(MSG_PREFIX);
    m[OFF_SERIAL_HASH..OFF_UID_HASH].copy_from_slice(f.serial_hash);
    m[OFF_UID_HASH..OFF_COUNTER].copy_from_slice(f.uid_hash);
    m[OFF_COUNTER..OFF_TAMPER].copy_from_slice(&f.counter.to_le_bytes());
    m[OFF_TAMPER] = f.tamper;
    m[OFF_UV] = f.uv;
    m[OFF_HUM] = f.hum;
    m[OFF_HEAT] = f.heat;
    m[OFF_FILL] = f.fill;
    m[OFF_MEDIA_HASH..OFF_NONCE].copy_from_slice(f.media_hash);
    m[OFF_NONCE..OFF_TS].copy_from_slice(f.nonce);
    m[OFF_TS..].copy_from_slice(&f.ts.to_le_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }
    fn hex32(s: &str) -> [u8; 32] {
        hex(s).try_into().expect("32 bytes")
    }

    fn vectors() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("docs/vectors.json")).unwrap()
    }

    #[test]
    fn constants_match_vectors() {
        let v = vectors();
        assert_eq!(v["constants"]["MSG_PREFIX"].as_str().unwrap().as_bytes(), MSG_PREFIX);
        assert_eq!(v["constants"]["MSG_LEN"].as_u64().unwrap() as usize, MSG_LEN_BYTES);
        let seeds = &v["constants"]["PDA_SEEDS"];
        assert_eq!(seeds["registry"].as_str().unwrap().as_bytes(), crate::constants::REGISTRY_SEED);
        assert_eq!(seeds["passport"].as_str().unwrap().as_bytes(), crate::constants::PASSPORT_SEED);
        assert_eq!(seeds["seal"].as_str().unwrap().as_bytes(), crate::constants::SEAL_SEED);
        assert_eq!(seeds["scan"].as_str().unwrap().as_bytes(), crate::constants::SCAN_SEED);
        assert_eq!(seeds["origin"].as_str().unwrap().as_bytes(), crate::constants::ORIGIN_SEED);
    }

    /// scans[0].input reconstructed byte for byte == scans[0].msgHex (and every other scan too).
    #[test]
    fn reconstruction_matches_vectors() {
        let v = vectors();
        let scans = v["scans"].as_array().expect("scans[]");
        assert!(!scans.is_empty());
        for s in scans {
            let i = &s["input"];
            let msg = build_scan_message(&ScanMessageFields {
                serial_hash: &hex32(s["serialHashHex"].as_str().unwrap()),
                uid_hash: &hex32(s["uidHashHex"].as_str().unwrap()),
                counter: i["counter"].as_u64().unwrap() as u32,
                tamper: i["tamper"].as_u64().unwrap() as u8,
                uv: i["uv"].as_u64().unwrap() as u8,
                hum: i["hum"].as_u64().unwrap() as u8,
                heat: i["heat"].as_u64().unwrap() as u8,
                fill: i["fill"].as_u64().unwrap() as u8,
                media_hash: &hex32(i["mediaHashHex"].as_str().unwrap()),
                nonce: &hex32(i["nonceHex"].as_str().unwrap()),
                ts: i["ts"].as_i64().unwrap(),
            });
            let expected = hex(s["msgHex"].as_str().unwrap());
            assert_eq!(expected.len(), MSG_LEN_BYTES);
            assert_eq!(&msg[..], &expected[..], "scan {}", s["name"]);
        }
    }

    /// Hard-coded copy of scans[0] so the layout is pinned even without the fixture file.
    #[test]
    fn scans0_hardcoded() {
        let msg = build_scan_message(&ScanMessageFields {
            serial_hash: &hex32("4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583"),
            uid_hash: &hex32("8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442"),
            counter: 14,
            tamper: 3,
            uv: 3,
            hum: 0,
            heat: 0,
            fill: 92,
            media_hash: &hex32("358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380"),
            nonce: &hex32("9e3f156324d42f0ea4b6f4fce81d56fbd64a2143a3fdd60a130d9c90e5b4d688"),
            ts: 1790000012,
        });
        let expected = hex(concat!(
            "46565343414e31",
            "4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583",
            "8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442",
            "0e000000", "03", "03", "00", "00", "5c",
            "358bd5e49a401b60105ca4fe2f6fd4563c617295f4704debe35da7844cd5b380",
            "9e3f156324d42f0ea4b6f4fce81d56fbd64a2143a3fdd60a130d9c90e5b4d688",
            "8c3bb16a00000000"
        ));
        assert_eq!(&msg[..], &expected[..]);
    }
}
