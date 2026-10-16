import { test } from "node:test";
import assert from "node:assert/strict";
import type { CardReading } from "@flaconvault/vision";
import { combineReadings, frameCounts, majority } from "./vote";

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
  const r = combineReadings([triggered(), triggered(), highlight, triggered(), triggered()])!;
  assert.equal(r.heat, TRIGGERED);
  assert.deepEqual(r.heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.equal(r.heatLevels[4], 1, "decisive field equals the heat indicator");
});

test("without 3 of 5 agreeing frames the indicator is UNREADABLE and no field is sent", () => {
  const r = combineReadings([triggered(), triggered(), frame(), frame(), frame({ found: false, reason: "no card" })], 5)!;
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
  const r = combineReadings([triggered(), triggered(), frame({ label: false }), frame({ label: false }), frame({ label: false })], 5)!;
  assert.equal(r.heat, UNREADABLE);
});

test("no voting frame at all: a not-found reading with a reason", () => {
  const nf = combineReadings([frame({ found: false, reason: "Card outline not found" }), frame({ found: false, reason: "x" })])!;
  assert.equal(nf.found, false);
  assert.equal(nf.reason, "Card outline not found");
  const nolabel = combineReadings([frame({ label: false }), frame({ label: false })])!;
  assert.equal(nolabel.found, false);
  assert.match(nolabel.reason ?? "", /heat label/);
  assert.equal(combineReadings([]), null);
});

test("per-field levels are the majority of the frames that agree on heat", () => {
  const a = frame({ heat: INTACT, heatLevels: [1, 0, 0, 0, 0, 0] });
  const b = frame({ heat: INTACT, heatLevels: [1, 1, 0, 0, 0, 0] });
  const r = combineReadings([a, a, b, frame({ heat: INTACT, heatLevels: [0, 0, 0, 0, 0, 0] }), a])!;
  assert.equal(r.heat, INTACT);
  assert.deepEqual(r.heatLevels, [1, 0, 0, 0, 0, 0]);
});

test("a split vote says why and how many frames agreed", () => {
  const r = combineReadings([triggered(), triggered(), frame(), frame(), frame({ found: false, reason: "no card" })], 5)!;
  assert.match(r.reason ?? "", /Frames disagree on heat/);
  assert.deepEqual(r.votes, { frames: 5, found: 4, heat: 0, humidity: 4, uv: 4 });
  const ok = combineReadings([frame(), frame(), frame(), frame(), frame()])!;
  assert.equal(ok.reason, undefined);
  assert.equal(ok.votes?.heat, 5);
});
