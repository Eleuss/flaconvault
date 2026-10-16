// Frame mode (the physical Rev C card in its holder) on real photos: fixtures/card-{2,3,4}.jpg are the 2026-10-11
// calibration photos, downscaled to 1000 px. Negatives (turned, mirrored, blank, glare) are generated from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Indicator } from "@flaconvault/proof";
import { combineReadings, frameWhiteBalance, GLARE_MAX_FRACTION, readCard, RING_MAX_RATIO, type CardReading, type FrameLike, type HeatFieldsConfig, type Rgb } from "./index.ts";
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
const centreMm = (r: { x: number; y: number; w: number; h: number }): Pt => [r.x + r.w / 2, r.y + r.h / 2];
const pxPerMm = (r: CardReading, at: Pt) => { const [a, b] = toPhoto(r, [at, [at[0] + 1, at[1]]]); return Math.hypot(b[0] - a[0], b[1] - a[1]); };
/** A highlight of radius rMm (card mm) centred on a card position, placed through the reading's homography. */
const glareAt = (f: FrameLike, r: CardReading, c: Pt, rMm: number) => glare(f, toPhoto(r, [c])[0], rMm * pxPerMm(r, c));

/** Paint the annulus r0..r1 (card mm) around a card position with a colour: photo px → card mm via the homography. */
function paintRing(f: FrameLike, r: CardReading, c: Pt, r0: number, r1: number, rgb: number[]): FrameLike {
  const h = r.homography!;
  const box = toPhoto(r, rectMm(c[0] - r1, c[1] - r1, 2 * r1, 2 * r1, 0.5));
  const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
  const data = new Uint8ClampedArray(f.data);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(f.height, Math.ceil(Math.max(...ys))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(f.width, Math.ceil(Math.max(...xs))); x++) {
      const w = h[6] * x + h[7] * y + h[8];
      const d = Math.hypot((h[0] * x + h[1] * y + h[2]) / w / S - c[0], (h[3] * x + h[4] * y + h[5]) / w / S - c[1]);
      if (d < r0 || d > r1) continue;
      const i = (y * f.width + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = rgb[k];
    }
  }
  return { data, width: f.width, height: f.height };
}
const UNREADABLE_ALL = { heat: Indicator.UNREADABLE, humidity: Indicator.UNREADABLE, uv: Indicator.UNREADABLE, heatLevels: [0, 0, 0, 0, 0, 0] };
const verdicts = (r: CardReading) => ({ heat: r.heat, humidity: r.humidity, uv: r.uv, heatLevels: r.heatLevels });

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

test("mirrored photo (e.g. a front camera) → every indicator UNREADABLE, never TRIGGERED", () => {
  for (const { name, img } of photos) {
    const r = read(mirror(img));
    assert.notEqual(r.heat, Indicator.TRIGGERED, name);
    // the label is symmetric, so it anchors the mirrored card; the ring check then voids the white balance (without
    // it, UV read TRIGGERED at confidence ≈ 1 and humidity INTACT on card-2 and card-3)
    assert.deepEqual(r.quality.anchors, ["heat-label"], name);
    assert.deepEqual(verdicts(r), UNREADABLE_ALL, `${name}: ${JSON.stringify(summary(r))}`);
    assert.equal(r.quality.groups.heat.ok, false, name);
    assert.equal(r.quality.groups.hum.ok, false, name);
    assert.deepEqual(r.confidence, { heat: 0, humidity: 0 }, name);
    assert.match(r.reason ?? "", /White balance failed/, name);
  }
});

test("frameWhiteBalance: void unless the ring is clearly darker than the card white", () => {
  // the mirrored card-2: ring and white differ by more than 12 per channel, but the "ring" is 0.8 × the white
  const mirrored = frameWhiteBalance([170, 186, 197], [210, 231, 248]);
  assert.equal(mirrored.ringDark, false);
  assert.equal(mirrored.ok, false);
  // upright card-2 and card-4: ring at about a third of the white
  for (const [black, white] of [[[70, 74, 81], [216, 238, 252]], [[73, 74, 73], [232, 235, 240]]] as Array<[Rgb, Rgb]>) {
    const wb = frameWhiteBalance(black, white);
    assert.equal(wb.ok, true);
    assert.deepEqual(wb.apply(white).map(Math.round), [255, 255, 255]);
    assert.deepEqual(wb.apply(black).map(Math.round), [17, 17, 17]);
  }
  // one channel above RING_MAX_RATIO is enough to void it
  assert.equal(frameWhiteBalance([70, 74, Math.ceil(RING_MAX_RATIO * 252) + 1], [216, 238, 252]).ok, false);
  // dark enough, but the span is degenerate (under-exposed)
  const dim = frameWhiteBalance([4, 4, 4], [12, 12, 12]);
  assert.equal(dim.ringDark, true);
  assert.equal(dim.ok, false);
});

