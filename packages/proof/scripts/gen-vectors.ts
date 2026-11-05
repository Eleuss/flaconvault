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
  MSG2_PREFIX, MSG2_LEN, SCAN_HEAD_PREFIX, COMMITMENT_PREFIX, FILL_NONE, BUNDLE2_SCHEMA, Cluster, ClusterName,
  Purpose, ActorKind, SealKind, MSG2_OFFSETS, parseScanMessageV2,
  buildScanMessage, serialHash, uidHash, bindingHash, computeGrade, heatLevelsToMask,
  canonicalBundle, bundleHash, ed25519PublicKey, ed25519Sign, ed25519Verify,
  bytesToHex, hexToBytes, sha256Bytes, sha256Hex, utf8, ZERO32, type ScanProofBundle,
  buildScanMessageV2, buildBundleV2, canonicalBundleV2, bundleHashV2, buildEd25519InstructionData, checkScanFieldsV2,
  ScanFieldError, commitment, foldScanHead, SCAN_HEAD_ZERO, actorChangesGrade, passportAfterScanV2, anchorDiscriminator,
  base58Encode, base58Decode, pdaRegistry, pdaPassport, pdaSeal, pdaHolderConfig, pdaHolding, pdaEventAuthority,
  type PassportGrade,
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

// ---- v2: FVSCAN2, commitments, scan head (docs/public-record.md §5) ------------------------------------------

const V2_PROGRAM_ID = "7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL"; // flacon on devnet (DEFAULT_PROGRAM_ID)
const programIdBytes = base58Decode(V2_PROGRAM_ID);
const V2_CLUSTER = Cluster.DEVNET;
const V2_SERIAL = "SN-2026-000001", V2_UID = "04A1B2C3D4E5F6";
const passportPda = pdaPassport(serialHash(V2_SERIAL), programIdBytes).address;
const label32 = (label: string) => sha256Bytes(utf8(label));
function testActor(seedLabel: string) {
  const pub = ed25519PublicKey(label32(seedLabel));
  return { seedLabel, pubkey: base58Encode(pub), pubkeyHex: bytesToHex(pub) };
}
const actors = { partner: testActor("flaconvault:test-partner:1"), wallet: testActor("flaconvault:test-wallet:1") };
const commitments = [0, 1].map((epoch) => {
  const secretLabel = `flaconvault:test-holder-secret:${epoch}`;
  return {
    passport: base58Encode(passportPda), passportHex: bytesToHex(passportPda), epoch, secretLabel,
    secretHex: bytesToHex(label32(secretLabel)), commitmentHex: bytesToHex(commitment(passportPda, epoch, label32(secretLabel))),
  };
});

