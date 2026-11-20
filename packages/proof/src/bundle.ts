import { z } from "zod";
import {
  ActorKind, ActorKindName, BUNDLE_SCHEMA, BUNDLE2_SCHEMA, Cluster, ClusterName, FILL_NONE, Purpose, PurposeName,
} from "./enums.ts";
import { canonicalize, type Json } from "./canonical.ts";
import { bytesEqual, bytesToHex, sha256Bytes, utf8, ZERO32 } from "./bytes.ts";
import { base58Encode } from "./b58.ts";
import { serialHash } from "./message.ts";
import { MAX_COUNTER, parseScanMessageV2, type ScanMessageV2Fields } from "./message2.ts";
import { heatLevelsToMask, maskToHeatLevels } from "./grade.ts";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "0x + 64 lowercase hex");
const u8 = z.number().int().min(0).max(255);
const bit = z.union([z.literal(0), z.literal(1)]);

/** Briefing §4.4 — ScanProof bundle v1, canonically serialised → bundle_hash, stored on Arweave. */
export const ScanProofBundleSchema = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  serial: z.string().min(1).max(64),
  serialHash: hex32,
  uidHash: hex32,
  counter: z.number().int().min(0).max(0xffffffff),
  seal: z.object({ kind: z.enum(["BOX", "NECK", "LOOP"]), uidHash: hex32 }),
  tamper: u8.max(3),
  indicators: z.object({ heat: u8.max(3), humidity: u8.max(3), uv: u8.max(3) }),
  heatLevels: z.tuple([bit, bit, bit, bit, bit, bit]),
  fill: z.number().int().min(0).max(100),
  visual: z.object({ loopIntact: z.boolean().nullable(), note: z.string().max(280) }),
  location: z.object({ country: z.string().length(2).nullable(), city: z.string().max(80).nullable() }),
  media: z.array(z.object({ type: z.enum(["SEAL_FRAMES", "PHOTO"]), sha256: hex32, ar: z.string().nullable() })),
  logger: z.null(),
  session: z.object({ nonce: hex32, issuedAt: z.number().int() }),
  device: z.object({ platform: z.enum(["ANDROID_WEB", "IOS_WEB", "DESKTOP_WEB", "SIMULATOR"]) }),
  attester: z.object({ role: u8.max(4), tier: u8.max(4), pubkey: z.string().min(32).max(64).nullable() }),
  server: z.object({
    keyId: u8, verdict: z.string(), ts: z.number().int(),
    sig: z.string().regex(/^0x[0-9a-f]{128}$/),
  }),
  ts: z.number().int(),
});
export type ScanProofBundle = z.infer<typeof ScanProofBundleSchema>;

export function canonicalBundle(b: ScanProofBundle): string {
  return canonicalize(ScanProofBundleSchema.parse(b) as unknown as Json);
}
export function bundleHash(b: ScanProofBundle): Uint8Array {
  return sha256Bytes(utf8(canonicalBundle(b)));
}

// ---- v2 bundle (docs/public-record.md §4.3) ---------------------------------------------------------------

const u16 = z.number().int().min(0).max(0xffff);
const names = <T extends Record<string, number>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

/**
 * `flaconvault.scanbundle.v2`: the public detail document whose sha256 is signed as FVSCAN2 `bundle_hash`. It holds
 * no server signature (it is hashed before signing) and none of: free-text note, city, device platform, attester
 * pubkey, Arweave links, logger, a second top-level ts. Those stay in the verifier's database (erasable).
 */
export const ScanBundleV2Schema = z.object({
  schema: z.literal(BUNDLE2_SCHEMA),
  cluster: z.enum(names(Cluster)),
  programId: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 public key"),
  serial: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/),
  serialHash: hex32,
  seal: z.object({ kind: z.enum(["BOX", "NECK"]), uidHash: hex32 }).strict(),
  counter: z.number().int().min(0).max(MAX_COUNTER),
  purpose: z.enum(names(Purpose)),
  actor: z.object({ kind: z.enum(names(ActorKind)), id: hex32.nullable() }).strict(),
  attester: z.object({ tier: u8.max(4), role: u8.max(4), siteId: u16 }).strict(),
  tamper: u8.max(3),
  indicators: z.object({ heat: u8.max(3), humidity: u8.max(3), uv: u8.max(3) }).strict(),
  heatLevels: z.tuple([bit, bit, bit, bit, bit, bit]),
  fill: z.number().int().min(0).max(100).nullable(),
  visual: z.object({ loopIntact: z.boolean().nullable() }).strict(),
  location: z.object({ country: z.string().regex(/^[A-Z]{2}$/).nullable() }).strict(),
  media: z.array(z.object({ type: z.literal("SEAL_FRAMES"), sha256: hex32 }).strict()).max(1),
  session: z.object({ nonce: hex32, issuedAt: z.number().int() }).strict(),
  server: z.object({ keyId: u8, verdict: z.literal("VALID"), ts: z.number().int() }).strict(),
}).strict().superRefine((b, ctx) => {
  if ((b.actor.id === null) !== (b.actor.kind === "NONE")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actor", "id"], message: "actor.id is null if and only if kind is NONE" });
  }
  if (bytesToHex(sha256Bytes(utf8(b.serial)), true) !== b.serialHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["serialHash"], message: "serialHash must be sha256(serial)" });
  }
});
export type ScanBundleV2 = z.infer<typeof ScanBundleV2Schema>;

