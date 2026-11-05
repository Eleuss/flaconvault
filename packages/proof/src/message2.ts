/**
 * FVSCAN2 — the 256-byte v2 scan message (docs/public-record.md §3). The verifier signs it, the relayer sends it in
 * the Ed25519 instruction right before `record_scan_v2`, and the program parses every field out of it (D6).
 * FVSCAN1 (message.ts, 152 bytes) is unchanged; prefix and length keep the two domains apart (D19).
 */
import {
  ActorKind, Cluster, FILL_NONE, Indicator, MSG2_LEN, MSG2_PREFIX, Purpose, Role, Tier,
} from "./enums.ts";
import { bytesEqual, concatBytes, i64le, u16le, u32le, u8, utf8, ZERO32 } from "./bytes.ts";

export interface ScanMessageV2Fields {
  programId: Uint8Array;  // 32, the flacon program this message is for
  clusterTag: number;     // u8, cluster enum (1 MAINNET, 2 DEVNET, 3 LOCALNET)
  serialHash: Uint8Array; // 32, = Passport.serial_hash
  uidHash: Uint8Array;    // 32, = Seal.uid_hash
  counter: number;        // u32, ≤ MAX_COUNTER
  tier: number; role: number; tamper: number; uv: number; hum: number; heat: number; // u8 each
  heatLevels: number;     // u8, 6-bit mask, bit i = Thermax field i
  fill: number;           // u8, 0..100 or FILL_NONE
  siteId: number;         // u16, 0 = none
  purpose: number;        // u8, purpose enum
  actorKind: number;      // u8, actor_kind enum
  actor: Uint8Array;      // 32, see §3.2
  mediaHash: Uint8Array;  // 32, ZERO32 when none
  bundleHash: Uint8Array; // 32, sha256 of the canonical v2 bundle
  nonce: Uint8Array;      // 32
  ts: number | bigint;    // i64 unix seconds
}
export interface ParsedScanMessageV2 extends ScanMessageV2Fields { ts: bigint }

/** Byte offsets (Rust `V2_OFF_*` in message_v2.rs). */
export const MSG2_OFFSETS = {
  prefix: 0, programId: 7, clusterTag: 39, serialHash: 40, uidHash: 72, counter: 104, tier: 108, role: 109,
  tamper: 110, uv: 111, hum: 112, heat: 113, heatLevels: 114, fill: 115, siteId: 116, purpose: 118,
  actorKind: 119, actor: 120, mediaHash: 152, bundleHash: 184, nonce: 216, ts: 248,
} as const;

/** 24-bit NTAG 424 SUN counter (Rust `MAX_COUNTER`). */
export const MAX_COUNTER = 0x00ffffff;
const MAX_U8_ENUM = { tier: 4, role: 4, purpose: 6, actorKind: 4, indicator: 3 } as const;
const HEAT_DECISIVE_BIT = 4;

/** A field-rule violation. `code` is the `record_scan_v2` error the program would raise (§7.6, §7.8). */
export class ScanFieldError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ScanFieldError";
    this.code = code;
  }
}
function need(ok: boolean, code: string, message: string): void {
  if (!ok) throw new ScanFieldError(code, message);
}

export const isProRole = (role: number) => role === Role.VAULT || role === Role.PARTNER;

/**
 * §3.4 field validity, in the order of `record_scan_v2` step 3 (same error names), followed by the actor
 * rule 7 (step 4, ActorMismatch). Rule 5's "registered site" needs the registry: pass `knownSites` to check it.
 * The verifier never signs anything this rejects; `buildScanMessageV2` calls it.
 */
