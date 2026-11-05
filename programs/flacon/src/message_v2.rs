//! FVSCAN2: the 256-byte server-signed scan message of `record_scan_v2` (docs/public-record.md §3).
//!
//! ```text
//! "FVSCAN2" (7) ‖ program_id (32) ‖ cluster_tag ‖ serial_hash (32) ‖ uid_hash (32) ‖ counter u32 LE ‖ tier ‖ role
//! ‖ tamper ‖ uv ‖ hum ‖ heat ‖ heat_levels ‖ fill ‖ site_id u16 LE ‖ purpose ‖ actor_kind ‖ actor (32)
//! ‖ media_hash (32) ‖ bundle_hash (32) ‖ nonce (32) ‖ ts i64 LE
//! ```
//! Unlike FVSCAN1 (`message.rs`, 152 bytes, unchanged) the server signs every field the program uses, so
//! `record_scan_v2` takes no field arguments: it parses this message out of the Ed25519 instruction (D6) and checks
//! it against the accounts. `program_id` and `cluster_tag` stop a signature from being replayed on another program
//! or cluster. The same layout lives in `packages/proof/src/message2.ts`; the tests below check both against
//! `docs/vectors.json` `v2`.
//!
//! Also here, the two Holding hashes (§4): the holder commitment and the scan-head fold.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::{constants::*, error::FlaconError};

/// The fields of one FVSCAN2 message (§3.1), in message order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanMessageV2 {
    pub program_id: [u8; 32],
    pub cluster_tag: u8,
    pub serial_hash: [u8; 32],
    pub uid_hash: [u8; 32],
    pub counter: u32,
    pub tier: u8,
    pub role: u8,
    pub tamper: u8,
    pub uv: u8,
    pub hum: u8,
    pub heat: u8,
    /// 6-bit mask, bit i = Thermax field i; bit 4 (40 °C) is the decisive one.
    pub heat_levels: u8,
    /// 0..=100, or FILL_NONE (no reading).
    pub fill: u8,
    /// 0 = none; otherwise a registered site (pro roles only).
    pub site_id: u16,
    pub purpose: u8,
    pub actor_kind: u8,
    /// Zero for NONE; the commitment for HOLDER / RECIPIENT; the signer's pubkey for WALLET / PARTNER (§3.2).
    pub actor: [u8; 32],
    pub media_hash: [u8; 32],
    pub bundle_hash: [u8; 32],
    pub nonce: [u8; 32],
    pub ts: i64,
}

pub const V2_OFF_PROGRAM_ID: usize = 7;
pub const V2_OFF_CLUSTER: usize = V2_OFF_PROGRAM_ID + 32; // 39
pub const V2_OFF_SERIAL_HASH: usize = V2_OFF_CLUSTER + 1; // 40
pub const V2_OFF_UID_HASH: usize = V2_OFF_SERIAL_HASH + 32; // 72
pub const V2_OFF_COUNTER: usize = V2_OFF_UID_HASH + 32; // 104
pub const V2_OFF_TIER: usize = V2_OFF_COUNTER + 4; // 108
pub const V2_OFF_ROLE: usize = V2_OFF_TIER + 1; // 109
pub const V2_OFF_TAMPER: usize = V2_OFF_ROLE + 1; // 110
pub const V2_OFF_UV: usize = V2_OFF_TAMPER + 1; // 111
pub const V2_OFF_HUM: usize = V2_OFF_UV + 1; // 112
pub const V2_OFF_HEAT: usize = V2_OFF_HUM + 1; // 113
pub const V2_OFF_HEAT_LEVELS: usize = V2_OFF_HEAT + 1; // 114
pub const V2_OFF_FILL: usize = V2_OFF_HEAT_LEVELS + 1; // 115
pub const V2_OFF_SITE_ID: usize = V2_OFF_FILL + 1; // 116
pub const V2_OFF_PURPOSE: usize = V2_OFF_SITE_ID + 2; // 118
pub const V2_OFF_ACTOR_KIND: usize = V2_OFF_PURPOSE + 1; // 119
pub const V2_OFF_ACTOR: usize = V2_OFF_ACTOR_KIND + 1; // 120
pub const V2_OFF_MEDIA_HASH: usize = V2_OFF_ACTOR + 32; // 152
pub const V2_OFF_BUNDLE_HASH: usize = V2_OFF_MEDIA_HASH + 32; // 184
pub const V2_OFF_NONCE: usize = V2_OFF_BUNDLE_HASH + 32; // 216
pub const V2_OFF_TS: usize = V2_OFF_NONCE + 32; // 248
const _: () = assert!(V2_OFF_TS + 8 == MSG2_LEN_BYTES);
const _: () = assert!(MSG2_PREFIX.len() == V2_OFF_PROGRAM_ID);

const ZERO32: [u8; 32] = [0u8; 32];

fn b32(m: &[u8; MSG2_LEN_BYTES], off: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&m[off..off + 32]);
    out
}

/// `true` when the message starts with "FVSCAN2" (`record_scan_v2` step 1, `InvalidMessagePrefix`).
pub fn has_prefix_v2(m: &[u8; MSG2_LEN_BYTES]) -> bool {
    &m[..V2_OFF_PROGRAM_ID] == MSG2_PREFIX
}

