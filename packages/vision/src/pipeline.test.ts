import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Indicator } from "@flaconvault/proof";
import { readCard, renderCard, renderScene, tiltedQuad, type HeatFieldsConfig } from "./index.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../docs/heat_fields.json", import.meta.url), "utf8")) as HeatFieldsConfig;
const mod = await import("@techstark/opencv-js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cv: any = await ((mod as any).default ?? mod);

function scene(state: { heatLevels: number[]; humidityTriggered: boolean }, o: Partial<Parameters<typeof renderScene>[2]> & { cardPx?: number; tilt?: number; rot?: number } = {}) {
  const card = renderCard(cv, cfg, state);
  const width = o.width ?? 1280, height = o.height ?? 720;
  const frame = renderScene(cv, card, { width, height, quad: o.quad ?? tiltedQuad(width, height, o.cardPx ?? 820, o.tilt ?? 0, o.rot ?? 0), ...o });
  card.delete();
  return frame;
}

test("frontal, all intact → INTACT/INTACT with high confidence", () => {
  const r = readCard(cv, scene({ heatLevels: [0, 0, 0, 0, 0, 0], humidityTriggered: false }), cfg);
  assert.equal(r.found, true, r.reason);
  assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.equal(r.heat, Indicator.INTACT);
  assert.equal(r.humidity, Indicator.INTACT);
  assert.ok(r.confidence.heat > 0.99 && r.confidence.humidity > 0.99, JSON.stringify(r.confidence));
  assert.ok(r.quality.markerPx > 60);
  assert.equal(r.quality.qrUsed, true, "QR corners should be used");
  assert.ok(r.quality.anchors.includes("hum-dot"), r.quality.anchors.join(","));
});

test("40 °C field black → heat TRIGGERED, levels [1,1,1,1,1,0]", () => {
  const r = readCard(cv, scene({ heatLevels: [1, 1, 1, 1, 1, 0], humidityTriggered: false }), cfg);
  assert.equal(r.found, true, r.reason);
  assert.deepEqual(r.heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.equal(r.heat, Indicator.TRIGGERED);
  assert.equal(r.humidity, Indicator.INTACT);
});

test("only 29/33 °C black → heat INTACT (context fields do not decide)", () => {
  const r = readCard(cv, scene({ heatLevels: [1, 1, 0, 0, 0, 0], humidityTriggered: false }), cfg);
  assert.deepEqual(r.heatLevels, [1, 1, 0, 0, 0, 0]);
  assert.equal(r.heat, Indicator.INTACT);
});

test("humidity dot pink → humidity TRIGGERED", () => {
  const r = readCard(cv, scene({ heatLevels: [0, 0, 0, 0, 0, 0], humidityTriggered: true }), cfg);
  assert.equal(r.humidity, Indicator.TRIGGERED);
  assert.ok(r.confidence.humidity > 0.95);
});

test("10 of 10: tilt, rotation, warm/cool light, darker exposure, blur, noise", () => {
  const tints: Array<[number, number, number]> = [[1.06, 1.0, 0.82], [0.9, 0.97, 1.08], [1, 1, 1], [1.1, 1.02, 0.9], [0.95, 1.0, 1.0]];
  let ok = 0;
  const fails: string[] = [];
  for (let i = 0; i < 10; i++) {
    const state = { heatLevels: i % 2 ? [1, 1, 1, 1, 1, 0] : [1, 0, 0, 0, 0, 0], humidityTriggered: i % 3 === 0 };
    const r = readCard(cv, scene(state, {
      cardPx: 620 + i * 25, tilt: 0.04 + (i % 4) * 0.03, rot: -12 + i * 2.5,
      tint: tints[i % tints.length], brightness: -40 + (i % 5) * 12, blurSigma: 0.8 + (i % 3) * 0.4, noiseSigma: 4 + (i % 4) * 2, seed: 100 + i,
    }), cfg);
    const good = r.found && r.heat === state.heatLevels[4] && r.humidity === (state.humidityTriggered ? 1 : 0)
      && JSON.stringify(r.heatLevels) === JSON.stringify(state.heatLevels);
    if (good) ok++; else fails.push(`#${i}: ${r.reason ?? ""} heat=${r.heat} hum=${r.humidity} levels=${r.heatLevels} conf=${JSON.stringify(r.confidence)} qr=${r.quality.qrUsed} anchors=${r.quality.anchors}`);
  }
  assert.equal(ok, 10, fails.join("\n"));
});

test("no marker in the frame → not found, everything MISSING", () => {
  const r = readCard(cv, { data: new Uint8ClampedArray(640 * 480 * 4).fill(120), width: 640, height: 480 }, cfg);
  assert.equal(r.found, false);
  assert.equal(r.heat, Indicator.MISSING);
  assert.equal(r.humidity, Indicator.MISSING);
  assert.equal(r.uv, 3);
});

test("glare on the 40 °C field (white) → UNREADABLE, not a decision", () => {
  const card = renderCard(cv, cfg, { heatLevels: [0, 0, 0, 0, 0, 0], humidityTriggered: false });
  const S = cfg.px_per_mm, f = cfg.fields[4].roi_mm;
  // paint a mid tone (between grey #E9 and black #11) over the decisive field → ambiguous
  cv.rectangle(card, new cv.Point(Math.round((f.x - 1) * S), Math.round((f.y - 2) * S)), new cv.Point(Math.round((f.x + f.w + 1) * S), Math.round((f.y + f.h + 2) * S)), new cv.Scalar(128, 128, 128, 255), -1);
  const frame = renderScene(cv, card, { width: 1280, height: 720, quad: tiltedQuad(1280, 720, 820) });
  card.delete();
  const r = readCard(cv, frame, cfg);
  assert.equal(r.found, true);
  assert.equal(r.heat, Indicator.UNREADABLE, JSON.stringify({ c: r.confidence, f: r.heatFields[4] }));
});
