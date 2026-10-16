import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType, Grade } from "@flaconvault/proof";
import type { PassportEvent } from "./api";
import { MAX_REPORTS_SHOWN, PASSPORT_DISCRIMINATOR, decodePassportAccount, effectiveVerdict, eventLine, liveCheckVerdict, passportHref, visibleEvents } from "./format";

const ev = (o: Partial<PassportEvent>): PassportEvent => ({
  id: 1, type: EventType.SCAN, ts: 1000, actor: null, actorLabel: null, txSig: null, status: "confirmed", sealUidHash: null,
  payload: {}, arBundle: null, arMedia: null, gradeAfter: null, location: null, ...o,
});

test("only a confirmed SEAL_DEAD reads as 'Passport VOID' (contract C4)", () => {
  assert.deepEqual(eventLine(ev({ type: EventType.SEAL_DEAD, status: "confirmed" })).details, ["Passport VOID"]);
  for (const status of ["reported", "pending"] as const) {
    const l = eventLine(ev({ type: EventType.SEAL_DEAD, status }));
    assert.ok(!l.details.some((d) => /VOID/i.test(d)), status);
    assert.ok(!/VOID/i.test(l.title), status);
  }
});

test("a VALID tap on a dead seal counts as not responding (contract C3)", () => {
  assert.equal(effectiveVerdict({ verdict: "VALID", sealDead: true }), "NO_RESPONSE");
  assert.equal(effectiveVerdict({ verdict: "VALID", sealDead: false }), "VALID");
  assert.equal(effectiveVerdict({ verdict: "VALID", sealDead: null }), "VALID");
  assert.equal(effectiveVerdict({ verdict: "REPLAY", sealDead: true }), "REPLAY");
});

test("passport links encode the serial", () => {
  assert.equal(passportHref("SN-2026-000001"), "/p/SN-2026-000001");
  assert.equal(passportHref("LOT#7 50%/a"), "/p/LOT%237%2050%25%2Fa");
});

test("timeline hides failed attempts and all but the newest unverified reports", () => {
  const reports = Array.from({ length: 10 }, (_, i) => ev({ id: 100 + i, ts: 2000 + i, type: EventType.SEAL_DEAD, status: "reported" }));
  const r = visibleEvents([ev({ id: 1 }), ev({ id: 2, status: "failed" }), ...reports]);
  assert.equal(r.failed, 1);
  assert.equal(r.reportsHidden, 10 - MAX_REPORTS_SHOWN);
  assert.deepEqual(r.shown.filter((e) => e.status === "reported").map((e) => e.id).sort(), [107, 108, 109]);
  assert.ok(r.shown.some((e) => e.id === 1));
});

function passportBytes(o: { grade: number; scanCount: number; sealCount: number; void: boolean }): Uint8Array {
  const b = new Uint8Array(8 + 128 + 1 + 4 + 1 + 1 + 8 + 1);
  b.set(PASSPORT_DISCRIMINATOR, 0);
  const dv = new DataView(b.buffer);
  let off = 8 + 128;
  dv.setUint8(off, o.grade); off += 1;
  dv.setUint32(off, o.scanCount, true); off += 4;
  dv.setUint8(off, o.sealCount); off += 1;
  dv.setUint8(off, o.void ? 1 : 0); off += 1;
  dv.setBigInt64(off, BigInt(1700000000), true);
  return b;
}

test("passport account decoding checks the discriminator", () => {
  assert.deepEqual(decodePassportAccount(passportBytes({ grade: 1, scanCount: 7, sealCount: 2, void: false })), { grade: 1, scanCount: 7, sealCount: 2, void: false, createdAt: 1700000000 });
  const wrong = passportBytes({ grade: 0, scanCount: 0, sealCount: 0, void: false }); wrong[0] ^= 1;
  assert.equal(decodePassportAccount(wrong), null);
  assert.equal(decodePassportAccount(new Uint8Array(0)), null);
});

test("live check compares scan_count with the server's anchored-scan count, not all scans (contract C2)", () => {
  const chain = { grade: Grade.A, scanCount: 13, sealCount: 1, void: false, createdAt: 0 };
  assert.equal(liveCheckVerdict(chain, { grade: Grade.A, onChainScanCount: 13 }).matches, true);
  const off = liveCheckVerdict(chain, { grade: Grade.A, onChainScanCount: 12 });
  assert.equal(off.matches, false);
  assert.match(off.text, /13 anchored scans on chain, 12 on the server/);
  // a void chain passport is VOID whatever its stored grade
  assert.equal(liveCheckVerdict({ ...chain, void: true }, { grade: Grade.VOID, onChainScanCount: 13 }).matches, true);
  assert.equal(liveCheckVerdict(chain, { grade: Grade.C, onChainScanCount: 13 }).matches, false);
  // an older verifier without the count: compare the grade only, and say so
  const g = liveCheckVerdict(chain, { grade: Grade.A });
  assert.equal(g.matches, true);
  assert.match(g.text, /grade/);
});

test("RELEASE says 'Passport → buyer' only when the Core asset moved (payload.passportTo)", () => {
  const plain = eventLine(ev({ type: EventType.RELEASE, payload: { priceUsdc: 480, currency: "USDC", to: "S" } }));
  assert.deepEqual(plain.details, ["480 USDC → seller"]);
  const moved = eventLine(ev({ type: EventType.RELEASE, payload: { priceUsdc: 480, currency: "USDC", to: "S", passportTo: "B" } }));
  assert.deepEqual(moved.details, ["480 USDC → seller", "Passport → buyer"]);
  const timeout = eventLine(ev({ type: EventType.RELEASE, payload: { priceUsdc: 1.5, to: "S", reason: "no receipt scan within the deadline" } }));
  assert.deepEqual(timeout.details, ["1.5 USDC → seller", "no receipt scan within the deadline"]);
});

test("verified scan tier wins over the claim; reserve shows the escrowed price", () => {
  const scan = eventLine(ev({ payload: { tier: 0, attester: { tier: 4, role: 4 }, indicators: {}, counter: 3 } }));
  assert.equal(scan.title, "Sighting");
  assert.deepEqual(eventLine(ev({ type: EventType.RESERVE, payload: { priceUsdc: 390, currency: "USDC" } })).details, ["390 USDC in escrow"]);
  assert.equal(eventLine(ev({ type: EventType.DISPUTE, payload: { reason: "not shipped within the deadline" } })).details[0], "not shipped within the deadline");
});