/// Reads every field at its offset. Checks nothing: the prefix is `has_prefix_v2`, the field rules `check_fields_v2`.
pub fn parse_scan_message_v2(m: &[u8; MSG2_LEN_BYTES]) -> ScanMessageV2 {
    let mut counter = [0u8; 4];
    counter.copy_from_slice(&m[V2_OFF_COUNTER..V2_OFF_TIER]);
    let mut ts = [0u8; 8];
    ts.copy_from_slice(&m[V2_OFF_TS..]);
    ScanMessageV2 {
        program_id: b32(m, V2_OFF_PROGRAM_ID),
        cluster_tag: m[V2_OFF_CLUSTER],
        serial_hash: b32(m, V2_OFF_SERIAL_HASH),
        uid_hash: b32(m, V2_OFF_UID_HASH),
        counter: u32::from_le_bytes(counter),
        tier: m[V2_OFF_TIER],
        role: m[V2_OFF_ROLE],
        tamper: m[V2_OFF_TAMPER],
        uv: m[V2_OFF_UV],
        hum: m[V2_OFF_HUM],
        heat: m[V2_OFF_HEAT],
        heat_levels: m[V2_OFF_HEAT_LEVELS],
        fill: m[V2_OFF_FILL],
        site_id: u16::from_le_bytes([m[V2_OFF_SITE_ID], m[V2_OFF_SITE_ID + 1]]),
        purpose: m[V2_OFF_PURPOSE],
        actor_kind: m[V2_OFF_ACTOR_KIND],
        actor: b32(m, V2_OFF_ACTOR),
        media_hash: b32(m, V2_OFF_MEDIA_HASH),
        bundle_hash: b32(m, V2_OFF_BUNDLE_HASH),
        nonce: b32(m, V2_OFF_NONCE),
        ts: i64::from_le_bytes(ts),
    }
}

/// The 256 message bytes of `f` (the inverse of `parse_scan_message_v2`).
pub fn build_scan_message_v2(f: &ScanMessageV2) -> [u8; MSG2_LEN_BYTES] {
    let mut m = [0u8; MSG2_LEN_BYTES];
    m[..V2_OFF_PROGRAM_ID].copy_from_slice(MSG2_PREFIX);
    m[V2_OFF_PROGRAM_ID..V2_OFF_CLUSTER].copy_from_slice(&f.program_id);
    m[V2_OFF_CLUSTER] = f.cluster_tag;
    m[V2_OFF_SERIAL_HASH..V2_OFF_UID_HASH].copy_from_slice(&f.serial_hash);
    m[V2_OFF_UID_HASH..V2_OFF_COUNTER].copy_from_slice(&f.uid_hash);
    m[V2_OFF_COUNTER..V2_OFF_TIER].copy_from_slice(&f.counter.to_le_bytes());
    m[V2_OFF_TIER] = f.tier;
    m[V2_OFF_ROLE] = f.role;
    m[V2_OFF_TAMPER] = f.tamper;
    m[V2_OFF_UV] = f.uv;
    m[V2_OFF_HUM] = f.hum;
    m[V2_OFF_HEAT] = f.heat;
    m[V2_OFF_HEAT_LEVELS] = f.heat_levels;
    m[V2_OFF_FILL] = f.fill;
    m[V2_OFF_SITE_ID..V2_OFF_PURPOSE].copy_from_slice(&f.site_id.to_le_bytes());
    m[V2_OFF_PURPOSE] = f.purpose;
    m[V2_OFF_ACTOR_KIND] = f.actor_kind;
    m[V2_OFF_ACTOR..V2_OFF_MEDIA_HASH].copy_from_slice(&f.actor);
    m[V2_OFF_MEDIA_HASH..V2_OFF_BUNDLE_HASH].copy_from_slice(&f.media_hash);
    m[V2_OFF_BUNDLE_HASH..V2_OFF_NONCE].copy_from_slice(&f.bundle_hash);
    m[V2_OFF_NONCE..V2_OFF_TS].copy_from_slice(&f.nonce);
    m[V2_OFF_TS..].copy_from_slice(&f.ts.to_le_bytes());
    m
}

/// `true` for the pro roles VAULT and PARTNER.
pub fn role_is_pro(role: u8) -> bool {
    role == ROLE_VAULT || role == ROLE_PARTNER
}

