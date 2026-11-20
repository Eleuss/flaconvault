use anchor_lang::prelude::*;

#[error_code]
pub enum FlaconError {
    // ---- registry admin ----
    #[msg("Signer is not the registry authority")]
    Unauthorized,
    #[msg("Signer is not a registered partner")]
    NotPartner,
    #[msg("A server key with this key_id already exists")]
    DuplicateServerKey,
    #[msg("Registry holds the maximum number of server keys")]
    ServerKeysFull,
    #[msg("valid_to must be 0 (open-ended) or >= valid_from")]
    InvalidKeyValidity,
    #[msg("Partner already registered")]
    DuplicatePartner,
    #[msg("Registry holds the maximum number of partners")]
    PartnersFull,
    #[msg("site_id 0 is reserved for 'no site'")]
    InvalidSiteId,
    #[msg("A site with this site_id already exists")]
    DuplicateSite,
    #[msg("Registry holds the maximum number of sites")]
    SitesFull,

    // ---- passport / seal ----
    #[msg("Seal kind must be 0 (BOX) or 1 (NECK); 2 (LOOP) is reserved")]
    InvalidSealKind,
    #[msg("Passport seal_count overflow")]
    SealCountOverflow,
    #[msg("Seal does not belong to this passport")]
    SealPassportMismatch,
    #[msg("Seal is dead (no longer answers) — no further scans")]
    SealDead,
    #[msg("Passport is void")]
    PassportVoid,
    #[msg("Counter must be greater than the seal's last counter")]
    CounterNotIncreasing,

    // ---- record_scan step 1: ed25519 ----
    #[msg("Instructions sysvar account mismatch")]
    InvalidInstructionsSysvar,
    #[msg("The instruction before record_scan must be an Ed25519Program instruction")]
    MissingEd25519Instruction,
    #[msg("Ed25519 instruction data is malformed (expects exactly one signature over a 152-byte FVSCAN1 or, for record_scan_v2, a 256-byte FVSCAN2 message)")]
    MalformedEd25519Instruction,
    #[msg("No server key with this key_id in the registry")]
    UnknownServerKey,
    #[msg("Ed25519 public key does not match the registry server key")]
    ServerKeyMismatch,
    #[msg("Server key is not valid at the given ts")]
    ServerKeyNotValidAtTs,
    #[msg("Signed message does not match the reconstruction from the arguments")]
    MessageMismatch,

    // ---- record_scan step 3: role / tier / fields ----
    #[msg("role must be 0..=4")]
    InvalidRole,
    #[msg("tier must be 0..=4")]
    InvalidTier,
    #[msg("OWNER/SELLER/BUYER may attest at most tier 2 (SELF_MEDIA)")]
    TierNotAllowedForRole,
    #[msg("site_id may only be set for role VAULT or PARTNER")]
    SiteIdNotAllowed,
    #[msg("site_id is not registered")]
    UnknownSite,
    #[msg("tamper/uv/hum/heat codes must be 0..=3")]
    InvalidIndicator,
    #[msg("fill must be 0..=100")]
    InvalidFill,
    #[msg("heat_levels must be a 6-bit mask (< 64)")]
    InvalidHeatLevels,
    #[msg("heat must equal bit 4 of heat_levels when heat is INTACT or TRIGGERED")]
    HeatInconsistent,

    // ---- record_scan step 4 ----
    #[msg("Passport scan_count overflow")]
    ScanCountOverflow,

    // ---- appended (keep the codes above stable) ----
    #[msg("Signer is neither the passport issuer (a current partner) nor the registry authority")]
    NotIssuerOrAuthority,
    #[msg("Passport already holds the maximum number of seals")]
    TooManySeals,
    #[msg("Server key is not valid at the current cluster time (expired or revoked)")]
    ServerKeyNotValidNow,
    #[msg("Signed ts is more than MAX_SCAN_TS_SKEW_S away from the cluster clock")]
    StaleScanTimestamp,
    #[msg("counter is above the 24-bit NTAG counter range")]
    CounterOutOfRange,
    #[msg("Partner is not registered")]
    PartnerNotFound,
    #[msg("Server key is already expired or revoked")]
    ServerKeyAlreadyRevoked,
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Asset account does not match the asset argument")]
    AssetMismatch,
    #[msg("Asset account is not a Metaplex Core asset")]
    InvalidAsset,
    #[msg("The Core asset must be owned by the issuer when the passport is minted")]
    AssetNotOwnedByIssuer,

    // ---- v2 public record (docs/public-record.md §7.8; appended, keep the codes above stable) ----
    #[msg("cluster_tag must be 1 (MAINNET), 2 (DEVNET) or 3 (LOCALNET)")]
    InvalidClusterTag,
    #[msg("Delay must be within MIN_HOLD_DELAY_S..=MAX_HOLD_DELAY_S")]
    InvalidDelay,
    #[msg("Commitment must not be all zeros")]
    InvalidCommitment,
    #[msg("record_scan_v2 must be a top-level instruction")]
    CpiNotAllowed,
    #[msg("Signed message is not an FVSCAN2 message")]
    InvalidMessagePrefix,
    #[msg("FVSCAN2 message is bound to another program id")]
    WrongProgramId,
    #[msg("FVSCAN2 message is bound to another cluster")]
    WrongCluster,
    #[msg("purpose must be 0..=6")]
    InvalidPurpose,
    #[msg("actor_kind must be 0..=4")]
    InvalidActorKind,
    #[msg("A sighting (tier 0) has fill FILL_NONE, uv/hum/heat MISSING, heat_levels 0 and no media; FILL_NONE only with tier 0")]
    InvalidSighting,
    #[msg("purpose is not allowed for this actor kind or tier")]
    PurposeNotAllowed,
    #[msg("actor does not match its kind (zero for NONE, Holding.commitment for HOLDER, the signer for WALLET/PARTNER)")]
    ActorMismatch,
    #[msg("WALLET and PARTNER scans need the actor as signer")]
    MissingActorSigner,
    #[msg("The WALLET actor does not own the passport's Core asset")]
    NotAssetOwner,
    #[msg("HOLDER and RECIPIENT scans need a pass held in an account (Passport.asset == Holding)")]
    HoldingNotInAccount,
    #[msg("Holding head_count overflow")]
    HeadCountOverflow,
}