export function canonicalBundleV2(b: ScanBundleV2): string {
  return canonicalize(ScanBundleV2Schema.parse(b) as unknown as Json);
}
export function bundleHashV2(b: ScanBundleV2): Uint8Array {
  return sha256Bytes(utf8(canonicalBundleV2(b)));
}

/** Everything a v2 bundle says: the FVSCAN2 fields except bundle_hash, plus the bundle-only detail. */
export interface ScanBundleV2Input extends Omit<ScanMessageV2Fields, "bundleHash" | "serialHash"> {
  serial: string;
  sealKind: "BOX" | "NECK";
  keyId: number;
  issuedAt: number;            // CHECK: the session nonce's issued_at; TAP: = ts
  country: string | null;      // two upper-case letters
  loopIntact: boolean | null;
}

/** Builds (and validates) the v2 bundle; hash it with `bundleHashV2` and sign the FVSCAN2 that carries the hash. */
export function buildBundleV2(i: ScanBundleV2Input): ScanBundleV2 {
  const zero = bytesEqual(i.mediaHash, ZERO32);
  return ScanBundleV2Schema.parse({
    schema: BUNDLE2_SCHEMA,
    cluster: ClusterName[i.clusterTag],
    programId: base58Encode(i.programId),
    serial: i.serial,
    serialHash: bytesToHex(serialHash(i.serial), true),
    seal: { kind: i.sealKind, uidHash: bytesToHex(i.uidHash, true) },
    counter: i.counter,
    purpose: PurposeName[i.purpose],
    actor: { kind: ActorKindName[i.actorKind], id: i.actorKind === ActorKind.NONE ? null : bytesToHex(i.actor, true) },
    attester: { tier: i.tier, role: i.role, siteId: i.siteId },
    tamper: i.tamper,
    indicators: { heat: i.heat, humidity: i.hum, uv: i.uv },
    heatLevels: maskToHeatLevels(i.heatLevels),
    fill: i.fill === FILL_NONE ? null : i.fill,
    visual: { loopIntact: i.loopIntact },
    location: { country: i.country },
    media: zero ? [] : [{ type: "SEAL_FRAMES", sha256: bytesToHex(i.mediaHash, true) }],
    session: { nonce: bytesToHex(i.nonce, true), issuedAt: i.issuedAt },
    server: { keyId: i.keyId, verdict: "VALID", ts: Number(i.ts) },
  });
}

/**
 * Field-by-field comparison of a v2 bundle with the FVSCAN2 message that signs it (§4.3 "= msg …" column), including
 * msg bundle_hash = sha256(canonical bundle). Returns the names of the fields that differ; empty = match.
 */
export function bundleV2Mismatches(b: ScanBundleV2, msg: Uint8Array): string[] {
  const m = parseScanMessageV2(msg);
  const out: string[] = [];
  const eq = (name: string, ok: boolean) => { if (!ok) out.push(name); };
  const hex = (x: Uint8Array) => bytesToHex(x, true);
  eq("bundleHash", bytesEqual(bundleHashV2(b), m.bundleHash));
  eq("cluster", b.cluster === ClusterName[m.clusterTag]);
  eq("programId", b.programId === base58Encode(m.programId));
  eq("serialHash", b.serialHash === hex(m.serialHash));
  eq("seal.uidHash", b.seal.uidHash === hex(m.uidHash));
  eq("counter", b.counter === m.counter);
  eq("purpose", b.purpose === PurposeName[m.purpose]);
  eq("actor.kind", b.actor.kind === ActorKindName[m.actorKind]);
  eq("actor.id", m.actorKind === ActorKind.NONE ? b.actor.id === null : b.actor.id === hex(m.actor));
  eq("attester", b.attester.tier === m.tier && b.attester.role === m.role && b.attester.siteId === m.siteId);
  eq("tamper", b.tamper === m.tamper);
  eq("indicators", b.indicators.heat === m.heat && b.indicators.humidity === m.hum && b.indicators.uv === m.uv);
  eq("heatLevels", heatLevelsToMask(b.heatLevels) === m.heatLevels);
  eq("fill", m.fill === FILL_NONE ? b.fill === null : b.fill === m.fill);
  eq("media", bytesEqual(m.mediaHash, ZERO32) ? b.media.length === 0 : b.media[0]?.sha256 === hex(m.mediaHash));
  eq("session.nonce", b.session.nonce === hex(m.nonce));
  eq("server.ts", BigInt(b.server.ts) === m.ts);
  return out;
}
export function bundleMatchesMessageV2(b: ScanBundleV2, msg: Uint8Array): boolean {
  return bundleV2Mismatches(b, msg).length === 0;
}
