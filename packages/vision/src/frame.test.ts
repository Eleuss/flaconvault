// Frame mode (the physical Rev C card in its holder) on real photos: fixtures/card-{2,3,4}.jpg are the 2026-10-11
// calibration photos, downscaled to 1000 px. Negatives (turned, mirrored, blank, glare) are generated from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Indicator } from "@flaconvault/proof";
import { readCard, type CardReading, type FrameLike, type HeatFieldsConfig } from "./index.ts";
import { decodeImage } from "../scripts/image-io.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../docs/heat_fields.json", import.meta.url), "utf8")) as HeatFieldsConfig;
const fr = cfg.frame!;
const S = cfg.px_per_mm;
const mod = await import("@techstark/opencv-js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cv: any = await ((mod as any).default ?? mod);

type Pt = [number, number];
const photos = ["card-2.jpg", "card-3.jpg", "card-4.jpg"].map((name) => ({ name, img: decodeImage(readFileSync(new URL(`../fixtures/${name}`, import.meta.url))) as FrameLike }));
const read = (f: FrameLike) => readCard(cv, f, cfg);
const upright = new Map(photos.map((p) => [p.name, read(p.img)]));
const summary = (r: CardReading) => ({ found: r.found, heat: r.heat, humidity: r.humidity, uv: r.uv, heatLevels: r.heatLevels });

/** Run an OpenCV operation on a copy of the frame. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function edit(f: FrameLike, op: (src: any, dst: any) => void): FrameLike {
  const src = cv.matFromImageData({ data: f.data, width: f.width, height: f.height });
  const dst = new cv.Mat();
  op(src, dst);
  const out = { data: new Uint8ClampedArray(dst.data), width: dst.cols, height: dst.rows };
  src.delete(); dst.delete();
  return out;
}
const rotate = (f: FrameLike, code: number) => edit(f, (s, d) => cv.rotate(s, d, code));
const mirror = (f: FrameLike) => edit(f, (s, d) => cv.flip(s, d, 1));

/** Card mm → photo px through the inverse of the reading's homography (photo px → warped card px). */
function toPhoto(r: CardReading, mm: Pt[]): Pt[] {
  const H = cv.matFromArray(3, 3, cv.CV_64F, r.homography!), inv = new cv.Mat();
  cv.invert(H, inv);
  const h: number[] = Array.from(inv.data64F);
  H.delete(); inv.delete();
  return mm.map(([x, y]) => {
    const X = x * S, Y = y * S, w = h[6] * X + h[7] * Y + h[8];
    return [(h[0] * X + h[1] * Y + h[2]) / w, (h[3] * X + h[4] * Y + h[5]) / w];
  });
}
const rectMm = (x: number, y: number, w: number, h: number, grow = 0): Pt[] => [[x - grow, y - grow], [x + w + grow, y - grow], [x + w + grow, y + h + grow], [x - grow, y + h + grow]];

/** Fill a polygon (photo px) with a colour. */
function paint(f: FrameLike, poly: Pt[], rgb: number[]): FrameLike {
  return edit(f, (s, d) => {
    s.copyTo(d);
    const pts = cv.matFromArray(poly.length, 1, cv.CV_32SC2, poly.flat().map(Math.round));
    const v = new cv.MatVector();
    v.push_back(pts);
    cv.fillPoly(d, v, new cv.Scalar(rgb[0], rgb[1], rgb[2], 255));
    v.delete(); pts.delete();
  });
}
/** Mean colour inside a polygon (photo px). */
function meanIn(f: FrameLike, poly: Pt[]): number[] {
  const m = cv.matFromImageData({ data: f.data, width: f.width, height: f.height });
  const mask = cv.Mat.zeros(m.rows, m.cols, cv.CV_8UC1);
  const pts = cv.matFromArray(poly.length, 1, cv.CV_32SC2, poly.flat().map(Math.round));
  const v = new cv.MatVector();
  v.push_back(pts);
  cv.fillPoly(mask, v, new cv.Scalar(255));
  const s = cv.mean(m, mask);
  m.delete(); mask.delete(); pts.delete(); v.delete();
  return [s[0], s[1], s[2]];
}
/** A specular highlight: a white disc (photo px) with a soft edge. */
function glare(f: FrameLike, c: Pt, r: number): FrameLike {
  const data = new Uint8ClampedArray(f.data);
  for (let y = Math.max(0, Math.floor(c[1] - 1.5 * r)); y < Math.min(f.height, c[1] + 1.5 * r); y++) {
    for (let x = Math.max(0, Math.floor(c[0] - 1.5 * r)); x < Math.min(f.width, c[0] + 1.5 * r); x++) {
      const d = Math.hypot(x - c[0], y - c[1]);
      const a = d <= r ? 1 : d >= 1.5 * r ? 0 : (1.5 * r - d) / (0.5 * r);
      const i = (y * f.width + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = data[i + k] * (1 - a) + 255 * a;
    }
  }
  return { data, width: f.width, height: f.height };
}
const pxPerMm = (r: CardReading, at: Pt) => { const [a, b] = toPhoto(r, [at, [at[0] + 1, at[1]]]); return Math.hypot(b[0] - a[0], b[1] - a[1]); };

/** The photo with the given heat fields painted in the triggered (black) colour measured on the same card. */
function withTriggered(name: string, fieldIdx: number[]): FrameLike {
  const r = upright.get(name)!, img = photos.find((p) => p.name === name)!.img;
  const black = r.heatFields[0].rgb; // 29 °C is black on these cards
  return fieldIdx.reduce((f, i) => { const q = fr.fields[i].roi_mm; return paint(f, toPhoto(r, rectMm(q.x, q.y, q.w, q.h, 0.5)), black); }, img);
}

test("real calibration photos → heat levels [1,1,1,0,0,0], 40 °C intact, humidity and UV intact", () => {
  for (const { name } of photos) {
    const r = upright.get(name)!;
    assert.equal(r.found, true, `${name}: ${r.reason}`);
    assert.equal(r.quality.mode, "frame");
    assert.deepEqual(r.quality.anchors, ["heat-label"], name);
    assert.equal(r.quality.groups.heat.ok, true, `${name}: white balance`);
    assert.equal(r.reason, undefined, name);
    assert.deepEqual(r.heatLevels, [1, 1, 1, 0, 0, 0], name);
    assert.equal(r.heat, Indicator.INTACT, `${name}: 40 °C field`);
    assert.equal(r.humidity, Indicator.INTACT, `${name}: humidity`);
    assert.equal(r.uv, Indicator.INTACT, `${name}: UV`);
    assert.ok(r.confidence.heat > 0.95 && r.confidence.humidity > 0.95, `${name}: ${JSON.stringify(r.confidence)}`);
  }
});

test("card turned by 180° or 90° → same reading as upright, never TRIGGERED", () => {
  for (const { name, img } of photos) {
    for (const [label, code] of [["180°", cv.ROTATE_180], ["90° cw", cv.ROTATE_90_CLOCKWISE], ["90° ccw", cv.ROTATE_90_COUNTERCLOCKWISE]] as const) {
      const r = read(rotate(img, code));
      assert.notEqual(r.heat, Indicator.TRIGGERED, `${name} ${label}`);
      assert.deepEqual(summary(r), summary(upright.get(name)!), `${name} ${label}: ${r.reason ?? ""}`);
    }
  }
});

test("mirrored photo (e.g. a front camera) → UNREADABLE, never TRIGGERED", () => {
  for (const { name, img } of photos) {
    const r = read(mirror(img));
    assert.notEqual(r.heat, Indicator.TRIGGERED, name);
    assert.equal(r.heat, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(r))}`);
    assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0], name);
  }
});

test("blank card in the holder → UNREADABLE everywhere (no heat label)", () => {
  for (const { name, img } of photos) {
    const u = upright.get(name)!;
    const white = meanIn(img, toPhoto(u, rectMm(fr.white_ref_mm.x, fr.white_ref_mm.y, fr.white_ref_mm.w, fr.white_ref_mm.h)));
    const w = fr.window_mm;
    const r = read(paint(img, toPhoto(u, rectMm(w.x, w.y, w.w, w.h, 0.3)), white));
    assert.deepEqual(summary(r), { found: true, heat: Indicator.UNREADABLE, humidity: Indicator.UNREADABLE, uv: Indicator.UNREADABLE, heatLevels: [0, 0, 0, 0, 0, 0] }, `${name}: ${r.reason}`);
    assert.deepEqual(r.quality.anchors, [], name);
    assert.equal(r.confidence.heat, 0);
    assert.match(r.reason ?? "", /Heat label not found/);
  }
});

test("card without the blue heat label (label area painted card-white) → UNREADABLE", () => {
  for (const { name, img } of photos) {
    const u = upright.get(name)!;
    const white = meanIn(img, toPhoto(u, rectMm(fr.white_ref_mm.x, fr.white_ref_mm.y, fr.white_ref_mm.w, fr.white_ref_mm.h)));
    const st = fr.strip_mm;
    const r = read(paint(img, toPhoto(u, rectMm(st.x, st.y, st.w, st.h, 0.8)), white));
    assert.equal(r.heat, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(r))}`);
    assert.equal(r.humidity, Indicator.UNREADABLE, name);
    assert.equal(r.uv, Indicator.UNREADABLE, name);
    assert.deepEqual(r.heatLevels, [0, 0, 0, 0, 0, 0], name);
  }
});

