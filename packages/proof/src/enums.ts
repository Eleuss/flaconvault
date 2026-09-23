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

export const ENUMS = {
  tamper: Tamper, indicator: Indicator, tier: Tier, role: Role,
  grade: Grade, seal_kind: SealKind, event: EventType,
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

/** Ordering of the six Thermax fields on the heat strip (°C). Index 4 (40 °C) is the one that counts. */
export const HEAT_FIELDS_C = [29, 33, 34, 37, 40, 42] as const;
export const HEAT_DECISIVE_INDEX = 4;
export const HUMIDITY_THRESHOLD_RH = 60;
export const HEAT_THRESHOLD_C = 40;

/** Program constants shared with Anchor. */
export const PDA_SEEDS = {
  registry: "registry", passport: "passport", seal: "seal", scan: "scan", origin: "origin",
} as const;
export const MSG_PREFIX = "FVSCAN1";
export const MSG_LEN = 152;
export const BUNDLE_SCHEMA = "flaconvault.scanproof.v1";
export const NONCE_TTL_S = 90;
/** Key diversification (AN10922, only when FV_KEY_MODE=diversified): CMAC(K_master, 0x01 ‖ UID ‖ APP_ID ‖ SYS_ID). */
export const KEY_DIV_APP_ID_HEX = "D2760000850101";
export const KEY_DIV_SYS_ID = "FlaconVault";
