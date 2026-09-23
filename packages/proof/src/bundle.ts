import { z } from "zod";
import { BUNDLE_SCHEMA } from "./enums.ts";
import { canonicalize, type Json } from "./canonical.ts";
import { sha256Bytes, utf8 } from "./bytes.ts";

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
