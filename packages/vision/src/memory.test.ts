// Own file (own process): the WASM heap starts fresh, so a leak has to grow it. OpenCV.js never returns memory, and a
// worker that leaks a few MB per read runs out on mobile Safari during a demo session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCard, renderCard, renderScene, tiltedQuad, type HeatFieldsConfig } from "./index.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../docs/heat_fields.json", import.meta.url), "utf8")) as HeatFieldsConfig;
const mod = await import("@techstark/opencv-js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cv: any = await ((mod as any).default ?? mod);

/** Size of the WASM heap: every Mat's data is a view on it. */
function heapBytes(): number {
  const m = new cv.Mat(1, 1, cv.CV_8UC1);
  const n = (m.data as Uint8Array).buffer.byteLength;
  m.delete();
  return n;
}

test("marker-mode reads do not leak WASM memory (80 reads, heap stays put)", () => {
  // marker mode runs darknessMap up to three times per read; it used to leak its channel Mats (~2 MB per read)
  const card = renderCard(cv, cfg, { heatLevels: [1, 0, 0, 0, 0, 0], humidityTriggered: false });
  const frame = renderScene(cv, card, { width: 640, height: 360, quad: tiltedQuad(640, 360, 560) });
  card.delete();
  assert.equal(readCard(cv, frame, cfg).found, true);
  for (let i = 0; i < 3; i++) readCard(cv, frame, cfg);
  const before = heapBytes();
  for (let i = 0; i < 80; i++) readCard(cv, frame, cfg);
  const grown = heapBytes() - before;
  assert.ok(grown < 16e6, `heap grew by ${(grown / 1e6).toFixed(1)} MB`);
});