interface ScanV2Case {
  name: string; counter: number; tier: number; role: number; hum: number; heat: number;
  heatLevels: [number, number, number, number, number, number]; fill: number; siteId: number; purpose: number;
  actorKind: number; actorHex: string; mediaSeed: string | null; nonceSeed: string; ts: number; issuedAt: number;
  country: string | null;
}
const zeroHex = "00".repeat(32);
const v2Cases: ScanV2Case[] = [
  { name: "birth-partner-tier4", counter: 1, tier: Tier.BIRTH, role: Role.PARTNER, hum: Indicator.INTACT, heat: Indicator.INTACT,
    heatLevels: [0, 0, 0, 0, 0, 0], fill: 100, siteId: 1, purpose: Purpose.BIRTH, actorKind: ActorKind.PARTNER,
    actorHex: actors.partner.pubkeyHex, mediaSeed: "frames-v2-birth", nonceSeed: "nonce-v2-1", ts: 1790000100, issuedAt: 1790000100, country: "DE" },
  { name: "tap-visitor-sighting", counter: 2, tier: Tier.SIGHTING, role: Role.OWNER, hum: Indicator.MISSING, heat: Indicator.MISSING,
    heatLevels: [0, 0, 0, 0, 0, 0], fill: FILL_NONE, siteId: 0, purpose: Purpose.TAP, actorKind: ActorKind.NONE,
    actorHex: zeroHex, mediaSeed: null, nonceSeed: "nonce-v2-2", ts: 1790000200, issuedAt: 1790000200, country: null },
  { name: "check-visitor-tier2", counter: 3, tier: Tier.SELF_MEDIA, role: Role.OWNER, hum: Indicator.INTACT, heat: Indicator.INTACT,
    heatLevels: [1, 1, 0, 0, 0, 0], fill: 92, siteId: 0, purpose: Purpose.CHECK, actorKind: ActorKind.NONE,
    actorHex: zeroHex, mediaSeed: "frames-v2-3", nonceSeed: "nonce-v2-3", ts: 1790000300, issuedAt: 1790000288, country: "DE" },
  { name: "check-holder-tier1", counter: 4, tier: Tier.SELF, role: Role.OWNER, hum: Indicator.INTACT, heat: Indicator.INTACT,
    heatLevels: [0, 0, 0, 0, 0, 0], fill: 75, siteId: 0, purpose: Purpose.CHECK, actorKind: ActorKind.HOLDER,
    actorHex: commitments[0].commitmentHex, mediaSeed: null, nonceSeed: "nonce-v2-4", ts: 1790000400, issuedAt: 1790000380, country: null },
  { name: "receipt-recipient-tier1", counter: 5, tier: Tier.SELF, role: Role.BUYER, hum: Indicator.INTACT, heat: Indicator.INTACT,
    heatLevels: [0, 0, 0, 0, 0, 0], fill: 75, siteId: 0, purpose: Purpose.RECEIPT, actorKind: ActorKind.RECIPIENT,
    actorHex: commitments[1].commitmentHex, mediaSeed: null, nonceSeed: "nonce-v2-5", ts: 1790000500, issuedAt: 1790000485, country: "AT" },
  { name: "check-wallet-heat-triggered", counter: 6, tier: Tier.SELF_MEDIA, role: Role.OWNER, hum: Indicator.INTACT, heat: Indicator.TRIGGERED,
    heatLevels: [1, 1, 1, 1, 1, 0], fill: 92, siteId: 0, purpose: Purpose.CHECK, actorKind: ActorKind.WALLET,
    actorHex: actors.wallet.pubkeyHex, mediaSeed: "frames-v2-6", nonceSeed: "nonce-v2-6", ts: 1790000600, issuedAt: 1790000590, country: "DE" },
];

let head = SCAN_HEAD_ZERO;
let passportState: PassportGrade = { grade: Grade.A, void: false };
const v2Scans = v2Cases.map((c) => {
  const mediaHash = c.mediaSeed ? label32(c.mediaSeed) : ZERO32;
  const nonce = label32(c.nonceSeed);
  const heatMask = heatLevelsToMask(c.heatLevels);
  const common = {
    programId: programIdBytes, clusterTag: V2_CLUSTER, uidHash: uidHash(V2_UID), counter: c.counter, tier: c.tier,
    role: c.role, tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: c.hum, heat: c.heat, heatLevels: heatMask, fill: c.fill,
    siteId: c.siteId, purpose: c.purpose, actorKind: c.actorKind, actor: hexToBytes(c.actorHex), mediaHash, nonce, ts: c.ts,
  };
  const bundle = buildBundleV2({
    ...common, serial: V2_SERIAL, sealKind: "NECK", keyId: 1, issuedAt: c.issuedAt, country: c.country, loopIntact: null,
  });
  const bh = bundleHashV2(bundle);
  const msg = buildScanMessageV2({ ...common, serialHash: serialHash(V2_SERIAL), bundleHash: bh });
  const sig = ed25519Sign(msg, seed);
  if (!ed25519Verify(sig, msg, pubkey)) throw new Error("self-verify failed");
  head = foldScanHead(head, msg);
  const affectsGrade = actorChangesGrade(c.actorKind);
  if (affectsGrade) passportState = passportAfterScanV2(passportState, { tamper: Tamper.UNKNOWN, heat: c.heat, hum: c.hum, fill: c.fill });
  return {
    name: c.name,
    input: {
      serial: V2_SERIAL, uidHex: V2_UID, sealKind: SealKind.NECK, counter: c.counter, tier: c.tier, role: c.role,
      tamper: Tamper.UNKNOWN, uv: Indicator.MISSING, hum: c.hum, heat: c.heat, heatLevels: c.heatLevels, fill: c.fill,
      siteId: c.siteId, purpose: c.purpose, actorKind: c.actorKind, actorHex: c.actorHex, mediaHashHex: bytesToHex(mediaHash),
      nonceHex: bytesToHex(nonce), ts: c.ts, issuedAt: c.issuedAt, country: c.country,
    },
    heatMask, bundleCanonical: canonicalBundleV2(bundle), bundleHashHex: bytesToHex(bh), msgHex: bytesToHex(msg),
    msgSha256Hex: sha256Hex(msg), sigHex: bytesToHex(sig), ed25519IxHex: bytesToHex(buildEd25519InstructionData(pubkey, sig, msg)),
    affectsGrade, gradeAfter: passportState.grade, voidAfter: passportState.void, headAfterHex: bytesToHex(head),
  };
});

