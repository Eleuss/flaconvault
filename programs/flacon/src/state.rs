use anchor_lang::prelude::*;

use crate::constants::*;

/// One accepted server signing key. `valid_to == 0` means open-ended.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct ServerKey {
    pub key_id: u8,
    pub pubkey: [u8; 32],
    pub valid_from: i64,
    pub valid_to: i64,
}

/// A physical location (vault, partner shop). `label` is UTF-8, zero padded.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct Site {
    pub site_id: u16,
    pub label: [u8; 32],
}

/// Seeds: `["registry"]`
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub authority: Pubkey,
    #[max_len(8)]
    pub server_keys: Vec<ServerKey>,
    #[max_len(16)]
    pub partners: Vec<Pubkey>,
    #[max_len(16)]
    pub sites: Vec<Site>,
    pub bump: u8,
}

impl Registry {
    pub fn is_authority(&self, key: &Pubkey) -> bool {
        &self.authority == key
    }
    pub fn is_partner(&self, key: &Pubkey) -> bool {
        self.partners.iter().any(|p| p == key)
    }
    pub fn is_partner_or_authority(&self, key: &Pubkey) -> bool {
        self.is_authority(key) || self.is_partner(key)
    }
    pub fn server_key(&self, key_id: u8) -> Option<&ServerKey> {
        self.server_keys.iter().find(|k| k.key_id == key_id)
    }
    pub fn has_site(&self, site_id: u16) -> bool {
        self.sites.iter().any(|s| s.site_id == site_id)
    }
}

/// Seeds: `["passport", serial_hash]` — the bottle's birth certificate.
#[account]
#[derive(InitSpace)]
pub struct Passport {
    /// sha256(serial, UTF-8)
    pub serial_hash: [u8; 32],
    /// sha256(serial ‖ batch_code ‖ uid_hash_first_seal)
    pub binding_hash: [u8; 32],
    /// Metaplex Core asset (stored only, no CPI in this program).
    pub asset: Pubkey,
    pub issuer: Pubkey,
    /// grade enum (constants::GRADE_*)
    pub grade: u8,
    pub scan_count: u32,
    pub seal_count: u8,
    pub void: bool,
    pub created_at: i64,
    pub bump: u8,
}

/// Seeds: `["seal", uid_hash]` — one NFC seal (box or neck) pointing at a passport.
#[account]
#[derive(InitSpace)]
pub struct Seal {
    pub passport: Pubkey,
    /// seal_kind enum (constants::SEAL_KIND_*)
    pub kind: u8,
    /// sha256(uid bytes, 7)
    pub uid_hash: [u8; 32],
    pub last_counter: u32,
    pub dead: bool,
    pub attached_at: i64,
    pub bump: u8,
}

/// Seeds: `["scan", seal, counter u32 LE]` — one PDA per accepted scan.
#[account]
#[derive(InitSpace)]
pub struct ScanProof {
    pub seal: Pubkey,
    pub counter: u32,
    pub tier: u8,
    pub role: u8,
    pub tamper: u8,
    pub uv: u8,
    pub hum: u8,
    pub heat: u8,
    /// 6-bit mask, bit i = Thermax field i (29/33/34/37/40/42 °C); bit 4 is decisive.
    pub heat_levels: u8,
    pub fill: u8,
    /// 0 = none; otherwise a registry site (only for role VAULT/PARTNER).
    pub site_id: u16,
    pub media_hash: [u8; 32],
    pub bundle_hash: [u8; 32],
    pub attester: Pubkey,
    pub server_key_id: u8,
    pub ts: i64,
    pub bump: u8,
}

// `Origin` — seeds `["origin", passport]` — is RESERVED (briefing §6: batch, fill
// date, manufacturer signature for artisan houses). Deliberately not implemented;
// only the seed constant `ORIGIN_SEED` exists so the seed is fixed now.

#[allow(dead_code)]
const _ASSERT_CAPS: () = {
    assert!(MAX_SERVER_KEYS == 8);
    assert!(MAX_PARTNERS == 16);
    assert!(MAX_SITES == 16);
};
