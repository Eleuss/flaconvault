/**
 * Enum values (u8) — identical in server (Python), program (Rust) and web.
 * Source of truth: this file. `npm run vectors` writes docs/enums.json,
 * server and program tests compare against that file.
 */
export const Tamper = { CLOSED: 0, OPENED_NOW: 1, OPENED_BEFORE: 2, UNKNOWN: 3 } as const;
export const Indicator = { INTACT: 0, TRIGGERED: 1, UNREADABLE: 2, MISSING: 3 } as const;
export const Tier = { SIGHTING: 0, SELF: 1, SELF_MEDIA: 2, CERTIFIED: 3, BIRTH: 4 } as const;
export const Role = { OWNER: 0, SELLER: 1, BUYER: 2, VAULT: 3, PARTNER: 4 } as const;
export const Grade = { A: 0, B: 1, C: 2, D: 3, VOID: 4 } as const;
/** 2 = LOOP is reserved for the optional 213 TT upgrade (briefing §13). */
export const SealKind = { BOX: 0, NECK: 1 } as const;
export const EventType = {
  MINT: 0, SEAL_ATTACH: 1, SCAN: 2, LIST: 3, RESERVE: 4,
  SHIP: 5, RECEIVE: 6, RELEASE: 7, DISPUTE: 8, SEAL_DEAD: 9,
} as const;
/** Why a scan was made: FVSCAN2 `purpose` (docs/public-record.md §2.1). A TAP is a tier-0 sighting from `/t`. */
export const Purpose = { TAP: 0, CHECK: 1, LIST: 2, SHIP: 3, RECEIPT: 4, CLAIM: 5, BIRTH: 6 } as const;
/**
 * Whom a scan speaks for: FVSCAN2 `actor_kind` (§3.2). NONE (a visitor) and RECIPIENT are evidence only;
 * HOLDER, WALLET and PARTNER may change the passport grade.
 */
export const ActorKind = { NONE: 0, HOLDER: 1, WALLET: 2, PARTNER: 3, RECIPIENT: 4 } as const;
/** FVSCAN2 `cluster_tag`, stored once in HolderConfig. 0 is never valid. */
export const Cluster = { MAINNET: 1, DEVNET: 2, LOCALNET: 3 } as const;
/** Holding.state. WALLET = Passport.asset is not the Holding, the Core-asset owner rule applies. */
export const HoldingState = { ACCOUNT: 0, CLAIM_PENDING: 1, WALLET: 2 } as const;
/** Server verdicts. Only VALID is ever signed. NO_RESPONSE = tag did not answer (mechanical tamper / removed). */
export const Verdict = {
  VALID: "VALID", INVALID: "INVALID", REPLAY: "REPLAY",
  NONCE_INVALID: "NONCE_INVALID", UNREGISTERED: "UNREGISTERED", NO_RESPONSE: "NO_RESPONSE",
} as const;

export type TamperCode = (typeof Tamper)[keyof typeof Tamper];
export type IndicatorCode = (typeof Indicator)[keyof typeof Indicator];
export type TierCode = (typeof Tier)[keyof typeof Tier];
export type RoleCode = (typeof Role)[keyof typeof Role];
export type GradeCode = (typeof Grade)[keyof typeof Grade];
export type SealKindCode = (typeof SealKind)[keyof typeof SealKind];
export type EventTypeCode = (typeof EventType)[keyof typeof EventType];
export type VerdictCode = (typeof Verdict)[keyof typeof Verdict];
export type PurposeCode = (typeof Purpose)[keyof typeof Purpose];
export type ActorKindCode = (typeof ActorKind)[keyof typeof ActorKind];
export type ClusterCode = (typeof Cluster)[keyof typeof Cluster];
export type HoldingStateCode = (typeof HoldingState)[keyof typeof HoldingState];

export const ENUMS = {
  tamper: Tamper, indicator: Indicator, tier: Tier, role: Role,
  grade: Grade, seal_kind: SealKind, event: EventType,
  purpose: Purpose, actor_kind: ActorKind, cluster: Cluster, holding_state: HoldingState,
} as const;

function invert<T extends Record<string, number>>(o: T): Record<number, keyof T & string> {
  const out: Record<number, keyof T & string> = {};
  for (const [k, v] of Object.entries(o)) out[v] = k as keyof T & string;
  return out;
}
export const TamperName = invert(Tamper);
export const IndicatorName = invert(Indicator);
export const TierName = invert(Tier);
export const RoleName = invert(Role);
export const GradeName = invert(Grade);
export const SealKindName = invert(SealKind);
export const EventTypeName = invert(EventType);
export const PurposeName = invert(Purpose);
export const ActorKindName = invert(ActorKind);
export const ClusterName = invert(Cluster);
export const HoldingStateName = invert(HoldingState);

/** Cluster names in env/config are lower case (`devnet`, `mainnet`, `localnet`) and map to the enum by upper-casing. */
export function clusterTag(name: string): ClusterCode {
  const key = name.trim().toUpperCase();
  if (!Object.hasOwn(Cluster, key)) throw new Error(`unknown cluster: ${name} (devnet, mainnet or localnet)`);
  return Cluster[key as keyof typeof Cluster];
}

/** Ordering of the six Thermax fields on the heat strip (°C). Index 4 (40 °C) is the one that counts. */
export const HEAT_FIELDS_C = [29, 33, 34, 37, 40, 42] as const;
export const HEAT_DECISIVE_INDEX = 4;
export const HUMIDITY_THRESHOLD_RH = 60;
export const HEAT_THRESHOLD_C = 40;

/** Program constants shared with Anchor. */
export const PDA_SEEDS = {
  registry: "registry", passport: "passport", seal: "seal", scan: "scan", origin: "origin",
  holder_config: "holder_config", holding: "holding",
} as const;
export const MSG_PREFIX = "FVSCAN1";
export const MSG_LEN = 152;
export const BUNDLE_SCHEMA = "flaconvault.scanproof.v1";
/** FVSCAN2, the v2 scan message signed by the verifier and parsed by `record_scan_v2` (docs/public-record.md §3). */
export const MSG2_PREFIX = "FVSCAN2";
export const MSG2_LEN = 256;
/** scan_head_n = sha256("FVHEAD1" ‖ scan_head_(n−1) ‖ sha256(msg_n)) (§4.2). */
export const SCAN_HEAD_PREFIX = "FVHEAD1";
/** commitment = sha256("FVHOLD1" ‖ passport ‖ epoch u32 LE ‖ secret32) (§4.1). */
export const COMMITMENT_PREFIX = "FVHOLD1";
/** FVSCAN2 `fill` sentinel: no fill reading. Tier SIGHTING if and only if fill is FILL_NONE (D4). */
export const FILL_NONE = 255;
export const BUNDLE2_SCHEMA = "flaconvault.scanbundle.v2";
export const NONCE_TTL_S = 90;
/** `record_scan` / `record_scan_v2` accept a signed `ts` only while |ts − cluster clock| ≤ this (seconds; the IDL
 * constant `MAX_SCAN_TS_SKEW_S`). */
export const MAX_SCAN_TS_SKEW_S = 600;
/** Key diversification (AN10922, only when FV_KEY_MODE=diversified): CMAC(K_master, 0x01 ‖ UID ‖ APP_ID ‖ SYS_ID). */
export const KEY_DIV_APP_ID_HEX = "D2760000850101";
export const KEY_DIV_SYS_ID = "FlaconVault";