export function checkScanFieldsV2(f: ScanMessageV2Fields, opts: { knownSites?: readonly number[] } = {}): void {
  for (const [name, b] of [["programId", f.programId], ["serialHash", f.serialHash], ["uidHash", f.uidHash],
    ["actor", f.actor], ["mediaHash", f.mediaHash], ["bundleHash", f.bundleHash], ["nonce", f.nonce]] as const) {
    if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
  }
  for (const [name, v] of Object.entries({ clusterTag: f.clusterTag, tier: f.tier, role: f.role, tamper: f.tamper, uv: f.uv,
    hum: f.hum, heat: f.heat, heatLevels: f.heatLevels, fill: f.fill, purpose: f.purpose, actorKind: f.actorKind })) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`${name} must be a u8, got ${v}`);
  }
  if (!Number.isInteger(f.siteId) || f.siteId < 0 || f.siteId > 0xffff) throw new Error(`siteId must be a u16, got ${f.siteId}`);
  need(Object.values(Cluster).includes(f.clusterTag as never), "InvalidClusterTag",
    "cluster_tag must be 1 (MAINNET), 2 (DEVNET) or 3 (LOCALNET)");
  need(Number.isInteger(f.counter) && f.counter >= 0 && f.counter <= MAX_COUNTER, "CounterOutOfRange",
    "counter must be ≤ 0x00FFFFFF");
  // step 3
  need(f.role <= MAX_U8_ENUM.role, "InvalidRole", "role must be 0..=4");
  need(f.tier <= MAX_U8_ENUM.tier, "InvalidTier", "tier must be 0..=4");
  need(f.purpose <= MAX_U8_ENUM.purpose, "InvalidPurpose", "purpose must be 0..=6");
  need(f.actorKind <= MAX_U8_ENUM.actorKind, "InvalidActorKind", "actor_kind must be 0..=4");
  need([f.tamper, f.uv, f.hum, f.heat].every((v) => v <= MAX_U8_ENUM.indicator), "InvalidIndicator",
    "tamper/uv/hum/heat must be 0..=3");
  need(f.fill <= 100 || f.fill === FILL_NONE, "InvalidFill", "fill must be 0..=100 or FILL_NONE (255)");
  need(f.heatLevels < 64, "InvalidHeatLevels", "heat_levels is a 6-bit mask");
  if (f.heat === Indicator.INTACT || f.heat === Indicator.TRIGGERED) {
    need(f.heat === ((f.heatLevels >> HEAT_DECISIVE_BIT) & 1), "HeatInconsistent",
      "heat INTACT/TRIGGERED must equal bit 4 of heat_levels");
  }
  const sighting = f.tier === Tier.SIGHTING;
  need(sighting === (f.fill === FILL_NONE), "InvalidSighting", "tier SIGHTING if and only if fill is FILL_NONE");
  if (sighting) {
    need(f.uv === Indicator.MISSING && f.hum === Indicator.MISSING && f.heat === Indicator.MISSING
      && f.heatLevels === 0 && bytesEqual(f.mediaHash, ZERO32), "InvalidSighting",
    "a sighting has uv/hum/heat MISSING, heat_levels 0 and no media");
  }
  const pro = isProRole(f.role);
  if (!pro) need(f.tier <= Tier.SELF_MEDIA, "TierNotAllowedForRole", "OWNER/SELLER/BUYER scans are at most tier 2");
  if (pro || f.tier >= Tier.CERTIFIED) {
    need(f.actorKind === ActorKind.PARTNER, "NotPartner", "a pro role or tier ≥ CERTIFIED needs actor PARTNER");
  }
  if (f.siteId !== 0) {
    need(pro, "SiteIdNotAllowed", "site_id is only for role VAULT/PARTNER");
    if (opts.knownSites) need(opts.knownSites.includes(f.siteId), "UnknownSite", `site ${f.siteId} is not registered`);
  }
  if (f.purpose === Purpose.TAP) need(sighting, "PurposeNotAllowed", "TAP is a tier-0 sighting");
  if (sighting) {
    need(f.purpose === Purpose.TAP || f.purpose === Purpose.CLAIM, "PurposeNotAllowed",
      "a sighting is a TAP or a CLAIM");
  }
  if (f.purpose === Purpose.BIRTH) {
    need(f.actorKind === ActorKind.PARTNER && f.tier === Tier.BIRTH, "PurposeNotAllowed",
      "BIRTH needs actor PARTNER and tier BIRTH");
  }
  if (f.actorKind === ActorKind.NONE) {
    need(f.purpose === Purpose.TAP || f.purpose === Purpose.CHECK, "PurposeNotAllowed",
      "a visitor scan is a TAP or a CHECK");
  }
  if (f.actorKind === ActorKind.RECIPIENT) need(f.purpose === Purpose.RECEIPT, "PurposeNotAllowed", "RECIPIENT scans are RECEIPTs");
  // rule 7 (program step 4)
  if (f.actorKind === ActorKind.NONE) need(bytesEqual(f.actor, ZERO32), "ActorMismatch", "a visitor's actor is 32 zero bytes");
  if (f.actorKind === ActorKind.RECIPIENT) need(!bytesEqual(f.actor, ZERO32), "ActorMismatch", "a RECIPIENT actor is a commitment");
}

/**
 * Exactly these bytes (§3.1), all integers little endian:
 * "FVSCAN2" ‖ program_id ‖ cluster_tag ‖ serial_hash ‖ uid_hash ‖ counter u32 ‖ tier ‖ role ‖ tamper ‖ uv ‖ hum ‖
 * heat ‖ heat_levels ‖ fill ‖ site_id u16 ‖ purpose ‖ actor_kind ‖ actor ‖ media_hash ‖ bundle_hash ‖ nonce ‖ ts i64
 */