test("glare over the black reference ring → white balance void → UNREADABLE", () => {
  for (const { name, img } of photos) {
    const u = upright.get(name)!;
    const c: Pt = [fr.black_ref.cx, fr.black_ref.cy];
    const r = read(glare(img, toPhoto(u, [c])[0], (fr.black_ref.r1 + 1) * pxPerMm(u, c)));
    assert.equal(r.quality.groups.heat.ok, false, name);
    assert.deepEqual(summary(r), { found: true, heat: Indicator.UNREADABLE, humidity: Indicator.UNREADABLE, uv: Indicator.UNREADABLE, heatLevels: [0, 0, 0, 0, 0, 0] }, name);
  }
});

test("37 + 40 °C fields black → TRIGGERED [1,1,1,1,1,0]; 40 °C alone black (impossible) → UNREADABLE", () => {
  for (const { name } of photos) {
    const t = read(withTriggered(name, [3, 4]));
    assert.equal(t.heat, Indicator.TRIGGERED, `${name}: ${t.reason}`);
    assert.deepEqual(t.heatLevels, [1, 1, 1, 1, 1, 0], name);
    const odd = read(withTriggered(name, [4]));
    assert.equal(odd.heat, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(odd))}`);
    assert.deepEqual(odd.heatLevels, [0, 0, 0, 0, 0, 0], name);
  }
});
