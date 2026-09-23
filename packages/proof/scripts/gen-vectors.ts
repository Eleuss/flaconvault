/**
 * Writes docs/vectors.json and docs/enums.json — shared fixtures for
 * apps/verify (pytest) and programs/flacon (anchor test). Run: npm run vectors
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENUMS, MSG_PREFIX, MSG_LEN, PDA_SEEDS, BUNDLE_SCHEMA, NONCE_TTL_S, HEAT_FIELDS_C, HEAT_DECISIVE_INDEX,
  KEY_DIV_APP_ID_HEX, KEY_DIV_SYS_ID, Grade, Indicator, Tamper, Verdict, Tier, Role,
  buildScanMessage, serialHash, uidHash, bindingHash, computeGrade, heatLevelsToMask,
  canonicalBundle, bundleHash, ed25519PublicKey, ed25519Sign, ed25519Verify,
  bytesToHex, hexToBytes, sha256Hex, utf8, ZERO32, type ScanProofBundle,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, "../../../docs");
mkdirSync(docs, { recursive: true });

// Deterministic TEST key — never used in production. Server .env uses its own seed.
const seedHex = sha256Hex(utf8("flaconvault:test-server-key:1"));
const seed = hexToBytes(seedHex);
const pubkey = ed25519PublicKey(seed);

interface ScanCase {
  name: string; serial: string; uidHex: string; counter: number; tier: number; role: number;
  tamper: number; uv: number; hum: number; heat: number; heatLevels: [number, number, number, number, number, number];
  fill: number; mediaSeed: string | null; nonceSeed: string; ts: number; sealKind: "BOX" | "NECK";
  country: string | null; city: string | null; platform: "SIMULATOR" | "ANDROID_WEB";
}
const cases: ScanCase[] = [
  { name: "valid-neck-tier2-grade-a", serial: "SN-2026-000001", uidHex: "04A1B2C3D4E5F6", counter: 14, tier: Tier.SELF_MEDIA, role: Role.SELLER,
    tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: Indicator.INTACT, heat: Indicator.INTACT, heatLevels: [1, 1, 0, 0, 0, 0],
    fill: 92, mediaSeed: "frames-1", nonceSeed: "nonce-1", ts: 1790000012, sealKind: "NECK", country: "DE", city: "Wickede", platform: "SIMULATOR" },
  { name: "heat-triggered-grade-c", serial: "SN-2026-000001", uidHex: "04A1B2C3D4E5F6", counter: 15, tier: Tier.SELF_MEDIA, role: Role.SELLER,
    tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: Indicator.INTACT, heat: Indicator.TRIGGERED, heatLevels: [1, 1, 1, 1, 1, 0],
    fill: 92, mediaSeed: "frames-2", nonceSeed: "nonce-2", ts: 1790000100, sealKind: "NECK", country: "DE", city: "Wickede", platform: "ANDROID_WEB" },
  { name: "tier1-no-media-grade-b", serial: "SN-2026-000002", uidHex: "04DE5F1EACC040", counter: 3, tier: Tier.SELF, role: Role.OWNER,
    tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: Indicator.INTACT, heat: Indicator.INTACT, heatLevels: [0, 0, 0, 0, 0, 0],
    fill: 75, mediaSeed: null, nonceSeed: "nonce-3", ts: 1790001000, sealKind: "BOX", country: null, city: null, platform: "SIMULATOR" },
  { name: "certified-birth-tier4-far-future-ts", serial: "SN-2026-000003", uidHex: "041E3C8A2D6B80", counter: 1, tier: Tier.BIRTH, role: Role.PARTNER,
    tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: Indicator.INTACT, heat: Indicator.INTACT, heatLevels: [0, 0, 0, 0, 0, 0],
    fill: 100, mediaSeed: "frames-4", nonceSeed: "nonce-4", ts: 4102444800, sealKind: "NECK", country: "DE", city: "Düsseldorf", platform: "ANDROID_WEB" },
  { name: "humidity-unreadable-review-flag", serial: "SN-2026-000002", uidHex: "04DE5F1EACC040", counter: 4, tier: Tier.SELF_MEDIA, role: Role.BUYER,
    tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: Indicator.UNREADABLE, heat: Indicator.INTACT, heatLevels: [1, 0, 0, 0, 0, 0],
    fill: 40, mediaSeed: "frames-5", nonceSeed: "nonce-5", ts: 1790002000, sealKind: "BOX", country: "DE", city: "München", platform: "SIMULATOR" },
];

const scans = cases.map((c) => {
  const sh = serialHash(c.serial), uh = uidHash(c.uidHex);
  const mediaHash = c.mediaSeed ? hexToBytes(sha256Hex(utf8(c.mediaSeed))) : ZERO32;
  const nonce = hexToBytes(sha256Hex(utf8(c.nonceSeed)));
  const msg = buildScanMessage({ serialHash: sh, uidHash: uh, counter: c.counter, tamper: c.tamper, uv: c.uv, hum: c.hum, heat: c.heat, fill: c.fill, mediaHash, nonce, ts: c.ts });
  const sig = ed25519Sign(msg, seed);
  if (!ed25519Verify(sig, msg, pubkey)) throw new Error("self-verify failed");
  const g = computeGrade({ verdict: Verdict.VALID, tamper: c.tamper, heat: c.heat, hum: c.hum, fill: c.fill });
  const bundle: ScanProofBundle = {
    schema: BUNDLE_SCHEMA, serial: c.serial, serialHash: bytesToHex(sh, true), uidHash: bytesToHex(uh, true), counter: c.counter,
    seal: { kind: c.sealKind, uidHash: bytesToHex(uh, true) }, tamper: c.tamper,
    indicators: { heat: c.heat, humidity: c.hum, uv: c.uv }, heatLevels: c.heatLevels, fill: c.fill,
    visual: { loopIntact: null, note: "" }, location: { country: c.country, city: c.city },
    media: c.mediaSeed ? [{ type: "SEAL_FRAMES", sha256: bytesToHex(mediaHash, true), ar: null }] : [],
    logger: null, session: { nonce: bytesToHex(nonce, true), issuedAt: c.ts - 12 }, device: { platform: c.platform },
    attester: { role: c.role, tier: c.tier, pubkey: "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2" },
    server: { keyId: 1, verdict: "VALID", ts: c.ts, sig: bytesToHex(sig, true) }, ts: c.ts + 3,
  };
  return {
    name: c.name,
    input: { serial: c.serial, uidHex: c.uidHex, counter: c.counter, tier: c.tier, role: c.role, tamper: c.tamper, uv: c.uv, hum: c.hum, heat: c.heat,
      heatLevels: c.heatLevels, fill: c.fill, mediaHashHex: bytesToHex(mediaHash), nonceHex: bytesToHex(nonce), ts: c.ts },
    serialHashHex: bytesToHex(sh), uidHashHex: bytesToHex(uh), heatMask: heatLevelsToMask(c.heatLevels),
    msgHex: bytesToHex(msg), sigHex: bytesToHex(sig), grade: g.grade, reviewRecommended: g.reviewRecommended,
    bundleCanonical: canonicalBundle(bundle), bundleHashHex: bytesToHex(bundleHash(bundle)),
  };
});

const gradeCases: Array<[string, number, number, number, number, boolean]> = [
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 92, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 90, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 89, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 60, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 59, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 0, false],
  [Verdict.VALID, Tamper.CLOSED, Indicator.INTACT, Indicator.INTACT, 100, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.TRIGGERED, Indicator.INTACT, 100, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.TRIGGERED, 100, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.TRIGGERED, Indicator.TRIGGERED, 10, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.UNREADABLE, Indicator.INTACT, 95, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.UNREADABLE, 50, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.MISSING, Indicator.MISSING, 95, false],
  [Verdict.VALID, Tamper.OPENED_NOW, Indicator.INTACT, Indicator.INTACT, 100, false],
  [Verdict.VALID, Tamper.OPENED_BEFORE, Indicator.INTACT, Indicator.INTACT, 100, false],
  [Verdict.VALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 100, true],
  [Verdict.REPLAY, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 100, false],
  [Verdict.INVALID, Tamper.UNKNOWN, Indicator.INTACT, Indicator.INTACT, 100, false],
];
const grades = gradeCases.map(([verdict, tamper, heat, hum, fill, sealDead]) => {
  const r = computeGrade({ verdict, tamper, heat, hum, fill, sealDead });
  return { verdict, tamper, heat, hum, fill, sealDead, grade: r.grade, reviewRecommended: r.reviewRecommended };
});

const firstSealUidHash = uidHash("04A1B2C3D4E5F6");
const vectors = {
  schema: "flaconvault.vectors.v1",
  generatedBy: "packages/proof/scripts/gen-vectors.ts",
  constants: { MSG_PREFIX, MSG_LEN, BUNDLE_SCHEMA, NONCE_TTL_S, PDA_SEEDS, HEAT_FIELDS_C, HEAT_DECISIVE_INDEX, KEY_DIV_APP_ID_HEX, KEY_DIV_SYS_ID },
  serverTestKey: { keyId: 1, seedHex, pubkeyHex: bytesToHex(pubkey), note: "TEST ONLY — derived from sha256('flaconvault:test-server-key:1')" },
  hashes: {
    serial: [
      { serial: "SN-2026-000001", sha256Hex: bytesToHex(serialHash("SN-2026-000001")) },
      { serial: "SN-2026-000002", sha256Hex: bytesToHex(serialHash("SN-2026-000002")) },
    ],
    uid: [
      { uidHex: "04A1B2C3D4E5F6", sha256Hex: bytesToHex(uidHash("04A1B2C3D4E5F6")) },
      { uidHex: "041E3C8A2D6B80", sha256Hex: bytesToHex(uidHash("041E3C8A2D6B80")) },
    ],
    binding: [{ serial: "SN-2026-000001", batchCode: "4A12", firstSealUidHex: "04A1B2C3D4E5F6", sha256Hex: bytesToHex(bindingHash("SN-2026-000001", "4A12", firstSealUidHash)) }],
  },
  scans,
  grades,
  sdm: {
    note: "NTAG 424 DNA SUN, plain mirror (AN12196). Key = 16×0x00 (factory). From icedevml/sdm-backend tests & AN12196.",
    plain: [
      { uidHex: "041E3C8A2D6B80", ctrHex: "000006", keyHex: "00000000000000000000000000000000", cmacHex: "4B00064004B0B3D3", valid: true },
      { uidHex: "041E3C8A2D6B80", ctrHex: "000006", keyHex: "00000000000000000000000000000000", cmacHex: "4B00064004B0B3D4", valid: false },
    ],
    encrypted_reference: [
      { note: "AN12196 p.12, SEPARATED params, null keys", picc_data: "EF963FF7828658A599F3041510671E88", cmac: "94EED9EE65337086", uidHex: "04DE5F1EACC040", ctr: 61 },
    ],
  },
  urlExample: "https://<verifier-host>/t?uid=04A1B2C3D4E5F6&ctr=00000E&cmac=6F3A0B1C2D3E4F50",
};

writeFileSync(resolve(docs, "vectors.json"), JSON.stringify(vectors, null, 2) + "\n");
writeFileSync(resolve(docs, "enums.json"), JSON.stringify({ schema: "flaconvault.enums.v1", ...ENUMS, verdict: Object.values(Verdict), grade_rule: "briefing §4.5, see packages/proof/src/grade.ts" }, null, 2) + "\n");
console.log(`wrote ${docs}/vectors.json (${scans.length} scans, ${grades.length} grade rows) and enums.json; server test pubkey ${bytesToHex(pubkey)}`);