// One field-rule violation each (record_scan_v2 step 3, docs/public-record.md §3.4 / §7.6): the message of
// v2.scans[2] (check-visitor-tier2) with the `set` fields overwritten in place (FVSCAN2 field names, heatLevels =
// the mask, hex fields as hex). Each case breaks exactly one rule; `error` is the program's error name.
const rejectBase = v2Scans[2];
const rejectCases: Array<{ name: string; set: Record<string, number | string>; error: string }> = [
  { name: "role-out-of-range", set: { role: 5 }, error: "InvalidRole" },
  { name: "tier-out-of-range", set: { tier: 5 }, error: "InvalidTier" },
  { name: "purpose-out-of-range", set: { purpose: 7 }, error: "InvalidPurpose" },
  { name: "actor-kind-out-of-range", set: { actorKind: 5 }, error: "InvalidActorKind" },
  { name: "tamper-out-of-range", set: { tamper: 4 }, error: "InvalidIndicator" },
  { name: "uv-out-of-range", set: { uv: 4 }, error: "InvalidIndicator" },
  { name: "fill-101", set: { fill: 101 }, error: "InvalidFill" },
  { name: "heat-levels-64", set: { heatLevels: 64 }, error: "InvalidHeatLevels" },
  { name: "heat-intact-bit4-set", set: { heatLevels: 0b010011 }, error: "HeatInconsistent" },
  { name: "fill-none-at-tier2", set: { fill: FILL_NONE }, error: "InvalidSighting" },
  { name: "sighting-with-fill", set: { tier: Tier.SIGHTING, purpose: Purpose.TAP, hum: 3, heat: 3, heatLevels: 0, mediaHashHex: zeroHex }, error: "InvalidSighting" },
  { name: "sighting-with-media", set: { tier: Tier.SIGHTING, purpose: Purpose.TAP, fill: FILL_NONE, hum: 3, heat: 3, heatLevels: 0 }, error: "InvalidSighting" },
  { name: "owner-tier3", set: { tier: Tier.CERTIFIED, actorKind: ActorKind.PARTNER, actorHex: actors.partner.pubkeyHex }, error: "TierNotAllowedForRole" },
  { name: "visitor-tier3-vault", set: { tier: Tier.CERTIFIED, role: Role.VAULT }, error: "NotPartner" },
  { name: "site-for-owner", set: { siteId: 1 }, error: "SiteIdNotAllowed" },
  { name: "visitor-receipt", set: { purpose: Purpose.RECEIPT }, error: "PurposeNotAllowed" },
  { name: "tap-at-tier2", set: { purpose: Purpose.TAP }, error: "PurposeNotAllowed" },
  { name: "birth-by-holder", set: { purpose: Purpose.BIRTH, actorKind: ActorKind.HOLDER, actorHex: commitments[0].commitmentHex }, error: "PurposeNotAllowed" },
  { name: "recipient-check", set: { actorKind: ActorKind.RECIPIENT, actorHex: commitments[1].commitmentHex }, error: "PurposeNotAllowed" },
];
const v2Rejects = rejectCases.map((r) => {
  const msg = hexToBytes(rejectBase.msgHex);
  const dv = new DataView(msg.buffer);
  for (const [k, v] of Object.entries(r.set)) {
    if (k === "actorHex" || k === "mediaHashHex") msg.set(hexToBytes(String(v)), MSG2_OFFSETS[k === "actorHex" ? "actor" : "mediaHash"]);
    else if (k === "siteId") dv.setUint16(MSG2_OFFSETS.siteId, Number(v), true);
    else msg[MSG2_OFFSETS[k as keyof typeof MSG2_OFFSETS]] = Number(v);
  }
  try {
    checkScanFieldsV2(parseScanMessageV2(msg));
  } catch (e) {
    if (e instanceof ScanFieldError && e.code === r.error) return { name: r.name, base: rejectBase.name, set: r.set, msgHex: bytesToHex(msg), error: r.error };
    throw new Error(`reject case ${r.name}: expected ${r.error}, got ${(e as Error).message}`);
  }
  throw new Error(`reject case ${r.name}: accepted`);
});