test("black ring printed or photographed mid-grey (0.7 × the card white) → every indicator UNREADABLE", () => {
  for (const { name, img } of photos) {
    const u = upright.get(name)!;
    const white = meanIn(img, toPhoto(u, rectMm(fr.white_ref_mm.x, fr.white_ref_mm.y, fr.white_ref_mm.w, fr.white_ref_mm.h)));
    const b = fr.black_ref;
    const r = read(paintRing(img, u, [b.cx, b.cy], b.r0 - 0.4, b.r1 + 0.6, white.map((v) => 0.7 * v)));
    assert.deepEqual(r.quality.anchors, ["heat-label"], name);
    assert.deepEqual(verdicts(r), UNREADABLE_ALL, `${name}: ${r.reason}`);
    assert.deepEqual(r.confidence, { heat: 0, humidity: 0 }, name);
    assert.equal(r.quality.groups.heat.ok, false, name);
    assert.match(r.reason ?? "", /White balance failed/, name);
    assert.ok(r.uvField && r.humidityField, "the per-field measurements stay available");
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
    // inconsistent fields signal misregistration in frame mode: humidity and UV are void as well
    assert.deepEqual(verdicts(odd), UNREADABLE_ALL, `${name}: ${JSON.stringify(summary(odd))}`);
    assert.deepEqual(odd.confidence, { heat: 0, humidity: 0 }, name);
    assert.match(odd.reason ?? "", /Heat fields are inconsistent/, name);
  }
});

