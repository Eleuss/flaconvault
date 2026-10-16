import { test } from "node:test";
import assert from "node:assert/strict";
import { Indicator } from "@flaconvault/proof";
import { combineReadings, notFoundReading, type CardReading } from "./index.ts";

const { INTACT: I, TRIGGERED: T, UNREADABLE: U, MISSING: M } = Indicator;
const LEVELS: Record<number, number[]> = { [I]: [1, 1, 1, 0, 0, 0], [T]: [1, 1, 1, 1, 1, 0] };

/** A found frame-mode reading with the given verdicts (heat levels as readCard reports them). */
function reading(heat: number, humidity: number = I, uv: number = I, o: Partial<CardReading> = {}): CardReading {
  return {
    found: true, heat, humidity, uv,
    heatLevels: LEVELS[heat] ?? [0, 0, 0, 0, 0, 0], heatFields: [], humidityField: null, uvField: null,
    confidence: { heat: heat === U ? 0.3 : 0.99, humidity: humidity === U ? 0.3 : 0.99 },
    quality: { markerPx: 400, qrUsed: false, anchors: ["heat-label"], mode: "frame", groups: { heat: { greyL: 30, whiteL: 95, ok: true }, hum: { greyL: 30, whiteL: 95, ok: true } } },
    homography: null, warped: null, ms: 10,
    ...o,
  };
}
const verdicts = (r: CardReading) => [r.heat, r.humidity, r.uv];

test("combineReadings: unanimous frames → the same verdicts and heat levels", () => {
  const r = combineReadings([reading(I), reading(I), reading(I)]);
  assert.equal(r.found, true);
  assert.deepEqual(verdicts(r), [I, I, I]);
  assert.deepEqual(r.heatLevels, [1, 1, 1, 0, 0, 0]);
  assert.deepEqual(r.votes, { frames: 3, found: 3, heat: 3, humidity: 3, uv: 3 });
  assert.equal(r.ms, 30);
  assert.equal(r.reason, undefined);
  assert.ok(r.confidence.heat > 0.98);
});

test("combineReadings: majority per indicator, independently", () => {
  const r = combineReadings([reading(T, I, I), reading(T, T, I), reading(T, I, U), reading(I, I, I), reading(T, T, I)]);
  assert.deepEqual(verdicts(r), [T, I, I]);
  assert.deepEqual(r.heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.deepEqual(r.votes, { frames: 5, found: 5, heat: 4, humidity: 3, uv: 4 });
  assert.ok(Math.abs(r.confidence.heat - 0.8 * 0.99) < 1e-9, String(r.confidence.heat));
});

test("combineReadings: a tie is UNREADABLE, and so is a plurality without a majority", () => {
  const tie = combineReadings([reading(I), reading(T), reading(I), reading(T)]);
  assert.equal(tie.heat, U);
  assert.deepEqual(tie.heatLevels, [0, 0, 0, 0, 0, 0], "no heat levels without a decided verdict");
  assert.match(tie.reason ?? "", /Frames disagree on heat/);
  assert.equal(tie.humidity, I, "humidity agrees, so it stays decided");
  const split = combineReadings([reading(I), reading(I), reading(T), reading(U)]);
  assert.equal(split.heat, U, "2 of 4 is not a majority");
  assert.equal(combineReadings([reading(I), reading(T)]).heat, U);
});

test("combineReadings: frames that are mostly UNREADABLE stay UNREADABLE", () => {
  const r = combineReadings([reading(U, U, U), reading(U, U, U), reading(I), reading(U, U, U), reading(I)]);
  assert.deepEqual(verdicts(r), [U, U, U]);
  assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.equal(r.reason, undefined, "UNREADABLE by majority is not a disagreement");
});

test("combineReadings: frames without a card do not vote", () => {
  const miss = notFoundReading("Card not detected", 5);
  const r = combineReadings([miss, reading(T), miss, reading(T), reading(I)]);
  assert.equal(r.heat, T);
  assert.deepEqual(r.votes, { frames: 5, found: 3, heat: 2, humidity: 3, uv: 3 });
  assert.equal(r.ms, 40);
  const single = combineReadings([miss, reading(I)]);
  assert.equal(single.heat, I, "one found frame decides alone");
});

test("combineReadings: no frame with a card → the first not-found reading; no frames → not found", () => {
  const a = notFoundReading("Card not detected (no card window in frame)", 7), b = notFoundReading("other", 3);
  const r = combineReadings([a, b]);
  assert.equal(r.found, false);
  assert.equal(r.reason, a.reason);
  assert.deepEqual(verdicts(r), [M, M, M]);
  assert.equal(r.ms, 10);
  const none = combineReadings([]);
  assert.equal(none.found, false);
  assert.deepEqual(verdicts(none), [M, M, M]);
  assert.deepEqual(none.heatLevels, [0, 0, 0, 0, 0, 0]);
});

test("combineReadings: heat levels are a per-field majority over the agreeing frames; the decisive field equals heat", () => {
  const r = combineReadings([
    reading(I, I, I, { heatLevels: [1, 1, 1, 0, 0, 0] }),
    reading(I, I, I, { heatLevels: [1, 1, 0, 0, 0, 0] }),
    reading(I, I, I, { heatLevels: [1, 1, 0, 0, 0, 0] }),
    reading(T, I, I, { heatLevels: [1, 1, 1, 1, 1, 1] }), // disagrees on heat: its levels do not count
  ]);
  assert.equal(r.heat, I);
  assert.deepEqual(r.heatLevels, [1, 1, 0, 0, 0, 0]);
  assert.equal(r.heatLevels[4], r.heat);
});

test("combineReadings: the representative frame agrees with the combined verdicts", () => {
  const odd = reading(T, T, T, { confidence: { heat: 1, humidity: 1 }, homography: [9, 9, 9, 9, 9, 9, 9, 9, 9] });
  const good = reading(I, I, I, { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const r = combineReadings([odd, good, reading(I), reading(I)]);
  assert.deepEqual(verdicts(r), [I, I, I]);
  assert.deepEqual(r.homography, good.homography, "not the most confident frame, but one that agrees");
});

test("combineReadings: marker-mode readings (UV MISSING everywhere) keep UV MISSING", () => {
  const r = combineReadings([reading(I, I, M), reading(I, I, M), reading(T, I, M)]);
  assert.deepEqual(verdicts(r), [I, I, M]);
});
