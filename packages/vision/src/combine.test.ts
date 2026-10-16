import { test } from "node:test";
import assert from "node:assert/strict";
import { Indicator } from "@flaconvault/proof";
import { combineReadings, frameCounts, majority, notFoundReading, type CardReading } from "./index.ts";

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

test("combineReadings: frames without a card do not vote, but the quorum is a majority of ALL frames", () => {
  const miss = notFoundReading("Card not detected", 5);
  const r = combineReadings([miss, reading(T), miss, reading(T), reading(I)]);
  assert.equal(r.heat, U, "2 of 5 is not a majority, although 2 of the 3 found frames agree");
  assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.equal(r.confidence.heat, 0);
  assert.deepEqual([r.humidity, r.uv], [I, I], "3 of 5 agree");
  assert.deepEqual(r.votes, { frames: 5, found: 3, heat: 0, humidity: 3, uv: 3 });
  assert.match(r.reason ?? "", /Frames disagree on heat \(3 of 5 frames counted\)/);
  assert.equal(r.ms, 40);
  assert.equal(combineReadings([miss, reading(T), miss, reading(T), reading(T)]).heat, T, "3 of 5 decide");
});

test("combineReadings: one found frame never decides alone", () => {
  const miss = notFoundReading("Card not detected", 5);
  const g = reading(I); // e.g. a highlight frame of a triggered card
  const r = combineReadings([miss, miss, miss, miss, g]);
  assert.equal(r.found, true);
  assert.deepEqual(verdicts(r), [U, U, U]);
  assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(r.confidence, { heat: 0, humidity: 0 });
  assert.deepEqual(r.votes, { frames: 5, found: 1, heat: 0, humidity: 0, uv: 0 });
  assert.match(r.reason ?? "", /Only 1 of 5 frames could be read/);
  assert.equal(combineReadings([miss, g]).heat, U, "1 of 2");
  assert.equal(combineReadings([g]).heat, I, "a single captured frame is its own majority");
});

test("combineReadings: `total` counts frames that were captured but not passed in", () => {
  assert.equal(combineReadings([reading(T), reading(T), reading(T)], 5).heat, T);
  assert.equal(combineReadings([reading(T), reading(T)], 5).heat, U);
  assert.equal(combineReadings([reading(T), reading(T)], 5).votes?.frames, 5);
  assert.equal(combineReadings([reading(T), reading(T), reading(T)], 1).votes?.frames, 3, "never fewer than the readings given");
});

test("combineReadings: frame-mode frames without the heat label abstain (they still count towards the quorum)", () => {
  const noLabel = reading(U, U, U, { quality: { ...reading(I).quality, anchors: [] } });
  assert.equal(frameCounts(noLabel), false);
  assert.equal(frameCounts(reading(I)), true);
  assert.equal(frameCounts(notFoundReading("x")), false);
  assert.equal(frameCounts(reading(I, I, M, { quality: { ...reading(I).quality, anchors: [], mode: "marker" } })), true, "marker mode has no heat-label anchor");
  const r = combineReadings([reading(T), reading(T), noLabel, noLabel, noLabel]);
  assert.equal(r.heat, U);
  assert.equal(r.votes?.found, 2);
  assert.equal(combineReadings([reading(T), reading(T), noLabel, reading(T), noLabel]).heat, T);
  // no voter at all: a not-found reading that says why
  const none = combineReadings([noLabel, notFoundReading("Card not detected", 2), noLabel]);
  assert.equal(none.found, false);
  assert.deepEqual(verdicts(none), [M, M, M]);
  assert.deepEqual(none.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.match(none.reason ?? "", /heat label was not recognized in any frame/);
  assert.equal(none.ms, 22);
});

test("combineReadings: a single highlight frame cannot outvote four triggered frames", () => {
  const highlight = reading(I, I, I, { confidence: { heat: 1, humidity: 1 } });
  const r = combineReadings([reading(T), reading(T), highlight, reading(T), reading(T)]);
  assert.equal(r.heat, T);
  assert.deepEqual(r.heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.equal(r.reason, undefined);
});

test("combineReadings: an indicator no frame read stays MISSING even below the quorum", () => {
  const miss = notFoundReading("Card not detected");
  const r = combineReadings([reading(I, I, M), reading(I, I, M), miss, miss, miss]);
  assert.deepEqual(verdicts(r), [U, U, M], "Light: not fitted, never 'unreadable, inspection recommended'");
  assert.match(r.reason ?? "", /Only 2 of 5 frames/);
  assert.equal(majority([M, M], 3), M);
  assert.equal(majority([I, M], 3), U, "a split between a reading and MISSING is decided by the quorum");
  assert.equal(majority([], 3), U);
  assert.equal(majority([T, T, T, I, I], 3), T);
  assert.equal(majority([T, T, I, I, U], 3), U);
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
  // a tie on a field gives 0; the decisive field always equals the verdict
  const tie = combineReadings([
    reading(T, I, I, { heatLevels: [1, 1, 1, 1, 1, 1] }), reading(T, I, I, { heatLevels: [1, 1, 1, 1, 1, 0] }),
    reading(T, I, I, { heatLevels: [1, 1, 1, 1, 1, 1] }), reading(T, I, I, { heatLevels: [1, 1, 1, 1, 1, 0] }),
  ]);
  assert.deepEqual(tie.heatLevels, [1, 1, 1, 1, 1, 0]);
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