export function buildScanMessageV2(f: ScanMessageV2Fields, opts: { knownSites?: readonly number[] } = {}): Uint8Array {
  checkScanFieldsV2(f, opts);
  const msg = concatBytes(
    utf8(MSG2_PREFIX), f.programId, u8(f.clusterTag), f.serialHash, f.uidHash, u32le(f.counter),
    u8(f.tier), u8(f.role), u8(f.tamper), u8(f.uv), u8(f.hum), u8(f.heat), u8(f.heatLevels), u8(f.fill),
    u16le(f.siteId), u8(f.purpose), u8(f.actorKind), f.actor, f.mediaHash, f.bundleHash, f.nonce, i64le(f.ts),
  );
  if (msg.length !== MSG2_LEN) throw new Error(`message length ${msg.length} != ${MSG2_LEN}`);
  return msg;
}

/**
 * Reads the fields of a 256-byte FVSCAN2 message. Checks the length and the prefix only; run
 * `checkScanFieldsV2` on the result to apply the field rules.
 */
export function parseScanMessageV2(msg: Uint8Array): ParsedScanMessageV2 {
  if (msg.length !== MSG2_LEN) throw new Error(`message length ${msg.length} != ${MSG2_LEN}`);
  const prefix = new TextDecoder().decode(msg.slice(0, MSG2_OFFSETS.programId));
  if (prefix !== MSG2_PREFIX) throw new Error(`bad prefix ${JSON.stringify(prefix)}`);
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const O = MSG2_OFFSETS;
  const b32 = (o: number) => msg.slice(o, o + 32);
  return {
    programId: b32(O.programId), clusterTag: msg[O.clusterTag], serialHash: b32(O.serialHash), uidHash: b32(O.uidHash),
    counter: dv.getUint32(O.counter, true), tier: msg[O.tier], role: msg[O.role], tamper: msg[O.tamper], uv: msg[O.uv],
    hum: msg[O.hum], heat: msg[O.heat], heatLevels: msg[O.heatLevels], fill: msg[O.fill],
    siteId: dv.getUint16(O.siteId, true), purpose: msg[O.purpose], actorKind: msg[O.actorKind], actor: b32(O.actor),
    mediaHash: b32(O.mediaHash), bundleHash: b32(O.bundleHash), nonce: b32(O.nonce), ts: dv.getBigInt64(O.ts, true),
  };
}

// ---- Ed25519 precompile instruction (§3.6) ----------------------------------------------------------------

export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
const ED25519_HEADER_LEN = 16;
const THIS_INSTRUCTION = 0xffff;

/**
 * Instruction data of `Ed25519SigVerify111…` for one signature whose public key, signature and message all live in
 * the instruction itself: the layout of web3.js `Ed25519Program.createInstructionWithPublicKey` (368 bytes for
 * FVSCAN2, 264 for FVSCAN1).
 */
export function buildEd25519InstructionData(pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (pubkey.length !== 32) throw new Error("public key must be 32 bytes");
  if (signature.length !== 64) throw new Error("signature must be 64 bytes");
  const pkOff = ED25519_HEADER_LEN, sigOff = pkOff + 32, msgOff = sigOff + 64;
  return concatBytes(
    u8(1), u8(0), u16le(sigOff), u16le(THIS_INSTRUCTION), u16le(pkOff), u16le(THIS_INSTRUCTION),
    u16le(msgOff), u16le(message.length), u16le(THIS_INSTRUCTION), pubkey, signature, message,
  );
}

export interface Ed25519Payload { pubkey: Uint8Array; signature: Uint8Array; message: Uint8Array }

/**
 * Parses the data like the program's `parse_single_ed25519_n` (ed25519.rs): one signature, every instruction index
 * 0xFFFF or `ownIndex` (the instruction's position in the transaction), the given message size, all parts in
 * bounds. Values are read at their offsets, so another valid layout parses too.
 */
export function parseEd25519InstructionData(
  data: Uint8Array, opts: { messageLen?: number; ownIndex?: number } = {},
): Ed25519Payload {
  const messageLen = opts.messageLen ?? MSG2_LEN;
  const bad = (why: string): never => { throw new Error(`malformed Ed25519 instruction: ${why}`); };
  if (data.length < ED25519_HEADER_LEN) bad("shorter than the header");
  if (data[0] !== 1) bad("not exactly one signature");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = (o: number) => dv.getUint16(o, true);
  const sigOff = at(2), sigIx = at(4), pkOff = at(6), pkIx = at(8), msgOff = at(10), msgSize = at(12), msgIx = at(14);
  const ixOk = (i: number) => i === THIS_INSTRUCTION || (opts.ownIndex !== undefined && i === opts.ownIndex);
  if (!ixOk(sigIx) || !ixOk(pkIx) || !ixOk(msgIx)) bad("data lives in another instruction");
  if (msgSize !== messageLen) bad(`message is ${msgSize} bytes, expected ${messageLen}`);
  if (pkOff + 32 > data.length || sigOff + 64 > data.length || msgOff + msgSize > data.length) bad("out of bounds");
  return {
    pubkey: data.slice(pkOff, pkOff + 32),
    signature: data.slice(sigOff, sigOff + 64),
    message: data.slice(msgOff, msgOff + msgSize),
  };
}
