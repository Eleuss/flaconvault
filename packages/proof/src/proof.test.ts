import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScanMessage, parseScanMessage, serialHash, uidHash, bindingHash, computeGrade, heatLevelsToMask, maskToHeatLevels,
  canonicalize, bundleHash, canonicalBundle, ScanProofBundleSchema, ed25519PublicKey, ed25519Sign, ed25519Verify,
  bytesToHex, hexToBytes, sha256Hex, utf8, ZERO32, MSG_LEN, Grade, Indicator, Tamper, Verdict, Tier, Role,
  type ScanProofBundle,
} from "./index.ts";

const seed = hexToBytes(sha256Hex(utf8("flaconvault:test-server-key:1")));

test("message layout is 152 bytes and round-trips", () => {
  const f = {
    serialHash: serialHash("SN-2026-000001"), uidHash: uidHash("04A1B2C3D4E5F6"), counter: 14,
    tamper: 3, uv: 3, hum: 0, heat: 0, fill: 92, mediaHash: ZERO32, nonce: hexToBytes(sha256Hex(utf8("nonce-1"))), ts: 1790000012,
  };
  const msg = buildScanMessage(f);
  assert.equal(msg.length, MSG_LEN);
  assert.equal(new TextDecoder().decode(msg.slice(0, 7)), "FVSCAN1");
  // counter u32 LE at offset 71
  assert.deepEqual(Array.from(msg.slice(71, 75)), [14, 0, 0, 0]);
  const p = parseScanMessage(msg);
  assert.equal(p.counter, 14); assert.equal(p.fill, 92); assert.equal(p.ts, 1790000012n);
  assert.equal(bytesToHex(p.serialHash), bytesToHex(f.serialHash));
});

test("i64 ts beyond u32 range survives", () => {
  const msg = buildScanMessage({
    serialHash: ZERO32, uidHash: ZERO32, counter: 1, tamper: 3, uv: 3, hum: 0, heat: 0, fill: 50,
    mediaHash: ZERO32, nonce: ZERO32, ts: 4102444800,
  });
  assert.equal(parseScanMessage(msg).ts, 4102444800n);
});

test("uidHash hashes 7 raw bytes, rejects other lengths", () => {
  assert.equal(bytesToHex(uidHash("04A1B2C3D4E5F6")), sha256Hex(hexToBytes("04A1B2C3D4E5F6")));
  assert.throws(() => uidHash("0102"));
});

test("bindingHash = sha256(serial ‖ batch ‖ uidHash)", () => {
  const uh = uidHash("04A1B2C3D4E5F6");
  const expect = sha256Hex(new Uint8Array([...utf8("SN-2026-000001"), ...utf8("4A12"), ...uh]));
  assert.equal(bytesToHex(bindingHash("SN-2026-000001", "4A12", uh)), expect);
});

test("grade rule §4.5", () => {
  const base = { verdict: Verdict.VALID, tamper: Tamper.UNKNOWN, heat: Indicator.INTACT, hum: Indicator.INTACT, fill: 92 };
  assert.equal(computeGrade(base).grade, Grade.A);
  assert.equal(computeGrade({ ...base, fill: 60 }).grade, Grade.B);
  assert.equal(computeGrade({ ...base, fill: 59 }).grade, Grade.D);
  assert.equal(computeGrade({ ...base, heat: Indicator.TRIGGERED }).grade, Grade.C);
  assert.equal(computeGrade({ ...base, hum: Indicator.TRIGGERED, fill: 10 }).grade, Grade.C);
  assert.equal(computeGrade({ ...base, verdict: "REPLAY" }).grade, Grade.VOID);
  assert.equal(computeGrade({ ...base, tamper: Tamper.OPENED_NOW }).grade, Grade.VOID);
  assert.equal(computeGrade({ ...base, tamper: Tamper.OPENED_BEFORE }).grade, Grade.VOID);
  assert.equal(computeGrade({ ...base, sealDead: true }).grade, Grade.VOID);
  const u = computeGrade({ ...base, hum: Indicator.UNREADABLE });
  assert.equal(u.grade, Grade.A); assert.equal(u.reviewRecommended, true);
  assert.equal(computeGrade({ ...base, uv: 3 } as never).grade, Grade.A);
});

test("heat bitmask", () => {
  assert.equal(heatLevelsToMask([1, 1, 0, 0, 0, 0]), 0b000011);
  assert.equal(heatLevelsToMask([1, 1, 1, 1, 1, 0]), 0b011111);
  assert.deepEqual(maskToHeatLevels(0b010101), [1, 0, 1, 0, 1, 0]);
});

test("canonical JSON sorts keys and strips whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 2, y: 1 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":1,"z":2}}');
});

export const sampleBundle: ScanProofBundle = {
  schema: "flaconvault.scanproof.v1",
  serial: "SN-2026-000001",
  serialHash: bytesToHex(serialHash("SN-2026-000001"), true),
  uidHash: bytesToHex(uidHash("04A1B2C3D4E5F6"), true),
  counter: 14,
  seal: { kind: "NECK", uidHash: bytesToHex(uidHash("04A1B2C3D4E5F6"), true) },
  tamper: 3,
  indicators: { heat: 0, humidity: 0, uv: 3 },
  heatLevels: [1, 1, 0, 0, 0, 0],
  fill: 92,
  visual: { loopIntact: true, note: "" },
  location: { country: "DE", city: "Wickede" },
  media: [{ type: "SEAL_FRAMES", sha256: "0x" + sha256Hex(utf8("frames-1")), ar: null }],
  logger: null,
  session: { nonce: "0x" + sha256Hex(utf8("nonce-1")), issuedAt: 1790000000 },
  device: { platform: "SIMULATOR" },
  attester: { role: Role.BUYER, tier: Tier.SELF_MEDIA, pubkey: "7GhXQ2fV4d1eo9yq1vQdD9Zk9sHkYd8qz2pM4hN6FaK2" },
  server: { keyId: 1, verdict: "VALID", ts: 1790000012, sig: "0x" + "00".repeat(64) },
  ts: 1790000015,
};

test("bundle validates, canonical form is stable and hash matches", () => {
  ScanProofBundleSchema.parse(sampleBundle);
  const c = canonicalBundle(sampleBundle);
  assert.ok(c.startsWith('{"attester":{"pubkey":'));
  assert.equal(bytesToHex(bundleHash(sampleBundle)), sha256Hex(utf8(c)));
  assert.throws(() => ScanProofBundleSchema.parse({ ...sampleBundle, fill: 101 }));
});

test("ed25519 sign/verify with deterministic seed", () => {
  const pub = ed25519PublicKey(seed);
  const msg = utf8("hello");
  const sig = ed25519Sign(msg, seed);
  assert.equal(sig.length, 64);
  assert.ok(ed25519Verify(sig, msg, pub));
  assert.ok(!ed25519Verify(sig, utf8("hellp"), pub));
});