/// `record_scan_v2` step 3, the field rules of §3.4, in the order of the spec (each with its own error).
/// `site_registered` answers rule 5's registry lookup. Pure, so `docs/vectors.json` `v2.rejects` tests it.
pub fn check_fields_v2(m: &ScanMessageV2, site_registered: impl Fn(u16) -> bool) -> Result<()> {
    // rule 1: ranges
    require!(m.role <= MAX_ROLE, FlaconError::InvalidRole);
    require!(m.tier <= MAX_TIER, FlaconError::InvalidTier);
    require!(m.purpose <= MAX_PURPOSE, FlaconError::InvalidPurpose);
    require!(m.actor_kind <= MAX_ACTOR_KIND, FlaconError::InvalidActorKind);
    require!(
        m.tamper <= MAX_INDICATOR && m.uv <= MAX_INDICATOR && m.hum <= MAX_INDICATOR && m.heat <= MAX_INDICATOR,
        FlaconError::InvalidIndicator
    );
    require!(m.fill <= MAX_FILL || m.fill == FILL_NONE, FlaconError::InvalidFill);
    require!(m.heat_levels < (1u8 << HEAT_LEVELS_BITS), FlaconError::InvalidHeatLevels);
    // rule 2: heat consistency (as v1)
    if m.heat == INDICATOR_INTACT || m.heat == INDICATOR_TRIGGERED {
        let decisive = (m.heat_levels >> HEAT_DECISIVE_INDEX) & 1;
        require!(m.heat == decisive, FlaconError::HeatInconsistent);
    }
    // rule 3: a sighting has no reading at all, and only a sighting has no fill
    let sighting = m.tier == TIER_SIGHTING;
    require!(sighting == (m.fill == FILL_NONE), FlaconError::InvalidSighting);
    if sighting {
        require!(
            m.uv == INDICATOR_MISSING
                && m.hum == INDICATOR_MISSING
                && m.heat == INDICATOR_MISSING
                && m.heat_levels == 0
                && m.media_hash == ZERO32,
            FlaconError::InvalidSighting
        );
    }
    // rule 4: role / tier; certified and pro scans are signed by a partner (checked against the registry in step 4)
    let pro = role_is_pro(m.role);
    if !pro {
        require!(m.tier <= TIER_SELF_MEDIA, FlaconError::TierNotAllowedForRole);
    }
    if pro || m.tier >= TIER_CERTIFIED {
        require!(m.actor_kind == ACTOR_KIND_PARTNER, FlaconError::NotPartner);
    }
    // rule 5: site
    if m.site_id != 0 {
        require!(pro, FlaconError::SiteIdNotAllowed);
        require!(site_registered(m.site_id), FlaconError::UnknownSite);
    }
    // rule 6: purpose
    if m.purpose == PURPOSE_TAP {
        require!(sighting, FlaconError::PurposeNotAllowed);
    }
    if sighting {
        require!(m.purpose == PURPOSE_TAP || m.purpose == PURPOSE_CLAIM, FlaconError::PurposeNotAllowed);
    }
    if m.purpose == PURPOSE_BIRTH {
        require!(
            m.actor_kind == ACTOR_KIND_PARTNER && m.tier == TIER_BIRTH,
            FlaconError::PurposeNotAllowed
        );
    }
    if m.actor_kind == ACTOR_KIND_NONE {
        require!(m.purpose == PURPOSE_TAP || m.purpose == PURPOSE_CHECK, FlaconError::PurposeNotAllowed);
    }
    if m.actor_kind == ACTOR_KIND_RECIPIENT {
        require!(m.purpose == PURPOSE_RECEIPT, FlaconError::PurposeNotAllowed);
    }
    Ok(())
}

/// What `record_scan_v2` step 4 knows about the accounts behind a message (gathered by the handler).
pub struct ActorContext<'a> {
    pub holding_state: u8,
    /// `passport.asset == holding.key()`: the pass is held in a FlaconVault account.
    pub held_in_account: bool,
    pub commitment: &'a [u8; 32],
    /// `actor_signer`, when passed (it signed the transaction).
    pub signer: Option<Pubkey>,
    /// `asset`, when passed: its key, owner program and data.
    pub asset: Option<(Pubkey, Pubkey, &'a [u8])>,
    pub passport_asset: Pubkey,
}

/// `record_scan_v2` step 4, the actor rule of §3.2 / §7.6. `is_partner` is the registry's partner list.
/// NONE, HOLDER and RECIPIENT ignore the optional accounts.
pub fn check_actor_v2(m: &ScanMessageV2, a: &ActorContext, is_partner: impl Fn(&Pubkey) -> bool) -> Result<()> {
    match m.actor_kind {
        ACTOR_KIND_NONE => require!(m.actor == ZERO32, FlaconError::ActorMismatch),
        ACTOR_KIND_HOLDER => {
            require!(
                a.holding_state == HOLDING_STATE_ACCOUNT && a.held_in_account,
                FlaconError::HoldingNotInAccount
            );
            require!(&m.actor == a.commitment, FlaconError::ActorMismatch);
        }
        ACTOR_KIND_RECIPIENT => {
            require!(
                a.holding_state == HOLDING_STATE_ACCOUNT && a.held_in_account,
                FlaconError::HoldingNotInAccount
            );
            require!(m.actor != ZERO32 && &m.actor != a.commitment, FlaconError::ActorMismatch);
        }
        ACTOR_KIND_WALLET => {
            let signer = a.signer.ok_or(FlaconError::MissingActorSigner)?;
            require!(signer.to_bytes() == m.actor, FlaconError::ActorMismatch);
            let (key, owner_program, data) = a.asset.ok_or(FlaconError::AssetMismatch)?;
            require_keys_eq!(key, a.passport_asset, FlaconError::AssetMismatch);
            let owner = crate::instructions::mint_passport::core_asset_owner(&owner_program, data)
                .ok_or(FlaconError::NotAssetOwner)?;
            require_keys_eq!(owner, signer, FlaconError::NotAssetOwner);
        }
        ACTOR_KIND_PARTNER => {
            let signer = a.signer.ok_or(FlaconError::MissingActorSigner)?;
            require!(signer.to_bytes() == m.actor, FlaconError::ActorMismatch);
            require!(is_partner(&signer), FlaconError::NotPartner);
        }
        // check_fields_v2 refused every other code before this runs
        _ => return err!(FlaconError::InvalidActorKind),
    }
    Ok(())
}