const passportPdaB58 = base58Encode(passportPda);
const v2 = {
  note: "FVSCAN2 golden vectors (docs/public-record.md §5). Signatures use serverTestKey (TEST only).",
  programId: V2_PROGRAM_ID, programIdHex: bytesToHex(programIdBytes), cluster: ClusterName[V2_CLUSTER], clusterTag: V2_CLUSTER,
  pdas: {
    registry: base58Encode(pdaRegistry(programIdBytes).address), passport: passportPdaB58,
    seal: base58Encode(pdaSeal(uidHash(V2_UID), programIdBytes).address),
    holderConfig: base58Encode(pdaHolderConfig(programIdBytes).address),
    holding: base58Encode(pdaHolding(passportPda, programIdBytes).address),
    eventAuthority: base58Encode(pdaEventAuthority(programIdBytes).address),
  },
  discriminators: Object.fromEntries(([
    ["global", "record_scan_v2"], ["global", "init_holder_config"], ["global", "set_holder_config"], ["global", "init_holding_v1"],
    ["global", "mint_passport_v2"], ["global", "attach_seal_v2"], ["account", "HolderConfig"], ["account", "Holding"],
    ["event", "ScanRecordedV2"],
  ] as const).map(([ns, name]) => [`${ns}:${name}`, bytesToHex(anchorDiscriminator(ns, name))])),
  actors, commitments, scans: v2Scans,
  scanHead: { initialHex: bytesToHex(SCAN_HEAD_ZERO), count: v2Scans.length, finalHex: bytesToHex(head) },
  rejects: v2Rejects,
};

const firstSealUidHash = uidHash("04A1B2C3D4E5F6");
const vectors = {
  schema: "flaconvault.vectors.v1",
  generatedBy: "packages/proof/scripts/gen-vectors.ts",
  constants: {
    MSG_PREFIX, MSG_LEN, BUNDLE_SCHEMA, NONCE_TTL_S, PDA_SEEDS, HEAT_FIELDS_C, HEAT_DECISIVE_INDEX, KEY_DIV_APP_ID_HEX, KEY_DIV_SYS_ID,
    MSG2_PREFIX, MSG2_LEN, SCAN_HEAD_PREFIX, COMMITMENT_PREFIX, FILL_NONE, BUNDLE2_SCHEMA,
  },
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
  v2,
};

writeFileSync(resolve(docs, "vectors.json"), JSON.stringify(vectors, null, 2) + "\n");
writeFileSync(resolve(docs, "enums.json"), JSON.stringify({ schema: "flaconvault.enums.v1", ...ENUMS, verdict: Object.values(Verdict), grade_rule: "briefing §4.5, see packages/proof/src/grade.ts" }, null, 2) + "\n");
console.log(`wrote ${docs}/vectors.json (${scans.length} scans, ${grades.length} grade rows, ${v2Scans.length} v2 scans, `
  + `${v2Rejects.length} v2 rejects) and enums.json; server test pubkey ${bytesToHex(pubkey)}`);
