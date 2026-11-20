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

impl ServerKey {
    /// `valid_from <= t` and (`valid_to == 0` or `t <= valid_to`).
    pub fn is_valid_at(&self, t: i64) -> bool {
        t >= self.valid_from && (self.valid_to == 0 || t <= self.valid_to)
    }
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
    pub fn server_key_mut(&mut self, key_id: u8) -> Option<&mut ServerKey> {
        self.server_keys.iter_mut().find(|k| k.key_id == key_id)
    }
    /// The passport's issuer while it is still a partner, or the registry authority. Removing a partner
    /// therefore also removes its power over the passports it issued.
    pub fn may_manage_passport(&self, key: &Pubkey, passport: &Passport) -> bool {
        self.is_authority(key) || (&passport.issuer == key && self.is_partner(key))
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

impl Passport {
    /// VOID either through the flag (dead seal, opened tamper loop) or through the grade.
    pub fn is_voided(&self) -> bool {
        self.void || self.grade == GRADE_VOID
    }
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

/// Seeds: `["holder_config"]` — the singleton settings of passes held in FlaconVault accounts
/// (docs/public-record.md §6.1). P1 uses `cluster_tag` (checked by `record_scan_v2`); the keys, delays,
/// `paused` and `last_heartbeat` are for the later phases (moves, claims, pause), which only add instructions.
#[account]
#[derive(InitSpace)]
pub struct HolderConfig {
    /// The registry authority at `init_holder_config` (immutable in P1).
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub holder_key: Pubkey,
    pub registrar_key: Pubkey,
    /// cluster enum (constants::CLUSTER_*), set once; every FVSCAN2 must carry it.
    pub cluster_tag: u8,
    pub claim_delay_s: i64,
    pub notap_delay_s: i64,
    /// Guards moves (P5); scans are evidence and ignore it.
    pub paused: bool,
    pub last_heartbeat: i64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

/// Seeds: `["holding", passport]` — the register entry of a passport (docs/public-record.md §6.2; the layout is
/// final from P1). `Passport.asset == this PDA` ⇒ the pass is held in a FlaconVault account under `commitment`;
/// otherwise the owner of the Core asset at `Passport.asset` holds it. Every `record_scan_v2` folds its message into
/// `scan_head`, so anyone can check that a list of v2 scans is complete and in order.
#[account]
#[derive(InitSpace)]
pub struct Holding {
    pub passport: Pubkey,
    /// holding_state enum (constants::HOLDING_STATE_*)
    pub state: u8,
    pub epoch: u32,
    /// sha256("FVHOLD1" ‖ passport ‖ epoch ‖ secret32); zero for a legacy (WALLET) holding.
    pub commitment: [u8; 32],
    pub scan_head: [u8; 32],
    pub head_count: u32,
    pub last_actor_kind: u8,
    pub last_actor: [u8; 32],
    pub last_purpose: u8,
    /// Signed `ts` of the last `record_scan_v2`.
    pub last_scan_ts: i64,
    /// P3/P4: NONE 0, NOTAP 1, CLAIM 2.
    pub pending_kind: u8,
    /// P3: the new commitment of a NOTAP move; P4: the wallet of a claim.
    pub pending_target: [u8; 32],
    pub unlock_at: i64,
    pub bump: u8,
    pub reserved: [u8; 32],
}

impl Holding {
    /// `HOLDER` and `RECIPIENT` scans need a pass held in an account (`HoldingNotInAccount` otherwise).
    pub fn is_held_in_account(&self, holding_key: &Pubkey, passport: &Passport) -> bool {
        self.state == HOLDING_STATE_ACCOUNT && &passport.asset == holding_key
    }
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

// Account layouts are frozen (devnet accounts exist): any change here breaks the upgrade.
const _ASSERT_LAYOUTS: () = {
    assert!(ServerKey::INIT_SPACE == 49);
    assert!(Site::INIT_SPACE == 34);
    assert!(Registry::INIT_SPACE == 32 + (4 + 8 * 49) + (4 + 16 * 32) + (4 + 16 * 34) + 1);
    assert!(Passport::INIT_SPACE == 32 + 32 + 32 + 32 + 1 + 4 + 1 + 1 + 8 + 1);
    assert!(Seal::INIT_SPACE == 32 + 1 + 32 + 4 + 1 + 8 + 1);
    assert!(ScanProof::INIT_SPACE == 32 + 4 + 8 + 2 + 32 + 32 + 32 + 1 + 8 + 1);
};

// The v2 accounts (docs/public-record.md §6): their layout is final from P1, later phases only add instructions.
const _ASSERT_V2_LAYOUTS: () = {
    assert!(HolderConfig::INIT_SPACE == 219);
    assert!(Holding::INIT_SPACE == 221);
    assert!(HolderConfig::INIT_SPACE == 4 * 32 + 1 + 8 + 8 + 1 + 8 + 1 + 64);
    assert!(Holding::INIT_SPACE == 32 + 1 + 4 + 32 + 32 + 4 + 1 + 32 + 1 + 8 + 1 + 32 + 8 + 1 + 32);
};

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountSerialize, Discriminator};

    fn serialized<T: AccountSerialize>(v: &T) -> Vec<u8> {
        let mut out = Vec::new();
        v.try_serialize(&mut out).unwrap();
        out
    }

    /// The data offsets of docs/public-record.md §6 (verify-pass and the verifier decode by them).
    #[test]
    fn holding_offsets() {
        let h = Holding {
            passport: Pubkey::new_from_array([1u8; 32]),
            state: 2,
            epoch: 0x0403_0201,
            commitment: [3u8; 32],
            scan_head: [4u8; 32],
            head_count: 0x0807_0605,
            last_actor_kind: 5,
            last_actor: [6u8; 32],
            last_purpose: 7,
            last_scan_ts: 0x0f0e_0d0c_0b0a_0908,
            pending_kind: 9,
            pending_target: [10u8; 32],
            unlock_at: 0x1716_1514_1312_1110,
            bump: 11,
            reserved: [12u8; 32],
        };
        let d = serialized(&h);
        assert_eq!(d.len(), 8 + 221);
        assert_eq!(&d[..8], Holding::DISCRIMINATOR);
        assert_eq!(&d[8..40], &[1u8; 32]);
        assert_eq!(d[40], 2);
        assert_eq!(&d[41..45], &0x0403_0201u32.to_le_bytes());
        assert_eq!(&d[45..77], &[3u8; 32]);
        assert_eq!(&d[77..109], &[4u8; 32]);
        assert_eq!(&d[109..113], &0x0807_0605u32.to_le_bytes());
        assert_eq!(d[113], 5);
        assert_eq!(&d[114..146], &[6u8; 32]);
        assert_eq!(d[146], 7);
        assert_eq!(&d[147..155], &0x0f0e_0d0c_0b0a_0908i64.to_le_bytes());
        assert_eq!(d[155], 9);
        assert_eq!(&d[156..188], &[10u8; 32]);
        assert_eq!(&d[188..196], &0x1716_1514_1312_1110i64.to_le_bytes());
        assert_eq!(d[196], 11);
        assert_eq!(&d[197..229], &[12u8; 32]);
    }

    #[test]
    fn holder_config_offsets() {
        let c = HolderConfig {
            authority: Pubkey::new_from_array([1u8; 32]),
            guardian: Pubkey::new_from_array([2u8; 32]),
            holder_key: Pubkey::new_from_array([3u8; 32]),
            registrar_key: Pubkey::new_from_array([4u8; 32]),
            cluster_tag: 5,
            claim_delay_s: DEFAULT_CLAIM_DELAY_S,
            notap_delay_s: DEFAULT_NOTAP_DELAY_S,
            paused: true,
            last_heartbeat: 0x0807_0605_0403_0201,
            bump: 6,
            reserved: [7u8; 64],
        };
        let d = serialized(&c);
        assert_eq!(d.len(), 8 + 219);
        assert_eq!(&d[..8], HolderConfig::DISCRIMINATOR);
        for (i, b) in [1u8, 2, 3, 4].iter().enumerate() {
            assert_eq!(&d[8 + 32 * i..40 + 32 * i], &[*b; 32]);
        }
        assert_eq!(d[136], 5);
        assert_eq!(&d[137..145], &DEFAULT_CLAIM_DELAY_S.to_le_bytes());
        assert_eq!(&d[145..153], &DEFAULT_NOTAP_DELAY_S.to_le_bytes());
        assert_eq!(d[153], 1);
        assert_eq!(&d[154..162], &0x0807_0605_0403_0201i64.to_le_bytes());
        assert_eq!(d[162], 6);
        assert_eq!(&d[163..227], &[7u8; 64]);
    }

    /// docs/vectors.json v2.discriminators (§2.2) equal what Anchor derives.
    #[test]
    fn discriminators_match_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/vectors.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let d = &v["v2"]["discriminators"];
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let pairs: [(&str, &[u8]); 9] = [
            ("global:record_scan_v2", crate::instruction::RecordScanV2::DISCRIMINATOR),
            ("global:init_holder_config", crate::instruction::InitHolderConfig::DISCRIMINATOR),
            ("global:set_holder_config", crate::instruction::SetHolderConfig::DISCRIMINATOR),
            ("global:init_holding_v1", crate::instruction::InitHoldingV1::DISCRIMINATOR),
            ("global:mint_passport_v2", crate::instruction::MintPassportV2::DISCRIMINATOR),
            ("global:attach_seal_v2", crate::instruction::AttachSealV2::DISCRIMINATOR),
            ("account:HolderConfig", HolderConfig::DISCRIMINATOR),
            ("account:Holding", Holding::DISCRIMINATOR),
            ("event:ScanRecordedV2", crate::events::ScanRecordedV2::DISCRIMINATOR),
        ];
        for (k, disc) in pairs {
            assert_eq!(d[k].as_str().unwrap(), hex(disc), "{k}");
        }
        assert_eq!(hex(crate::instruction::RecordScanV2::DISCRIMINATOR), "047bf48d93f81ff1");
    }
}
