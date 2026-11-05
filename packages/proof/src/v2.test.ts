/**
 * FVSCAN2, v2 bundle, commitment, scan head, PDAs and the v2 grade rule against docs/vectors.json `v2` (the fixtures
 * the Rust program and the Python verifier load too) and the hard-coded worked example of docs/public-record.md §5.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ActorKind, Cluster, ClusterName, FILL_NONE, Grade, Indicator, MSG2_LEN, MSG2_OFFSETS, Purpose, Role, Tamper, Tier,
  buildScanMessageV2, parseScanMessageV2, checkScanFieldsV2, ScanFieldError, buildEd25519InstructionData,
  parseEd25519InstructionData, buildBundleV2, canonicalBundleV2, bundleHashV2, bundleMatchesMessageV2, bundleV2Mismatches,
  ScanBundleV2Schema, commitment, foldScanHead, foldScanHeads, SCAN_HEAD_ZERO, actorChangesGrade, passportAfterScanV2,
  passportAfterScan, anchorDiscriminator, base58Decode, base58Encode, pdaEventAuthority, pdaHolderConfig, pdaHolding,
  pdaPassport, pdaRegistry, pdaSeal, isOnCurve, clusterTag, serialHash, uidHash, heatLevelsToMask, buildScanMessage,
  ed25519PublicKey, ed25519Sign, ed25519Verify, bytesToHex, hexToBytes, sha256Bytes, sha256Hex, utf8, ZERO32,
  type ScanMessageV2Fields, type ScanBundleV2, type PassportGrade,
} from "./index.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../docs/vectors.json", import.meta.url), "utf8"));
const v2 = vectors.v2;
const seed = hexToBytes(vectors.serverTestKey.seedHex);
const serverPub = hexToBytes(vectors.serverTestKey.pubkeyHex);
const programId = base58Decode(v2.programId);

interface V2Input {
  serial: string; uidHex: string; sealKind: number; counter: number; tier: number; role: number; tamper: number; uv: number;
  hum: number; heat: number; heatLevels: number[]; fill: number; siteId: number; purpose: number; actorKind: number;
  actorHex: string; mediaHashHex: string; nonceHex: string; ts: number; issuedAt: number; country: string | null;
}
function fieldsOf(i: V2Input, bundleHashHex: string): ScanMessageV2Fields {
  return {
    programId, clusterTag: v2.clusterTag, serialHash: serialHash(i.serial), uidHash: uidHash(i.uidHex), counter: i.counter,
    tier: i.tier, role: i.role, tamper: i.tamper, uv: i.uv, hum: i.hum, heat: i.heat, heatLevels: heatLevelsToMask(i.heatLevels),
    fill: i.fill, siteId: i.siteId, purpose: i.purpose, actorKind: i.actorKind, actor: hexToBytes(i.actorHex),
    mediaHash: hexToBytes(i.mediaHashHex), bundleHash: hexToBytes(bundleHashHex), nonce: hexToBytes(i.nonceHex), ts: i.ts,
  };
}
function bundleOf(i: V2Input): ScanBundleV2 {
  const f = fieldsOf(i, "00".repeat(32));
  return buildBundleV2({ ...f, serial: i.serial, sealKind: i.sealKind === 1 ? "NECK" : "BOX", keyId: vectors.serverTestKey.keyId,
    issuedAt: i.issuedAt, country: i.country, loopIntact: null });
}
const tap = v2.scans[1];
const tapFields = (): ScanMessageV2Fields => fieldsOf(tap.input, tap.bundleHashHex);
const checkFields = (): ScanMessageV2Fields => fieldsOf(v2.scans[2].input, v2.scans[2].bundleHashHex);
function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof ScanFieldError ? e.code : `other: ${(e as Error).message}`; }
  return "accepted";
}

test("§5 worked example, hard-coded (tap-visitor-sighting)", () => {
  assert.equal(v2.programIdHex, "626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29");
  assert.equal(bytesToHex(programId), v2.programIdHex);
  const bundle = bundleOf(tap.input);
  assert.equal(canonicalBundleV2(bundle), '{"actor":{"id":null,"kind":"NONE"},"attester":{"role":0,"siteId":0,"tier":0},"cluster":"DEVNET","counter":2,"fill":null,"heatLevels":[0,0,0,0,0,0],"indicators":{"heat":3,"humidity":3,"uv":3},"location":{"country":null},"media":[],"programId":"7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL","purpose":"TAP","schema":"flaconvault.scanbundle.v2","seal":{"kind":"NECK","uidHash":"0x8150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f442"},"serial":"SN-2026-000001","serialHash":"0x4c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb583","server":{"keyId":1,"ts":1790000200,"verdict":"VALID"},"session":{"issuedAt":1790000200,"nonce":"0x7901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9"},"tamper":3,"visual":{"loopIntact":null}}');
  const bh = bundleHashV2(bundle);
  assert.equal(bytesToHex(bh), "f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c5");
  const msg = buildScanMessageV2({ ...tapFields(), bundleHash: bh });
  assert.equal(bytesToHex(msg), "46565343414e32626c6d108266127300de7b13f3dbb9551b761a97a587429b497e2d909a461b29024c998d75c9a8c68768696a2e66ffc2f5a9ffca930654a86195d9ac73656bb5838150ba8e6d5dec4909903ddb831e4d8a7542928539b6d007da5e01ed9643f4420200000000000303030300ff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f71dc464e4cdfbf05594b2180103407d32180a5b14c122b58b36ed153d8892c57901d90ad597c5f8487066b825a50787de157139840a90588212209db0c9b5a9483cb16a00000000");
  assert.equal(sha256Hex(msg), "57bfd9ce941c81cc5366e6edf0d16527881074db75319eb5c72c47b1adef4bf4");
  assert.equal(bytesToHex(ed25519Sign(msg, seed)), "9cf4283eb2cf31048abbfd736186a3de9427f46aae760c9a8acc233225430b8d6d7822b905b2dce5d13c921770ae8ed63f2df2788ee2d4658e7c6e2d3d6e6c0f");
  const h1 = foldScanHead(SCAN_HEAD_ZERO, hexToBytes(v2.scans[0].msgHex));
  assert.equal(sha256Hex(hexToBytes(v2.scans[0].msgHex)), "d1d5cabfaa2495705fa2cfd6dbd467639830ce5004998feeb845e9857a1cafa0");
  assert.equal(bytesToHex(h1), "7d3c88a08935f19eb946f4f0efaa9c45da862bd5c052bb2fea3dcb74aeabbab7");
  assert.equal(bytesToHex(foldScanHead(h1, msg)), "6fcae69855734dc31f0eeef62edbe448fe3a0e2091b9c2208d55e6e5332565e7");
  assert.equal(bytesToHex(foldScanHeads(v2.scans.map((s: { msgHex: string }) => hexToBytes(s.msgHex)))),
    "1c074c9e97d083bf8daaf4137f61b4d642ef200a46d955a74e760e797cdac843");
  const passport = pdaPassport(serialHash("SN-2026-000001"), programId).address;
  assert.equal(base58Encode(passport), "5ewvSxUE88xsHkJvdx385KbjcJDs5FrArSptgnSnTwAT");
  assert.equal(bytesToHex(passport), "4527566c42a505d1b5fab981cff855a485020dc5abe34b365ace5fd57c225ffc");
  assert.equal(base58Encode(pdaHolding(passport, programId).address), "CXiCKHkkFjgRVW1oEA6Aq5AZ9RzkRKfhFYVLZzRLGSi7");
  assert.equal(base58Encode(pdaHolderConfig(programId).address), "D8ABpujMCjKUXuP8J2jsaiUb6JFEjSp21DZUJkrWn4cb");
  assert.equal(base58Encode(pdaSeal(uidHash("04A1B2C3D4E5F6"), programId).address), "Hnhdd1ppPTq1Ek22VhSErfz8urfLu9w43ANovzytCxCY");
  assert.equal(base58Encode(pdaEventAuthority(programId).address), "GKu94ojJCpbjg8EYt1wEXnuUJskCWna1CeLvuNUiFGXN");
  const secret0 = sha256Bytes(utf8("flaconvault:test-holder-secret:0"));
  assert.equal(bytesToHex(secret0), "9a529ee0b6ce1682b208fcb6554f1176705b04fb991134fbfe336c075bd7ce3f");
  assert.equal(bytesToHex(commitment(passport, 0, secret0)), "24088cd63896f3d8f4e55b031307f84429c5e16a039d5f6fa1e4a0e983649fe5");
  assert.equal(bytesToHex(commitment(passport, 1, sha256Bytes(utf8("flaconvault:test-holder-secret:1")))),
    "09b1c3a5ff50a1f70512c08f7159f65c510e4af74f4fa56b4959a9b0925411fd");
});

test("§2.2 discriminators", () => {
  const expected: Record<string, string> = {
    "global:record_scan_v2": "047bf48d93f81ff1", "global:init_holder_config": "d0bac1da36e4ea2b",
    "global:set_holder_config": "8d2acb3f37c81ab1", "global:init_holding_v1": "cd98809bc067bb03",
    "global:mint_passport_v2": "c628647296de125a", "global:attach_seal_v2": "3faca25aa6fd31e4",
    "account:HolderConfig": "79692a385ecd9930", "account:Holding": "176040faebbf0090", "event:ScanRecordedV2": "279d104913163f04",
  };
  assert.deepEqual(v2.discriminators, expected);
  for (const [k, hex] of Object.entries(expected)) {
    const [ns, name] = k.split(":") as ["global" | "account" | "event", string];
    assert.equal(bytesToHex(anchorDiscriminator(ns, name)), hex, k);
  }
});

test("v2.scans reproduce: bundle, bundle hash, message, signature, Ed25519 data, head, grade chain", () => {
  assert.equal(v2.scans.length, 6);
  assert.equal(v2.cluster, ClusterName[v2.clusterTag]);
  let head = hexToBytes(v2.scanHead.initialHex);
  assert.deepEqual(head, SCAN_HEAD_ZERO);
  let pass: PassportGrade = { grade: Grade.A, void: false };
  for (const s of v2.scans) {
    const bundle = bundleOf(s.input);
    assert.equal(canonicalBundleV2(bundle), s.bundleCanonical, `${s.name}: canonical bundle`);
    assert.equal(bytesToHex(bundleHashV2(bundle)), s.bundleHashHex, `${s.name}: bundle hash`);
    assert.equal(sha256Hex(utf8(s.bundleCanonical)), s.bundleHashHex, `${s.name}: bundle hash = sha256(canonical)`);
    assert.equal(heatLevelsToMask(s.input.heatLevels), s.heatMask, `${s.name}: heat mask`);
    const msg = buildScanMessageV2(fieldsOf(s.input, s.bundleHashHex));
    assert.equal(bytesToHex(msg), s.msgHex, `${s.name}: message`);
    assert.equal(sha256Hex(msg), s.msgSha256Hex, `${s.name}: sha256(msg)`);
    assert.equal(bytesToHex(ed25519Sign(msg, seed)), s.sigHex, `${s.name}: signature`);
    assert.ok(ed25519Verify(hexToBytes(s.sigHex), msg, serverPub), `${s.name}: signature verifies`);
    assert.equal(bytesToHex(buildEd25519InstructionData(serverPub, hexToBytes(s.sigHex), msg)), s.ed25519IxHex, `${s.name}: Ed25519 data`);
    assert.ok(bundleMatchesMessageV2(ScanBundleV2Schema.parse(JSON.parse(s.bundleCanonical)), msg), `${s.name}: bundle = message`);
    head = foldScanHead(head, msg);
    assert.equal(bytesToHex(head), s.headAfterHex, `${s.name}: head`);
    assert.equal(actorChangesGrade(s.input.actorKind), s.affectsGrade, `${s.name}: affectsGrade`);
    if (s.affectsGrade) pass = passportAfterScanV2(pass, s.input);
    assert.deepEqual([pass.grade, pass.void], [s.gradeAfter, s.voidAfter], `${s.name}: grade after`);
  }
  assert.deepEqual(v2.scans.map((s: { gradeAfter: number }) => s.gradeAfter), [Grade.A, Grade.A, Grade.A, Grade.B, Grade.B, Grade.C]);
  assert.equal(v2.scanHead.count, v2.scans.length);
  assert.equal(bytesToHex(head), v2.scanHead.finalHex);
});

test("v2 actors, commitments and PDAs reproduce", () => {
  for (const a of Object.values(v2.actors) as { seedLabel: string; pubkey: string; pubkeyHex: string }[]) {
    const pub = ed25519PublicKey(sha256Bytes(utf8(a.seedLabel)));
    assert.equal(bytesToHex(pub), a.pubkeyHex);
    assert.equal(base58Encode(pub), a.pubkey);
  }
  assert.deepEqual(v2.commitments.map((c: { epoch: number }) => c.epoch), [0, 1]);
  for (const c of v2.commitments) {
    assert.equal(base58Encode(hexToBytes(c.passportHex)), c.passport);
    assert.equal(bytesToHex(sha256Bytes(utf8(c.secretLabel))), c.secretHex);
    assert.equal(bytesToHex(commitment(hexToBytes(c.passportHex), c.epoch, hexToBytes(c.secretHex))), c.commitmentHex);
  }
  assert.equal(v2.scans[3].input.actorHex, v2.commitments[0].commitmentHex, "HOLDER = epoch-0 commitment");
  assert.equal(v2.scans[4].input.actorHex, v2.commitments[1].commitmentHex, "RECIPIENT = epoch-1 commitment");
  const passport = hexToBytes(v2.commitments[0].passportHex);
  assert.deepEqual(v2.pdas, {
    registry: base58Encode(pdaRegistry(programId).address), passport: base58Encode(passport),
    seal: base58Encode(pdaSeal(uidHash(tap.input.uidHex), programId).address),
    holderConfig: base58Encode(pdaHolderConfig(programId).address), holding: base58Encode(pdaHolding(passport, programId).address),
    eventAuthority: base58Encode(pdaEventAuthority(programId).address),
  });
  for (const k of Object.values(v2.pdas) as string[]) assert.ok(!isOnCurve(base58Decode(k)), `${k} is off the curve`);
});

test("message layout: 256 bytes, offsets, round trip", () => {
  const f = { ...checkFields(), siteId: 0, counter: 0x00abcdef, ts: 4102444800 };
  const msg = buildScanMessageV2(f);
  assert.equal(msg.length, MSG2_LEN);
  assert.equal(new TextDecoder().decode(msg.slice(0, 7)), "FVSCAN2");
  assert.deepEqual(Array.from(msg.slice(MSG2_OFFSETS.counter, MSG2_OFFSETS.counter + 4)), [0xef, 0xcd, 0xab, 0x00]);
  assert.equal(msg[MSG2_OFFSETS.clusterTag], Cluster.DEVNET);
  assert.equal(msg[MSG2_OFFSETS.fill], 92);
  assert.equal(MSG2_OFFSETS.ts + 8, MSG2_LEN);
  assert.equal(MSG2_OFFSETS.programId, "FVSCAN2".length);
  const p = parseScanMessageV2(msg);
  assert.equal(p.ts, 4102444800n);
  assert.deepEqual(buildScanMessageV2({ ...p }), msg);
  const sited = buildScanMessageV2({ ...fieldsOf(v2.scans[0].input, v2.scans[0].bundleHashHex), siteId: 0x0102 });
  assert.deepEqual(Array.from(sited.slice(MSG2_OFFSETS.siteId, MSG2_OFFSETS.siteId + 2)), [0x02, 0x01]);
  assert.throws(() => parseScanMessageV2(msg.slice(0, 255)), /length/);
  const v1 = buildScanMessage({ serialHash: ZERO32, uidHash: ZERO32, counter: 1, tamper: 3, uv: 3, hum: 0, heat: 0, fill: 50, mediaHash: ZERO32, nonce: ZERO32, ts: 1 });
  const padded = new Uint8Array(MSG2_LEN); padded.set(v1);
  assert.throws(() => parseScanMessageV2(padded), /prefix/, "FVSCAN1 padded to 256 bytes is not FVSCAN2");
});

test("v2.rejects: each patched message breaks exactly the named rule", () => {
  assert.ok(v2.rejects.length >= 15);
  for (const r of v2.rejects) {
    assert.equal(r.base, v2.scans[2].name);
    const parsed = parseScanMessageV2(hexToBytes(r.msgHex));
    assert.equal(codeOf(() => checkScanFieldsV2(parsed)), r.error, r.name);
    assert.equal(codeOf(() => buildScanMessageV2(parsed)), r.error, `${r.name}: builder`);
  }
  assert.deepEqual(new Set(v2.rejects.map((r: { error: string }) => r.error)), new Set([
    "InvalidRole", "InvalidTier", "InvalidPurpose", "InvalidActorKind", "InvalidIndicator", "InvalidFill", "InvalidHeatLevels",
    "HeatInconsistent", "InvalidSighting", "TierNotAllowedForRole", "NotPartner", "SiteIdNotAllowed", "PurposeNotAllowed",
  ]));
});

test("builders reject the remaining §3.4 violations", () => {
  const c = checkFields(), t = tapFields();
  assert.equal(codeOf(() => buildScanMessageV2({ ...c, clusterTag: 0 })), "InvalidClusterTag");
  assert.equal(codeOf(() => buildScanMessageV2({ ...c, clusterTag: 4 })), "InvalidClusterTag");
  assert.equal(codeOf(() => buildScanMessageV2({ ...c, counter: 0x01000000 })), "CounterOutOfRange");
  for (const k of ["uv", "hum", "heat"] as const) {
    assert.equal(codeOf(() => buildScanMessageV2({ ...t, [k]: Indicator.INTACT })), "InvalidSighting", `sighting ${k}`);
  }
  assert.equal(codeOf(() => buildScanMessageV2({ ...t, heatLevels: 1 })), "InvalidSighting");
  assert.equal(codeOf(() => buildScanMessageV2({ ...t, purpose: Purpose.CLAIM, actorKind: ActorKind.HOLDER, actor: sha256Bytes(utf8("c")) })), "accepted", "a sighting may be a CLAIM");
  assert.equal(codeOf(() => buildScanMessageV2({ ...t, purpose: Purpose.CHECK })), "PurposeNotAllowed", "a sighting is no CHECK");
  // rule 7 (program step 4)
  assert.equal(codeOf(() => buildScanMessageV2({ ...c, actor: sha256Bytes(utf8("x")) })), "ActorMismatch", "NONE needs actor 0");
  assert.equal(codeOf(() => buildScanMessageV2({ ...c, purpose: Purpose.RECEIPT, actorKind: ActorKind.RECIPIENT })), "ActorMismatch", "RECIPIENT needs actor ≠ 0");
  // BIRTH needs PARTNER and tier BIRTH; the registry site check runs when sites are given
  const birth = fieldsOf(v2.scans[0].input, v2.scans[0].bundleHashHex);
  assert.equal(codeOf(() => buildScanMessageV2({ ...birth, tier: Tier.CERTIFIED })), "PurposeNotAllowed");
  assert.equal(codeOf(() => buildScanMessageV2(birth, { knownSites: [1] })), "accepted");
  assert.equal(codeOf(() => buildScanMessageV2(birth, { knownSites: [2] })), "UnknownSite");
  assert.equal(codeOf(() => buildScanMessageV2({ ...birth, role: Role.VAULT, tier: Tier.CERTIFIED, purpose: Purpose.CHECK })), "accepted");
  // heat UNREADABLE/MISSING carry no claim about bit 4
  assert.equal(codeOf(() => buildScanMessageV2({ ...c, heat: Indicator.UNREADABLE, heatLevels: 0b010000 })), "accepted");
  // byte widths and types
  assert.throws(() => buildScanMessageV2({ ...c, nonce: new Uint8Array(31) }), /32 bytes/);
  assert.throws(() => buildScanMessageV2({ ...c, siteId: 0x10000 }), /u16/);
  assert.throws(() => buildScanMessageV2({ ...c, fill: 1.5 }), /u8/);
});

test("Ed25519 instruction data (§3.6)", () => {
  const msg = hexToBytes(tap.msgHex), sig = hexToBytes(tap.sigHex);
  const data = buildEd25519InstructionData(serverPub, sig, msg);
  assert.equal(data.length, 368);
  assert.equal(bytesToHex(data.slice(0, 16)), "01003000ffff1000ffff70000001ffff");
  const p = parseEd25519InstructionData(data);
  assert.deepEqual([p.pubkey, p.signature, p.message], [serverPub, sig, msg]);
  assert.throws(() => parseEd25519InstructionData(data, { messageLen: 152 }), /256 bytes, expected 152/);
  const v1 = buildEd25519InstructionData(serverPub, sig, hexToBytes(vectors.scans[0].msgHex));
  assert.equal(v1.length, 264);
  assert.throws(() => parseEd25519InstructionData(v1), /152 bytes, expected 256/);
  assert.deepEqual(parseEd25519InstructionData(v1, { messageLen: 152 }).message, hexToBytes(vectors.scans[0].msgHex));
  // instruction indices: 0xFFFF or the Ed25519 instruction's own index, nothing else
  const at3 = data.slice(); at3[14] = 3; at3[15] = 0;
  assert.throws(() => parseEd25519InstructionData(at3), /another instruction/);
  assert.deepEqual(parseEd25519InstructionData(at3, { ownIndex: 3 }).message, msg);
  assert.throws(() => parseEd25519InstructionData(at3, { ownIndex: 2 }), /another instruction/);
  const two = data.slice(); two[0] = 2;
  assert.throws(() => parseEd25519InstructionData(two), /one signature/);
  assert.throws(() => parseEd25519InstructionData(data.slice(0, 300)), /out of bounds/);
  assert.throws(() => parseEd25519InstructionData(data.slice(0, 10)), /header/);
});

test("bundle v2: strict keys and the message correspondences", () => {
  const s = v2.scans[2];
  const b = ScanBundleV2Schema.parse(JSON.parse(s.bundleCanonical));
  const msg = hexToBytes(s.msgHex);
  // strict: none of the v1-only / private fields, no extra keys anywhere
  for (const extra of [{ note: "" }, { ts: 1 }, { logger: null }, { device: { platform: "IOS_WEB" } }]) {
    assert.throws(() => ScanBundleV2Schema.parse({ ...b, ...extra }), JSON.stringify(extra));
  }
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, location: { country: "DE", city: "Wickede" } }));
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, attester: { ...b.attester, pubkey: "x" } }));
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, server: { ...b.server, sig: "0x00" } }));
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, media: [{ type: "SEAL_FRAMES", sha256: b.media[0].sha256, ar: null }] }));
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, location: { country: "de" } }));
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, serial: "SN-2026-000002" }), /sha256\(serial\)/);
  // actor.id is null if and only if NONE
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, actor: { kind: "NONE", id: "0x" + "11".repeat(32) } }), /actor.id/);
  assert.throws(() => ScanBundleV2Schema.parse({ ...b, actor: { kind: "HOLDER", id: null } }), /actor.id/);
  // fill null ⇔ 255, media [] ⇔ zero hash
  assert.equal(JSON.parse(tap.bundleCanonical).fill, null);
  assert.deepEqual(JSON.parse(tap.bundleCanonical).media, []);
  assert.equal(b.fill, 92);
  assert.equal(b.media[0].sha256, "0x" + s.input.mediaHashHex);
  assert.deepEqual(bundleV2Mismatches(b, msg), []);
  const changed: [string, ScanBundleV2][] = [
    ["counter", { ...b, counter: 4 }],
    ["fill", { ...b, fill: 91 }],
    ["purpose", { ...b, purpose: "TAP" }],
    ["indicators", { ...b, indicators: { ...b.indicators, heat: 1 } }],
    ["heatLevels", { ...b, heatLevels: [1, 0, 0, 0, 0, 0] }],
    ["media", { ...b, media: [] }],
    ["session.nonce", { ...b, session: { ...b.session, nonce: "0x" + "22".repeat(32) } }],
    ["cluster", { ...b, cluster: "MAINNET" }],
    ["server.ts", { ...b, server: { ...b.server, ts: b.server.ts + 1 } }],
  ];
  for (const [field, bad] of changed) {
    const m = bundleV2Mismatches(bad, msg);
    assert.ok(m.includes(field) && m.includes("bundleHash"), `${field}: ${m.join(",")}`);
    assert.ok(!bundleMatchesMessageV2(bad, msg));
  }
  // a detail only the bundle has still changes the hash, so the signed message no longer matches
  assert.deepEqual(bundleV2Mismatches({ ...b, location: { country: "FR" } }, msg), ["bundleHash"]);
});

test("v2 grade rule (§7.7) incl. FILL_NONE", () => {
  const A = { grade: Grade.A, void: false }, B = { grade: Grade.B, void: false }, D = { grade: Grade.D, void: false };
  const C = { grade: Grade.C, void: false }, V = { grade: Grade.VOID, void: true };
  const none = { tamper: Tamper.UNKNOWN, heat: Indicator.MISSING, hum: Indicator.MISSING, fill: FILL_NONE };
  for (const g of [A, B, D, C]) assert.deepEqual(passportAfterScanV2(g, none), g, `no reading keeps ${g.grade}`);
  assert.deepEqual(passportAfterScanV2({ grade: Grade.VOID, void: false }, none), V);
  assert.deepEqual(passportAfterScanV2({ ...A, void: true }, none), V);
  assert.deepEqual(passportAfterScanV2(B, { ...none, tamper: Tamper.OPENED_NOW }), V);
  assert.deepEqual(passportAfterScanV2(B, { ...none, heat: Indicator.TRIGGERED }), C);
  assert.deepEqual(passportAfterScanV2(D, { ...none, hum: Indicator.TRIGGERED }), C);
  // with a reading, v2 = v1
  for (const old of [A, B, C, D, V]) {
    for (const fill of [0, 59, 60, 89, 90, 100]) {
      for (const [tamper, heat, hum] of [[3, 0, 0], [3, 1, 0], [3, 0, 1], [1, 0, 0], [2, 0, 0], [0, 2, 3]]) {
        const f = { tamper, heat, hum, fill };
        assert.deepEqual(passportAfterScanV2(old, f), passportAfterScan(old, f));
      }
    }
  }
  assert.deepEqual(passportAfterScan(A, { tamper: 3, heat: 3, hum: 3, fill: 0 }), D, "v1: a low reading lowers A to D");
  assert.deepEqual(passportAfterScan(D, { tamper: 3, heat: 0, hum: 0, fill: 95 }), A, "v1: the next scan corrects it");
  assert.deepEqual([0, 1, 2, 3, 4].map(actorChangesGrade), [false, true, true, true, false]);
});

test("base58 and cluster names", () => {
  for (const hex of ["", "00", "0000ff", "00010203", "ff".repeat(32), "00".repeat(32)]) {
    const b = hexToBytes(hex);
    assert.deepEqual(base58Decode(base58Encode(b)), b, hex);
  }
  assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(base58Encode(base58Decode("Ed25519SigVerify111111111111111111111111111")), "Ed25519SigVerify111111111111111111111111111");
  assert.throws(() => base58Decode("0OIl"), /base58/);
  assert.equal(clusterTag("devnet"), Cluster.DEVNET);
  assert.equal(clusterTag("MAINNET"), Cluster.MAINNET);
  assert.equal(clusterTag("localnet"), Cluster.LOCALNET);
  assert.throws(() => clusterTag("testnet"), /unknown cluster/);
  assert.throws(() => clusterTag("toString"), /unknown cluster/);
});