test("five frames of a triggered card, one with a highlight on the 40 °C field → combined reading stays TRIGGERED", () => {
  const name = "card-2.jpg", u = upright.get(name)!;
  const triggered = withTriggered(name, [3, 4]);
  const f40 = fr.fields[4].roi_mm, c = centreMm(f40);
  const t = read(triggered);
  const g = read(glareAt(triggered, u, c, 1.6));
  assert.notEqual(g.heat, Indicator.TRIGGERED, "the highlight hides the black field in that frame");
  assert.equal(g.heat, Indicator.UNREADABLE, "and is detected as glare, not read as INTACT");
  const one = combineReadings([t, t, g, t, t]);
  assert.equal(one.heat, Indicator.TRIGGERED);
  assert.deepEqual(one.heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.equal(one.humidity, Indicator.INTACT);
  assert.deepEqual(one.votes, { frames: 5, found: 5, heat: 4, humidity: 5, uv: 5 });
  assert.equal(combineReadings([t, g, t, g, t]).heat, Indicator.TRIGGERED, "3 of 5 still decide");
  assert.equal(combineReadings([t, g, t, g]).heat, Indicator.UNREADABLE, "2 : 2 decides nothing");
});

test("the same highlight on the triggered 40 °C field in all five frames → heat UNREADABLE, never INTACT", () => {
  const c = centreMm(fr.fields[4].roi_mm);
  for (const { name } of photos) {
    const u = upright.get(name)!;
    const g = read(glareAt(withTriggered(name, [3, 4]), u, c, 1.6));
    assert.equal(g.found, true, name);
    assert.equal(g.heatFields[4].glare, true, `${name}: clipped ${g.heatFields[4].clipped}`);
    assert.ok((g.heatFields[4].clipped ?? 0) > GLARE_MAX_FRACTION, name);
    assert.equal(g.heatFields[4].confidence, 0, name);
    assert.equal(g.heat, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(g))}`);
    assert.deepEqual(g.heatLevels, [0, 0, 0, 0, 0, 0], name);
    assert.equal(g.confidence.heat, 0, name);
    assert.match(g.reason ?? "", /Glare on the heat strip/, name);
    assert.equal(g.humidity, Indicator.INTACT, `${name}: the humidity dot has no glare`);
    assert.equal(g.uv, Indicator.INTACT, name);
    const all = combineReadings([g, g, g, g, g]);
    assert.notEqual(all.heat, Indicator.INTACT, name);
    assert.equal(all.heat, Indicator.UNREADABLE, name);
    assert.deepEqual(all.heatLevels, [0, 0, 0, 0, 0, 0], name);
  }
});

test("glare on a non-decisive heat field: the strip's physics fills it in where it can, else heat is UNREADABLE", () => {
  const at = (i: number) => centreMm(fr.fields[i].roi_mm);
  for (const { name, img } of photos) {
    const u = upright.get(name)!;
    // intact card, highlight on the (white) 42 °C field: above an intact 40 °C field it can only be intact
    const hot = read(glareAt(img, u, at(5), 1.6));
    assert.equal(hot.heatFields[5].glare, true, name);
    assert.equal(hot.heat, Indicator.INTACT, `${name}: ${hot.reason}`);
    assert.deepEqual(hot.heatLevels, [1, 1, 1, 0, 0, 0], name);
    assert.equal(hot.reason, undefined, name);
    // triggered card, highlight on the black 37 °C field: below a triggered 40 °C field it must be triggered
    const cool = read(glareAt(withTriggered(name, [3, 4]), u, at(3), 1.6));
    assert.equal(cool.heatFields[3].glare, true, name);
    assert.equal(cool.heat, Indicator.TRIGGERED, `${name}: ${cool.reason}`);
    assert.deepEqual(cool.heatLevels, [1, 1, 1, 1, 1, 0], name);
    // triggered card, highlight on the 42 °C field: it may be black, so the levels cannot be reported
    const top = read(glareAt(withTriggered(name, [3, 4]), u, at(5), 1.6));
    assert.equal(top.heat, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(top))}`);
    assert.deepEqual(top.heatLevels, [0, 0, 0, 0, 0, 0], name);
    assert.match(top.reason ?? "", /Glare on the heat strip/, name);
    // intact card, highlight on the black 34 °C field: without the check it read [1,1,0,0,0,0] (understated)
    const mid = read(glareAt(img, u, at(2), 1.6));
    assert.equal(mid.heat, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(mid))}`);
    assert.deepEqual(mid.heatLevels, [0, 0, 0, 0, 0, 0], name);
    assert.match(mid.reason ?? "", /Glare on the heat strip/, name);
    assert.equal(mid.humidity, Indicator.INTACT, `${name}: glare is local, humidity stays decided`);
  }
});

test("glare on the humidity dot or the UV window → that indicator UNREADABLE, the others stay decided", () => {
  const hm = fr.humidity_mm, uvc = centreMm(fr.uv_mm);
  for (const { name, img } of photos) {
    const u = upright.get(name)!;
    // a triggered (pink) dot under a highlight would read INTACT; it must not
    const white = meanIn(img, toPhoto(u, rectMm(fr.white_ref_mm.x, fr.white_ref_mm.y, fr.white_ref_mm.w, fr.white_ref_mm.h)));
    const dot = toPhoto(u, Array.from({ length: 24 }, (_, k) => [hm.cx + 2.2 * Math.cos((k / 24) * 2 * Math.PI), hm.cy + 2.2 * Math.sin((k / 24) * 2 * Math.PI)] as Pt));
    const pink = paint(img, dot, [0xe5, 0x8a, 0xb2].map((v, k) => (v * white[k]) / 255));
    assert.equal(read(pink).humidity, Indicator.TRIGGERED, `${name}: the painted dot reads pink`);
    const h = read(glareAt(pink, u, [hm.cx, hm.cy], 1.6));
    assert.equal(h.humidityField?.glare, true, name);
    assert.equal(h.humidity, Indicator.UNREADABLE, `${name}: ${JSON.stringify(summary(h))}`);
    assert.equal(h.confidence.humidity, 0, name);
    assert.match(h.reason ?? "", /Glare on the humidity dot/, name);
    assert.equal(h.quality.groups.hum.ok, true, `${name}: the ring is untouched`);
    assert.equal(h.heat, Indicator.INTACT, name);
    assert.deepEqual(h.heatLevels, [1, 1, 1, 0, 0, 0], name);
    const v = read(glareAt(img, u, uvc, 3));
    assert.equal(v.uvField?.glare, true, name);
    assert.equal(v.uv, Indicator.UNREADABLE, name);
    assert.match(v.reason ?? "", /Glare on the UV window/, name);
    assert.equal(v.heat, Indicator.INTACT, name);
    assert.equal(v.humidity, Indicator.INTACT, name);
  }
});

test("the calibration photos have no glare: no sampled region is above the clipping limit", () => {
  for (const { name } of photos) {
    const r = upright.get(name)!;
    for (const f of [...r.heatFields, r.humidityField!, r.uvField!]) {
      assert.equal(f.glare, false, name);
      assert.ok((f.clipped ?? 1) <= GLARE_MAX_FRACTION, `${name}: ${f.clipped}`);
    }
  }
});
