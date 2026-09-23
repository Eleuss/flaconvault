use anchor_lang::prelude::*;

#[event]
pub struct RegistryInitialized {
    pub registry: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct ServerKeyAdded {
    pub key_id: u8,
    pub pubkey: [u8; 32],
    pub valid_from: i64,
    pub valid_to: i64,
}

#[event]
pub struct PartnerAdded {
    pub partner: Pubkey,
}

#[event]
pub struct SiteAdded {
    pub site_id: u16,
    pub label: [u8; 32],
}

#[event]
pub struct PassportMinted {
    pub passport: Pubkey,
    pub serial_hash: [u8; 32],
    pub binding_hash: [u8; 32],
    pub asset: Pubkey,
    pub issuer: Pubkey,
    pub created_at: i64,
}

#[event]
pub struct SealAttached {
    pub passport: Pubkey,
    pub seal: Pubkey,
    pub uid_hash: [u8; 32],
    pub kind: u8,
    pub seal_count: u8,
    pub attached_at: i64,
}

#[event]
pub struct SealMarkedDead {
    pub passport: Pubkey,
    pub seal: Pubkey,
    pub by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ScanRecorded {
    pub passport: Pubkey,
    pub seal: Pubkey,
    pub scan_proof: Pubkey,
    pub attester: Pubkey,
    pub counter: u32,
    pub tier: u8,
    pub role: u8,
    pub tamper: u8,
    pub uv: u8,
    pub hum: u8,
    pub heat: u8,
    pub heat_levels: u8,
    pub fill: u8,
    pub site_id: u16,
    pub grade: u8,
    pub scan_count: u32,
    pub server_key_id: u8,
    pub ts: i64,
}
