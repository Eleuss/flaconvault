// The scan page signs the reading that @flaconvault/vision's combineReadings makes of the five captured frames (the
// web has no vote of its own any more). These cases pin what the scan page relies on: a majority of ALL captured
// frames, frames without a card or without the heat label abstain, no "most confident frame" pick, heatLevels only for
// a decided heat, an indicator nobody read stays MISSING, and a not-found result never carries indicator values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineReadings, frameCounts, majority, type CardReading } from "@flaconvault/vision";
import { verifyBody, type VerifyInput } from "@/lib/verify-api";

const INTACT = 0, TRIGGERED = 1, UNREADABLE = 2, MISSING = 3;
const frame = (o: Partial<CardReading> & { label?: boolean } = {}): CardReading => {
  const { label = true, ...rest } = o;
  return {
    found: true, heatLevels: [0, 0, 0, 0, 0, 0], heatFields: [], heat: INTACT, humidity: INTACT, humidityField: null, uv: MISSING,
    confidence: { heat: 1, humidity: 1 }, homography: null, warped: null, ms: 1,
    quality: { markerPx: 0, qrUsed: false, anchors: label ? ["heat-label"] : [], groups: { heat: { greyL: 0, whiteL: 0, ok: true }, hum: { greyL: 0, whiteL: 0, ok: true } }, mode: "frame" },
    ...rest,
  };
};
const triggered = () => frame({ heat: TRIGGERED, heatLevels: [1, 1, 1, 1, 1, 0] });

test("majority needs the quorum", () => {
  assert.equal(majority([1, 1, 1, 0, 0], 3), 1);
  assert.equal(majority([1, 1, 0, 0, 2], 3), UNREADABLE);
});

test("one confident highlight frame cannot outvote four triggered frames", () => {
  const highlight = frame({ heat: INTACT, confidence: { heat: 1, humidity: 1 } });
  const r = combineReadings([triggered(), triggered(), highlight, triggered(), triggered()]);
  assert.equal(r.heat, TRIGGERED);
  assert.deepEqual(r.heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.equal(r.heatLevels[4], 1, "decisive field equals the heat indicator");
});

test("without 3 of 5 agreeing frames the indicator is UNREADABLE and no field is sent", () => {
  const r = combineReadings([triggered(), triggered(), frame(), frame(), frame({ found: false, reason: "no card" })], 5);
  assert.equal(r.found, true);
  assert.equal(r.heat, UNREADABLE);
  assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.equal(r.humidity, INTACT, "humidity: 4 of 5 agree");
});

test("frames without the heat label (frame mode) or without a card do not vote", () => {
  assert.equal(frameCounts(frame({ label: false })), false);
  assert.equal(frameCounts(frame({ found: false })), false);
  assert.equal(frameCounts(frame({ label: false, quality: { ...frame().quality, anchors: [], mode: "marker" } })), true, "marker mode has no heat-label anchor");
  // two labelled triggered frames + three unlabelled: no majority of the five
  const r = combineReadings([triggered(), triggered(), frame({ label: false }), frame({ label: false }), frame({ label: false })], 5);
  assert.equal(r.heat, UNREADABLE);
});

test("no voting frame: a not-found reading with a reason and no indicator values", () => {
  const nf = combineReadings([frame({ found: false, reason: "Card outline not found" }), frame({ found: false, reason: "x" })]);
  assert.equal(nf.found, false);
  assert.equal(nf.reason, "Card outline not found");
  // a card was seen but never anchored on its heat label: not found, and its unanchored values are dropped
  const nolabel = combineReadings([frame({ label: false, heat: TRIGGERED, heatLevels: [1, 1, 1, 1, 1, 0] }), frame({ label: false })]);
  assert.equal(nolabel.found, false);
  assert.match(nolabel.reason ?? "", /heat label/);
  assert.deepEqual([nolabel.heat, nolabel.humidity, nolabel.uv], [MISSING, MISSING, MISSING]);
  assert.deepEqual(nolabel.heatLevels, [0, 0, 0, 0, 0, 0]);
  // no frames at all (the web's old vote returned null here): not found as well
  const none = combineReadings([], 5);
  assert.equal(none.found, false);
  assert.equal(none.votes?.found, 0);
});

test("the scan page signs MISSING for a not-found reading", () => {
  const nolabel = combineReadings([frame({ label: false, heat: TRIGGERED, heatLevels: [1, 1, 1, 1, 1, 0] })], 5);
  // scan-flow passes `reading.found ? reading : null` to verifyBody
  const input: VerifyInput = {
    tag: { uid: "04AABBCCDDEEFF", ctr: "00000A", cmac: "0011223344556677", source: "nfc" }, nonce: "0x" + "ab".repeat(32),
    role: 0, tier: 2, reading: nolabel.found ? nolabel : null, fill: 90, attester: null, platform: "ANDROID_WEB",
  };
  const b = verifyBody(input);
  assert.deepEqual(b.indicators, { heat: MISSING, humidity: MISSING, uv: MISSING });
  assert.deepEqual(b.heatLevels, [0, 0, 0, 0, 0, 0]);
});

test("per-field levels are the majority of the frames that agree on heat", () => {
  const a = frame({ heat: INTACT, heatLevels: [1, 0, 0, 0, 0, 0] });
  const b = frame({ heat: INTACT, heatLevels: [1, 1, 0, 0, 0, 0] });
  const r = combineReadings([a, a, b, frame({ heat: INTACT, heatLevels: [0, 0, 0, 0, 0, 0] }), a]);
  assert.equal(r.heat, INTACT);
  assert.deepEqual(r.heatLevels, [1, 0, 0, 0, 0, 0]);
});

test("a split vote says why and how many frames agreed", () => {
  const r = combineReadings([triggered(), triggered(), frame(), frame(), frame({ found: false, reason: "no card" })], 5);
  assert.match(r.reason ?? "", /Frames disagree on heat/);
  assert.deepEqual(r.votes, { frames: 5, found: 4, heat: 0, humidity: 4, uv: 4 });
  const ok = combineReadings([frame(), frame(), frame(), frame(), frame()]);
  assert.equal(ok.reason, undefined);
  assert.equal(ok.votes?.heat, 5);
});

test("an indicator no frame read stays MISSING even below the quorum (uv not fitted, S16)", () => {
  // two found frames + three not found: heat/humidity have no 3-of-5 majority, but uv was never read by anyone
  const nf = frame({ found: false, reason: "no card" });
  const r = combineReadings([frame(), frame(), nf, nf, nf], 5);
  assert.equal(r.heat, UNREADABLE);
  assert.equal(r.humidity, UNREADABLE);
  assert.equal(r.uv, MISSING, "Light: not fitted, never 'unreadable — review recommended'");
  assert.match(r.reason ?? "", /Only 2 of 5 frames/);
  assert.equal(majority([MISSING, MISSING], 3), MISSING);
  // a split between a reading and MISSING is still decided by the quorum
  assert.equal(majority([INTACT, MISSING], 3), UNREADABLE);
  assert.equal(majority([], 3), UNREADABLE);
});

test("a frame's own reason (e.g. glare) reaches the scan page when the frames agree on UNREADABLE", () => {
  const glare = () => frame({ heat: UNREADABLE, heatLevels: [0, 0, 0, 0, 0, 0], reason: "Glare on the heat strip: tilt the card away from the light" });
  const r = combineReadings([glare(), glare(), glare(), glare(), glare()]);
  assert.equal(r.heat, UNREADABLE);
  assert.match(r.reason ?? "", /Glare/);
});
