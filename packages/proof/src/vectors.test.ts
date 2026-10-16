/**
 * Parity test: the committed fixtures docs/vectors.json and docs/enums.json must match what this package computes.
 * The Python verifier and the Rust program are tested against those files, and the web app imports this package at
 * runtime, so an edit to enums.ts, grade.ts, message.ts or bundle.ts without `npm run vectors` must fail here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENUMS, Verdict, Grade, MSG_PREFIX, MSG_LEN, BUNDLE_SCHEMA, NONCE_TTL_S, PDA_SEEDS, HEAT_FIELDS_C, HEAT_DECISIVE_INDEX,
  KEY_DIV_APP_ID_HEX, KEY_DIV_SYS_ID, buildScanMessage, parseScanMessage, serialHash, uidHash, bindingHash, computeGrade,
  heatLevelsToMask, canonicalBundle, bundleHash, ScanProofBundleSchema, ed25519PublicKey, ed25519Sign, ed25519Verify,
  bytesToHex, hexToBytes, sha256Hex, utf8,
} from "./index.ts";

function readDoc(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8"));
}
const vectors = readDoc("vectors.json");
const enums = readDoc("enums.json");

interface ScanVector {
  name: string;
  input: {
    serial: string; uidHex: string; counter: number; tier: number; role: number; tamper: number; uv: number; hum: number;
    heat: number; heatLevels: number[]; fill: number; mediaHashHex: string; nonceHex: string; ts: number;
  };
  serialHashHex: string; uidHashHex: string; heatMask: number; msgHex: string; sigHex: string; grade: number;
  reviewRecommended: boolean; bundleCanonical: string; bundleHashHex: string;
}
interface GradeRow {
  verdict: string; tamper: number; heat: number; hum: number; fill: number; sealDead: boolean; grade: number;
  reviewRecommended: boolean;
}
const scans: ScanVector[] = vectors.scans;
const grades: GradeRow[] = vectors.grades;

test("docs/enums.json matches enums.ts", () => {
  assert.equal(enums.schema, "flaconvault.enums.v1");
  const fileGroups = Object.keys(enums).filter((k) => !["schema", "verdict", "grade_rule"].includes(k)).sort();
  assert.deepEqual(fileGroups, Object.keys(ENUMS).sort(), "enum groups differ");
  for (const [group, values] of Object.entries(ENUMS)) {
    assert.deepEqual(enums[group], { ...values }, `enum group ${group} differs from docs/enums.json`);
  }
  assert.deepEqual(enums.verdict, Object.values(Verdict));
});

test("docs/vectors.json constants match enums.ts", () => {
  assert.equal(vectors.schema, "flaconvault.vectors.v1");
  assert.deepEqual(vectors.constants, {
    MSG_PREFIX, MSG_LEN, BUNDLE_SCHEMA, NONCE_TTL_S, PDA_SEEDS: { ...PDA_SEEDS }, HEAT_FIELDS_C: [...HEAT_FIELDS_C],
    HEAT_DECISIVE_INDEX, KEY_DIV_APP_ID_HEX, KEY_DIV_SYS_ID,
  });
});

test("server test key is the documented deterministic test key", () => {
  const k = vectors.serverTestKey;
  assert.equal(k.seedHex, sha256Hex(utf8("flaconvault:test-server-key:1")));
  assert.equal(bytesToHex(ed25519PublicKey(k.seedHex)), k.pubkeyHex);
});

test("serial, uid and binding hashes match", () => {
  for (const h of vectors.hashes.serial) assert.equal(bytesToHex(serialHash(h.serial)), h.sha256Hex, h.serial);
  for (const h of vectors.hashes.uid) assert.equal(bytesToHex(uidHash(h.uidHex)), h.sha256Hex, h.uidHex);
  for (const h of vectors.hashes.binding) {
    assert.equal(bytesToHex(bindingHash(h.serial, h.batchCode, uidHash(h.firstSealUidHex))), h.sha256Hex, h.serial);
  }
});

test("scan vectors: message bytes, signature, grade and heat mask", () => {
  assert.ok(scans.length >= 5, "expected at least 5 scan vectors");
  const seed = hexToBytes(vectors.serverTestKey.seedHex);
  const pub = hexToBytes(vectors.serverTestKey.pubkeyHex);
  for (const s of scans) {
    const i = s.input;
    const sh = serialHash(i.serial), uh = uidHash(i.uidHex);
    assert.equal(bytesToHex(sh), s.serialHashHex, `${s.name}: serialHash`);
    assert.equal(bytesToHex(uh), s.uidHashHex, `${s.name}: uidHash`);
    assert.equal(heatLevelsToMask(i.heatLevels), s.heatMask, `${s.name}: heatMask`);
    const msg = buildScanMessage({
      serialHash: sh, uidHash: uh, counter: i.counter, tamper: i.tamper, uv: i.uv, hum: i.hum, heat: i.heat, fill: i.fill,
      mediaHash: hexToBytes(i.mediaHashHex), nonce: hexToBytes(i.nonceHex), ts: i.ts,
    });
    assert.equal(bytesToHex(msg), s.msgHex, `${s.name}: message bytes`);
    const parsed = parseScanMessage(hexToBytes(s.msgHex));
    assert.equal(parsed.counter, i.counter, `${s.name}: parsed counter`);
    assert.equal(parsed.ts, BigInt(i.ts), `${s.name}: parsed ts`);
    // Ed25519 is deterministic: the same seed and message give the committed signature.
    assert.equal(bytesToHex(ed25519Sign(msg, seed)), s.sigHex, `${s.name}: signature`);
    assert.ok(ed25519Verify(hexToBytes(s.sigHex), msg, pub), `${s.name}: signature verifies`);
    const g = computeGrade({ verdict: Verdict.VALID, tamper: i.tamper, heat: i.heat, hum: i.hum, fill: i.fill });
    assert.equal(g.grade, s.grade, `${s.name}: grade`);
    assert.equal(g.reviewRecommended, s.reviewRecommended, `${s.name}: reviewRecommended`);
  }
});

test("scan vectors: bundle schema, canonical form and bundle hash", () => {
  for (const s of scans) {
    const i = s.input;
    const bundle = ScanProofBundleSchema.parse(JSON.parse(s.bundleCanonical));
    assert.equal(canonicalBundle(bundle), s.bundleCanonical, `${s.name}: canonical form`);
    assert.equal(bytesToHex(bundleHash(bundle)), s.bundleHashHex, `${s.name}: bundle hash`);
    assert.equal(s.bundleHashHex, sha256Hex(utf8(s.bundleCanonical)), `${s.name}: bundle hash = sha256(canonical)`);
    // The bundle describes the same scan as the signed message.
    assert.equal(bundle.serial, i.serial);
    assert.equal(bundle.serialHash, "0x" + s.serialHashHex);
    assert.equal(bundle.uidHash, "0x" + s.uidHashHex);
    assert.equal(bundle.counter, i.counter);
    assert.equal(bundle.tamper, i.tamper);
    assert.deepEqual(bundle.indicators, { heat: i.heat, humidity: i.hum, uv: i.uv });
    assert.deepEqual(bundle.heatLevels, i.heatLevels);
    assert.equal(bundle.fill, i.fill);
    assert.equal(bundle.session.nonce, "0x" + i.nonceHex);
    assert.equal(bundle.attester.tier, i.tier);
    assert.equal(bundle.attester.role, i.role);
    assert.equal(bundle.server.sig, "0x" + s.sigHex);
    assert.equal(bundle.server.ts, i.ts);
    const zero = "00".repeat(32);
    if (i.mediaHashHex === zero) assert.deepEqual(bundle.media, [], `${s.name}: no media without a media hash`);
    else assert.equal(bundle.media[0]?.sha256, "0x" + i.mediaHashHex, `${s.name}: media hash`);
  }
});

test("grade table matches computeGrade and covers every grade", () => {
  for (const r of grades) {
    const g = computeGrade({ verdict: r.verdict, tamper: r.tamper, heat: r.heat, hum: r.hum, fill: r.fill, sealDead: r.sealDead });
    const label = `${r.verdict} tamper=${r.tamper} heat=${r.heat} hum=${r.hum} fill=${r.fill} sealDead=${r.sealDead}`;
    assert.equal(g.grade, r.grade, `${label}: grade`);
    assert.equal(g.reviewRecommended, r.reviewRecommended, `${label}: reviewRecommended`);
  }
  assert.deepEqual([...new Set(grades.map((r) => r.grade))].sort(), Object.values(Grade).sort());
});