/// `scan_head_n = sha256("FVHEAD1" ‖ scan_head_(n−1) ‖ sha256(msg_n))` (§4.2), 71 bytes in the outer hash.
pub fn fold_scan_head(head: &[u8; 32], msg: &[u8; MSG2_LEN_BYTES]) -> [u8; 32] {
    let inner = hashv(&[msg]).to_bytes();
    hashv(&[SCAN_HEAD_PREFIX, head, &inner]).to_bytes()
}

/// `commitment = sha256("FVHOLD1" ‖ passport ‖ epoch u32 LE ‖ secret32)` (§4.1), 75 input bytes. P1 only stores and
/// compares commitments; the preimage check is P2.
pub fn commitment(passport: &[u8; 32], epoch: u32, secret: &[u8; 32]) -> [u8; 32] {
    hashv(&[COMMITMENT_PREFIX, passport, &epoch.to_le_bytes(), secret]).to_bytes()
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
    fn msg_of(s: &str) -> [u8; MSG2_LEN_BYTES] {
        hex(s).try_into().expect("256 bytes")
    }
    fn sha256(b: &[u8]) -> [u8; 32] {
        hashv(&[b]).to_bytes()
    }

    fn vectors() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("docs/vectors.json")).unwrap()
    }
    fn n(v: &serde_json::Value) -> u64 {
        v.as_u64().expect("integer")
    }

    fn code(r: Result<()>) -> Option<u32> {
        match r {
            Ok(()) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Err(_) => Some(0),
        }
    }
    fn err(e: FlaconError) -> Option<u32> {
        Some(anchor_lang::error::ERROR_CODE_OFFSET + e as u32)
    }
    fn err_named(name: &str) -> Option<u32> {
        use FlaconError::*;
        err(match name {
            "InvalidRole" => InvalidRole,
            "InvalidTier" => InvalidTier,
            "InvalidPurpose" => InvalidPurpose,
            "InvalidActorKind" => InvalidActorKind,
            "InvalidIndicator" => InvalidIndicator,
            "InvalidFill" => InvalidFill,
            "InvalidHeatLevels" => InvalidHeatLevels,
            "HeatInconsistent" => HeatInconsistent,
            "InvalidSighting" => InvalidSighting,
            "TierNotAllowedForRole" => TierNotAllowedForRole,
            "NotPartner" => NotPartner,
            "SiteIdNotAllowed" => SiteIdNotAllowed,
            "UnknownSite" => UnknownSite,
            "PurposeNotAllowed" => PurposeNotAllowed,
            "ActorMismatch" => ActorMismatch,
            other => panic!("unknown error name {other}"),
        })
    }
    /// The registry of the vectors: site 1 only.
    fn site1(site: u16) -> bool {
        site == 1
    }

    /// The message of a `v2.scans[*].input` (enum fields as integer codes, heatLevels as an array of 6).
    fn from_input(v2: &serde_json::Value, i: &serde_json::Value) -> ScanMessageV2 {
        let mask = i["heatLevels"].as_array().unwrap().iter().enumerate().fold(0u8, |m, (b, x)| if n(x) == 1 { m | (1 << b) } else { m });
        ScanMessageV2 {
            program_id: hex32(v2["programIdHex"].as_str().unwrap()),
            cluster_tag: n(&v2["clusterTag"]) as u8,
            serial_hash: sha256(i["serial"].as_str().unwrap().as_bytes()),
            uid_hash: sha256(&hex(i["uidHex"].as_str().unwrap())),
            counter: n(&i["counter"]) as u32,
            tier: n(&i["tier"]) as u8,
            role: n(&i["role"]) as u8,
            tamper: n(&i["tamper"]) as u8,
            uv: n(&i["uv"]) as u8,
            hum: n(&i["hum"]) as u8,
            heat: n(&i["heat"]) as u8,
            heat_levels: mask,
            fill: n(&i["fill"]) as u8,
            site_id: n(&i["siteId"]) as u16,
            purpose: n(&i["purpose"]) as u8,
            actor_kind: n(&i["actorKind"]) as u8,
            actor: hex32(i["actorHex"].as_str().unwrap()),
            media_hash: hex32(i["mediaHashHex"].as_str().unwrap()),
            bundle_hash: [0u8; 32], // the bundle is off chain; the tests take bundle_hash from the vector
            nonce: hex32(i["nonceHex"].as_str().unwrap()),
            ts: i["ts"].as_i64().unwrap(),
        }
    }

    #[test]
    fn constants_match_vectors() {
        let v = vectors();
        let c = &v["constants"];
        assert_eq!(c["MSG2_PREFIX"].as_str().unwrap().as_bytes(), MSG2_PREFIX);
        assert_eq!(n(&c["MSG2_LEN"]) as usize, MSG2_LEN_BYTES);
        assert_eq!(c["SCAN_HEAD_PREFIX"].as_str().unwrap().as_bytes(), SCAN_HEAD_PREFIX);
        assert_eq!(c["COMMITMENT_PREFIX"].as_str().unwrap().as_bytes(), COMMITMENT_PREFIX);
        assert_eq!(n(&c["FILL_NONE"]) as u8, FILL_NONE);
        assert_eq!(c["BUNDLE2_SCHEMA"].as_str().unwrap(), BUNDLE2_SCHEMA);
        assert_eq!(c["PDA_SEEDS"]["holder_config"].as_str().unwrap().as_bytes(), HOLDER_CONFIG_SEED);
        assert_eq!(c["PDA_SEEDS"]["holding"].as_str().unwrap().as_bytes(), HOLDING_SEED);
        assert_eq!(v["v2"]["programIdHex"].as_str().unwrap(), crate::ID.to_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>());
        assert_eq!(n(&v["v2"]["clusterTag"]) as u8, CLUSTER_DEVNET);
    }

    #[test]
    fn enums_match_docs_enums_json() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/enums.json");
        let e: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let groups: [(&str, &[(&str, u8)]); 4] = [
            ("purpose", &[("TAP", PURPOSE_TAP), ("CHECK", PURPOSE_CHECK), ("LIST", PURPOSE_LIST), ("SHIP", PURPOSE_SHIP),
                ("RECEIPT", PURPOSE_RECEIPT), ("CLAIM", PURPOSE_CLAIM), ("BIRTH", PURPOSE_BIRTH)]),
            ("actor_kind", &[("NONE", ACTOR_KIND_NONE), ("HOLDER", ACTOR_KIND_HOLDER), ("WALLET", ACTOR_KIND_WALLET),
                ("PARTNER", ACTOR_KIND_PARTNER), ("RECIPIENT", ACTOR_KIND_RECIPIENT)]),
            ("cluster", &[("MAINNET", CLUSTER_MAINNET), ("DEVNET", CLUSTER_DEVNET), ("LOCALNET", CLUSTER_LOCALNET)]),
            ("holding_state", &[("ACCOUNT", HOLDING_STATE_ACCOUNT), ("CLAIM_PENDING", HOLDING_STATE_CLAIM_PENDING),
                ("WALLET", HOLDING_STATE_WALLET)]),
        ];
        for (group, values) in groups {
            let json = e[group].as_object().unwrap_or_else(|| panic!("enums.json {group}"));
            assert_eq!(json.len(), values.len(), "{group}");
            for (k, val) in values {
                assert_eq!(n(&json[*k]) as u8, *val, "{group}.{k}");
            }
        }
        assert_eq!(MAX_PURPOSE, PURPOSE_BIRTH);
        assert_eq!(MAX_ACTOR_KIND, ACTOR_KIND_RECIPIENT);
    }

    /// Every v2.scans message is rebuilt byte for byte from its input, parses back to the same fields, passes the
    /// field rules and has the vector's sha256.
    #[test]
    fn v2_scans_match_vectors() {
        let v = vectors();
        let v2 = &v["v2"];
        let scans = v2["scans"].as_array().expect("v2.scans[]");
        assert_eq!(scans.len(), 6);
        for s in scans {
            let name = s["name"].as_str().unwrap();
            let mut f = from_input(v2, &s["input"]);
            assert_eq!(f.heat_levels as u64, n(&s["heatMask"]), "{name} heatMask");
            f.bundle_hash = hex32(s["bundleHashHex"].as_str().unwrap());
            assert_eq!(sha256(s["bundleCanonical"].as_str().unwrap().as_bytes()), f.bundle_hash, "{name} bundle hash");
            let expected = msg_of(s["msgHex"].as_str().unwrap());
            assert_eq!(build_scan_message_v2(&f), expected, "{name} message");
            assert!(has_prefix_v2(&expected));
            assert_eq!(parse_scan_message_v2(&expected), f, "{name} parse");
            assert_eq!(sha256(&expected), hex32(s["msgSha256Hex"].as_str().unwrap()), "{name} sha256");
            assert_eq!(code(check_fields_v2(&f, site1)), None, "{name} fields");
        }
    }

    /// v2.rejects: each case breaks exactly one step-3 rule of the base message; same error as the TS builder.
    #[test]
    fn v2_rejects_match_vectors() {
        let v = vectors();
        let rejects = v["v2"]["rejects"].as_array().expect("v2.rejects[]");
        assert!(rejects.len() >= 19);
        for r in rejects {
            let name = r["name"].as_str().unwrap();
            let m = parse_scan_message_v2(&msg_of(r["msgHex"].as_str().unwrap()));
            assert_eq!(code(check_fields_v2(&m, site1)), err_named(r["error"].as_str().unwrap()), "{name}");
        }
    }

    /// Hard-coded copy of the §5 worked example (v2.scans[1], "tap-visitor-sighting").
    #[test]
    fn scans1_hardcoded() {
        let f = ScanMessageV2 {
            program_id: hex32("626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29"),
            cluster_tag: CLUSTER_DEVNET,
            serial_hash: hex32("4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583"),
            uid_hash: hex32("8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442"),
            counter: 2,
            tier: TIER_SIGHTING,
            role: ROLE_OWNER,
            tamper: TAMPER_UNKNOWN,
            uv: INDICATOR_MISSING,
            hum: INDICATOR_MISSING,
            heat: INDICATOR_MISSING,
            heat_levels: 0,
            fill: FILL_NONE,
            site_id: 0,
            purpose: PURPOSE_TAP,
            actor_kind: ACTOR_KIND_NONE,
            actor: [0u8; 32],
            media_hash: [0u8; 32],
            bundle_hash: hex32("f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c5"),
            nonce: hex32("7901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9"),
            ts: 1790000200,
        };
        let expected = hex(concat!(
            "46565343414e32",
            "626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29",
            "02",
            "4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583",
            "8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442",
            "02000000", "00", "00", "03", "03", "03", "03", "00", "ff", "0000", "00", "00",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c5",
            "7901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9",
            "483cb16a00000000"
        ));
        let msg = build_scan_message_v2(&f);
        assert_eq!(&msg[..], &expected[..]);
        assert_eq!(sha256(&msg), hex32("57bfd9ce941c81cc5366e6edf0d16527881074db75319eb5c72c47b1adef4bf4"));
        assert_eq!(code(check_fields_v2(&f, |_| false)), None);
        // head after the BIRTH scan, then after this TAP (§5)
        let birth = hex32("d1d5cabfaa2495705fa2cfd6dbd467639830ce5004998feeb845e9857a1cafa0");
        let head1 = hashv(&[SCAN_HEAD_PREFIX, &[0u8; 32], &birth]).to_bytes();
        assert_eq!(head1, hex32("7d3c88a08935f19eb946f4f0efaa9c45da862bd5c052bb2fea3dcb74aeabbab7"));
        assert_eq!(fold_scan_head(&head1, &msg), hex32("6fcae69855734dc31f0eeef62edbe448fe3a0e2091b9c2208d55e6e5332565e7"));
    }

    #[test]
    fn offsets_follow_the_spec_table() {
        let offs = [
            V2_OFF_PROGRAM_ID, V2_OFF_CLUSTER, V2_OFF_SERIAL_HASH, V2_OFF_UID_HASH, V2_OFF_COUNTER, V2_OFF_TIER,
            V2_OFF_ROLE, V2_OFF_TAMPER, V2_OFF_UV, V2_OFF_HUM, V2_OFF_HEAT, V2_OFF_HEAT_LEVELS, V2_OFF_FILL,
            V2_OFF_SITE_ID, V2_OFF_PURPOSE, V2_OFF_ACTOR_KIND, V2_OFF_ACTOR, V2_OFF_MEDIA_HASH, V2_OFF_BUNDLE_HASH,
            V2_OFF_NONCE, V2_OFF_TS,
        ];
        assert_eq!(offs, [7, 39, 40, 72, 104, 108, 109, 110, 111, 112, 113, 114, 115, 116, 118, 119, 120, 152, 184, 216, 248]);
    }

    #[test]
    fn scan_head_and_commitments_match_vectors() {
        let v = vectors();
        let v2 = &v["v2"];
        let mut head = hex32(v2["scanHead"]["initialHex"].as_str().unwrap());
        assert_eq!(head, [0u8; 32]);
        for s in v2["scans"].as_array().unwrap() {
            head = fold_scan_head(&head, &msg_of(s["msgHex"].as_str().unwrap()));
            assert_eq!(head, hex32(s["headAfterHex"].as_str().unwrap()), "{}", s["name"]);
        }
        assert_eq!(n(&v2["scanHead"]["count"]), 6);
        assert_eq!(head, hex32(v2["scanHead"]["finalHex"].as_str().unwrap()));

        for c in v2["commitments"].as_array().unwrap() {
            let secret = hex32(c["secretHex"].as_str().unwrap());
            assert_eq!(secret, sha256(c["secretLabel"].as_str().unwrap().as_bytes()));
            let got = commitment(&hex32(c["passportHex"].as_str().unwrap()), n(&c["epoch"]) as u32, &secret);
            assert_eq!(got, hex32(c["commitmentHex"].as_str().unwrap()), "epoch {}", c["epoch"]);
        }
        // §5, hard-coded
        let passport = hex32("4527566c42a505d1b5fab981cff855a485020dc5abe34b365ace5fd57c225ffc");
        let secret0 = sha256(b"flaconvault:test-holder-secret:0");
        assert_eq!(commitment(&passport, 0, &secret0), hex32("24088cd63896f3d8f4e55b031307f84429c5e16a039d5f6fa1e4a0e983649fe5"));
        let secret1 = sha256(b"flaconvault:test-holder-secret:1");
        assert_eq!(commitment(&passport, 1, &secret1), hex32("09b1c3a5ff50a1f70512c08f7159f65c510e4af74f4fa56b4959a9b0925411fd"));
    }

    /// A valid visitor CHECK (v2.scans[2]) as the base of the rule tests below.
    fn base() -> ScanMessageV2 {
        let v = vectors();
        let s = &v["v2"]["scans"][2];
        parse_scan_message_v2(&msg_of(s["msgHex"].as_str().unwrap()))
    }

    #[test]
    fn field_rules_each_error() {
        let ok = |m: &ScanMessageV2| code(check_fields_v2(m, site1));
        let b = base();
        assert_eq!(ok(&b), None);
        // UnknownSite: a pro role with a site the registry does not have (the vectors' rejects only know site 1)
        let partner = ScanMessageV2 { tier: TIER_CERTIFIED, role: ROLE_VAULT, actor_kind: ACTOR_KIND_PARTNER, actor: [5u8; 32], site_id: 2, ..b.clone() };
        assert_eq!(ok(&partner), err(FlaconError::UnknownSite));
        assert_eq!(ok(&ScanMessageV2 { site_id: 1, ..partner.clone() }), None);
        // heat TRIGGERED needs bit 4; UNREADABLE / MISSING are free
        assert_eq!(ok(&ScanMessageV2 { heat: INDICATOR_TRIGGERED, heat_levels: 0b01_0000, ..b.clone() }), None);
        assert_eq!(ok(&ScanMessageV2 { heat: INDICATOR_TRIGGERED, heat_levels: 0b00_1111, ..b.clone() }), err(FlaconError::HeatInconsistent));
        assert_eq!(ok(&ScanMessageV2 { heat: INDICATOR_UNREADABLE, heat_levels: 0b11_1111, ..b.clone() }), None);
        // fill 100 is a reading, 101..254 are not
        assert_eq!(ok(&ScanMessageV2 { fill: 100, ..b.clone() }), None);
        assert_eq!(ok(&ScanMessageV2 { fill: 254, ..b.clone() }), err(FlaconError::InvalidFill));
        // a P1 TAP (§3.4): tier 0, fill 255, MISSING, no media; tamper is free
        let tap = ScanMessageV2 {
            tier: TIER_SIGHTING, purpose: PURPOSE_TAP, fill: FILL_NONE, uv: INDICATOR_MISSING, hum: INDICATOR_MISSING,
            heat: INDICATOR_MISSING, heat_levels: 0, media_hash: [0u8; 32], ..b.clone()
        };
        assert_eq!(ok(&tap), None);
        assert_eq!(ok(&ScanMessageV2 { tamper: TAMPER_CLOSED, ..tap.clone() }), None);
        assert_eq!(ok(&ScanMessageV2 { uv: INDICATOR_INTACT, ..tap.clone() }), err(FlaconError::InvalidSighting));
        assert_eq!(ok(&ScanMessageV2 { heat_levels: 1, ..tap.clone() }), err(FlaconError::InvalidSighting));
        // a sighting is a TAP or a CLAIM; a visitor's purposes are TAP and CHECK only
        assert_eq!(ok(&ScanMessageV2 { purpose: PURPOSE_CHECK, ..tap.clone() }), err(FlaconError::PurposeNotAllowed));
        assert_eq!(ok(&ScanMessageV2 { purpose: PURPOSE_CLAIM, ..tap.clone() }), err(FlaconError::PurposeNotAllowed));
        assert_eq!(ok(&ScanMessageV2 { purpose: PURPOSE_CLAIM, actor_kind: ACTOR_KIND_HOLDER, actor: [1u8; 32], ..tap.clone() }), None);
        for p in [PURPOSE_LIST, PURPOSE_SHIP, PURPOSE_RECEIPT, PURPOSE_CLAIM] {
            assert_eq!(ok(&ScanMessageV2 { purpose: p, ..b.clone() }), err(FlaconError::PurposeNotAllowed), "visitor purpose {p}");
            assert_eq!(ok(&ScanMessageV2 { purpose: p, actor_kind: ACTOR_KIND_HOLDER, actor: [1u8; 32], ..b.clone() }), None, "holder purpose {p}");
        }
        // BIRTH: partner and tier 4 only
        let birth = ScanMessageV2 { purpose: PURPOSE_BIRTH, tier: TIER_BIRTH, role: ROLE_PARTNER, actor_kind: ACTOR_KIND_PARTNER, actor: [5u8; 32], ..b.clone() };
        assert_eq!(ok(&birth), None);
        assert_eq!(ok(&ScanMessageV2 { tier: TIER_CERTIFIED, ..birth.clone() }), err(FlaconError::PurposeNotAllowed));
        // RECIPIENT: RECEIPT only
        assert_eq!(ok(&ScanMessageV2 { purpose: PURPOSE_RECEIPT, actor_kind: ACTOR_KIND_RECIPIENT, actor: [1u8; 32], ..b.clone() }), None);
        assert_eq!(ok(&ScanMessageV2 { purpose: PURPOSE_RECEIPT, actor_kind: ACTOR_KIND_WALLET, actor: [1u8; 32], ..b.clone() }), None);
    }

    fn actor_ctx<'a>(commitment: &'a [u8; 32]) -> ActorContext<'a> {
        ActorContext {
            holding_state: HOLDING_STATE_ACCOUNT,
            held_in_account: true,
            commitment,
            signer: None,
            asset: None,
            passport_asset: Pubkey::new_unique(),
        }
    }

    #[test]
    fn actor_rules() {
        let commitment = [9u8; 32];
        let other = [8u8; 32];
        let no_partner = |_: &Pubkey| false;
        let b = base();
        // NONE: actor zero
        assert_eq!(code(check_actor_v2(&b, &actor_ctx(&commitment), no_partner)), None);
        assert_eq!(code(check_actor_v2(&ScanMessageV2 { actor: [1u8; 32], ..b.clone() }, &actor_ctx(&commitment), no_partner)), err(FlaconError::ActorMismatch));
        // HOLDER: the current commitment of a pass held in an account
        let holder = ScanMessageV2 { actor_kind: ACTOR_KIND_HOLDER, actor: commitment, ..b.clone() };
        assert_eq!(code(check_actor_v2(&holder, &actor_ctx(&commitment), no_partner)), None);
        assert_eq!(code(check_actor_v2(&ScanMessageV2 { actor: other, ..holder.clone() }, &actor_ctx(&commitment), no_partner)), err(FlaconError::ActorMismatch));
        let in_wallet = ActorContext { holding_state: HOLDING_STATE_WALLET, held_in_account: false, ..actor_ctx(&commitment) };
        assert_eq!(code(check_actor_v2(&holder, &in_wallet, no_partner)), err(FlaconError::HoldingNotInAccount));
        let claim_pending = ActorContext { holding_state: HOLDING_STATE_CLAIM_PENDING, ..actor_ctx(&commitment) };
        assert_eq!(code(check_actor_v2(&holder, &claim_pending, no_partner)), err(FlaconError::HoldingNotInAccount));
        let elsewhere = ActorContext { held_in_account: false, ..actor_ctx(&commitment) };
        assert_eq!(code(check_actor_v2(&holder, &elsewhere, no_partner)), err(FlaconError::HoldingNotInAccount));
        // RECIPIENT: a prepared commitment, never zero, never the current one
        let recipient = ScanMessageV2 { actor_kind: ACTOR_KIND_RECIPIENT, purpose: PURPOSE_RECEIPT, actor: other, ..b.clone() };
        assert_eq!(code(check_actor_v2(&recipient, &actor_ctx(&commitment), no_partner)), None);
        assert_eq!(code(check_actor_v2(&ScanMessageV2 { actor: commitment, ..recipient.clone() }, &actor_ctx(&commitment), no_partner)), err(FlaconError::ActorMismatch));
        assert_eq!(code(check_actor_v2(&ScanMessageV2 { actor: [0u8; 32], ..recipient.clone() }, &actor_ctx(&commitment), no_partner)), err(FlaconError::ActorMismatch));
        assert_eq!(code(check_actor_v2(&recipient, &in_wallet, no_partner)), err(FlaconError::HoldingNotInAccount));

        // WALLET: the co-signer owns the Core asset at passport.asset
        let wallet = Pubkey::new_unique();
        let asset = Pubkey::new_unique();
        let mut data = vec![MPL_CORE_KEY_ASSET_V1];
        data.extend_from_slice(wallet.as_ref());
        data.extend_from_slice(&[0u8; 8]);
        let w = ScanMessageV2 { actor_kind: ACTOR_KIND_WALLET, actor: wallet.to_bytes(), ..b.clone() };
        // a pass in a wallet: no commitment, passport.asset = the Core asset
        let wctx = |signer: Option<Pubkey>, a: Option<(Pubkey, Pubkey)>| ActorContext {
            holding_state: HOLDING_STATE_WALLET, held_in_account: false, commitment: &ZERO32, signer,
            asset: a.map(|(key, owner_program)| (key, owner_program, data.as_slice())), passport_asset: asset,
        };
        assert_eq!(code(check_actor_v2(&w, &wctx(Some(wallet), Some((asset, MPL_CORE_PROGRAM_ID))), no_partner)), None);
        assert_eq!(code(check_actor_v2(&w, &wctx(None, Some((asset, MPL_CORE_PROGRAM_ID))), no_partner)), err(FlaconError::MissingActorSigner));
        let stranger = Pubkey::new_unique();
        assert_eq!(code(check_actor_v2(&w, &wctx(Some(stranger), Some((asset, MPL_CORE_PROGRAM_ID))), no_partner)), err(FlaconError::ActorMismatch));
        assert_eq!(code(check_actor_v2(&w, &wctx(Some(wallet), None), no_partner)), err(FlaconError::AssetMismatch));
        assert_eq!(code(check_actor_v2(&w, &wctx(Some(wallet), Some((Pubkey::new_unique(), MPL_CORE_PROGRAM_ID))), no_partner)), err(FlaconError::AssetMismatch));
        // not a Core asset (a Holding of this program, a foreign account), or owned by somebody else
        assert_eq!(code(check_actor_v2(&w, &wctx(Some(wallet), Some((asset, crate::ID))), no_partner)), err(FlaconError::NotAssetOwner));
        let w2 = ScanMessageV2 { actor: stranger.to_bytes(), ..w.clone() };
        assert_eq!(code(check_actor_v2(&w2, &wctx(Some(stranger), Some((asset, MPL_CORE_PROGRAM_ID))), no_partner)), err(FlaconError::NotAssetOwner));

        // PARTNER: the co-signer is a registry partner
        let partner = Pubkey::new_unique();
        let p = ScanMessageV2 { actor_kind: ACTOR_KIND_PARTNER, actor: partner.to_bytes(), ..b.clone() };
        let is_partner = |k: &Pubkey| k == &partner;
        let pctx = |signer: Option<Pubkey>| ActorContext { signer, ..actor_ctx(&commitment) };
        assert_eq!(code(check_actor_v2(&p, &pctx(Some(partner)), is_partner)), None);
        assert_eq!(code(check_actor_v2(&p, &pctx(None), is_partner)), err(FlaconError::MissingActorSigner));
        assert_eq!(code(check_actor_v2(&p, &pctx(Some(stranger)), is_partner)), err(FlaconError::ActorMismatch));
        assert_eq!(code(check_actor_v2(&p, &pctx(Some(partner)), no_partner)), err(FlaconError::NotPartner));
    }

    #[test]
    fn prefix_and_round_trip() {
        let b = base();
        let mut m = build_scan_message_v2(&b);
        assert!(has_prefix_v2(&m));
        m[6] = b'1'; // FVSCAN1
        assert!(!has_prefix_v2(&m));
        // FVSCAN1 bytes padded to 256 are no FVSCAN2 message
        let mut padded = [0u8; MSG2_LEN_BYTES];
        padded[..MSG_LEN_BYTES].copy_from_slice(&[0x11u8; MSG_LEN_BYTES]);
        padded[..7].copy_from_slice(MSG_PREFIX);
        assert!(!has_prefix_v2(&padded));
        // every field survives a round trip at extreme values
        let x = ScanMessageV2 { counter: MAX_COUNTER, site_id: u16::MAX, ts: i64::MIN, ..b.clone() };
        assert_eq!(parse_scan_message_v2(&build_scan_message_v2(&x)), x);
    }
}
