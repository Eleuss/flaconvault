/**
 * Synthetic Rev C card renderer — for tests and the /dev/vision demo. Draws the card exactly as the SVG
 * (same mm geometry), warps it into a scene with perspective, tint, blur and noise.
 */
import { hexToRgb } from "./color.ts";
import { CARD_H_MM, CARD_W_MM } from "./pipeline.ts";
import type { CV, FrameLike, HeatFieldsConfig, Rgb } from "./types.ts";

export interface CardState { heatLevels: number[]; humidityTriggered: boolean; qr?: boolean }

/** The QR modules printed on the Rev C card (content = serial), 21×21, origin (11.522, 25.622) mm, pitch 0.2407 mm — parsed from the SVG. */
export const QR_MODULES = "111111101000101111111|100000101101001000001|101110101111101011101|101110101010101011101|101110100111101011101|100000101010101000001|111111101010101111111|000000000000000000000|110011100000100101111|010001001010111001000|011010111110100111100|011100011101100110000|111011101011011000011|000000001111111001001|111111100101000111110|100000101100000111011|101110101000111010101|101110100110101110111|101110100010100101000|100000101011100011101|111111101111011010111";
export const QR_ORIGIN_MM: [number, number] = [11.522, 25.622];
export const QR_PITCH_MM = 0.2407;
export interface SceneOptions {
  width: number; height: number;
  /** where the card's TL, TR, BR, BL corners land in the scene (px) */
  quad: Array<[number, number]>;
  tint?: Rgb;              // per-channel multipliers, e.g. warm light [1.05, 1.0, 0.85]
  brightness?: number;     // added to all channels
  blurSigma?: number;
  noiseSigma?: number;
  background?: Rgb;
  seed?: number;
}

const scalar = (cv: CV, [r, g, b]: Rgb) => new cv.Scalar(r, g, b, 255);
const rect = (cv: CV, mat: CV, x: number, y: number, w: number, h: number, color: Rgb, thickness = -1) =>
  cv.rectangle(mat, new cv.Point(Math.round(x), Math.round(y)), new cv.Point(Math.round(x + w), Math.round(y + h)), scalar(cv, color), thickness);

/** Card image, RGBA, size (66·S)×(34·S). Caller deletes. */
export function renderCard(cv: CV, cfg: HeatFieldsConfig, state: CardState): CV {
  const S = cfg.px_per_mm;
  const W = Math.round(CARD_W_MM * S), H = Math.round(CARD_H_MM * S);
  const card = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
  const ref = cfg.reference_colors;
  const amber: Rgb = [166, 101, 27], ink: Rgb = [23, 28, 25], line: Rgb = [201, 208, 202];
  // windows (frames)
  const w = cfg.window_mm;
  rect(cv, card, w.x * S, w.y * S, w.w * S, w.h * S, amber, 1);
  rect(cv, card, 36.2 * S, 5.6 * S, 13 * S, 13 * S, amber, 1);
  // heat strip: six columns over the inner 30 mm of the 32×12 strip
  const st = cfg.strip_mm;
  rect(cv, card, st.x * S, st.y * S, st.w * S, st.h * S, hexToRgb(ref.heat_intact));
  const inner = 30, ix = st.x + (st.w - inner) / 2, col = inner / 6;
  for (let i = 0; i < 6; i++) {
    const on = state.heatLevels[i] === 1;
    rect(cv, card, (ix + i * col) * S, st.y * S, col * S, st.h * S, hexToRgb(on ? ref.heat_triggered : ref.heat_intact));
    rect(cv, card, (ix + i * col) * S, st.y * S, col * S, st.h * S, line, 1);
  }
  // humidity dot
  const hm = cfg.humidity_mm;
  cv.circle(card, new cv.Point(Math.round(hm.cx * S), Math.round(hm.cy * S)), Math.round(hm.r * S), scalar(cv, hexToRgb(state.humidityTriggered ? ref.humidity_triggered : ref.humidity_intact)), -1);
  cv.circle(card, new cv.Point(Math.round(hm.cx * S), Math.round(hm.cy * S)), Math.round(hm.r * S), scalar(cv, amber), 1);
  // patches: intact · triggered · grey · white per group
  const p = cfg.patches_mm;
  const groups: Array<["heat" | "uv" | "hum", Rgb, Rgb]> = [
    ["heat", hexToRgb(ref.heat_intact), hexToRgb(ref.heat_triggered)],
    ["uv", hexToRgb(ref.uv_intact), hexToRgb(ref.uv_triggered)],
    ["hum", hexToRgb(ref.humidity_intact), hexToRgb(ref.humidity_triggered)],
  ];
  for (const [g, c0, c1] of groups) {
    const cols: Rgb[] = [c0, c1, hexToRgb(ref.grey18), hexToRgb(ref.white)];
    cols.forEach((c, i) => {
      const x = p.groups[g] + i * (p.size + p.gap);
      rect(cv, card, x * S, p.y * S, p.size * S, p.size * S, c);
      rect(cv, card, x * S, p.y * S, p.size * S, p.size * S, line, 1);
    });
  }
  // ArUco marker id 7
  const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
  const mk = new cv.Mat();
  const sizePx = Math.round(cfg.aruco.size * S);
  cv.generateImageMarker(dict, cfg.aruco.id, sizePx, mk, 1);
  const mkRgba = new cv.Mat();
  cv.cvtColor(mk, mkRgba, cv.COLOR_GRAY2RGBA);
  const roi = card.roi(new cv.Rect(Math.round(cfg.aruco.x * S), Math.round(cfg.aruco.y * S), sizePx, sizePx));
  mkRgba.copyTo(roi);
  roi.delete(); mkRgba.delete(); mk.delete(); dict.delete();
  // QR code (real modules from the SVG)
  if (state.qr !== false) {
    const rows = QR_MODULES.split("|");
    const pitch = QR_PITCH_MM * S;
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== "1") continue;
        const x0 = QR_ORIGIN_MM[0] * S + c * pitch, y0 = QR_ORIGIN_MM[1] * S + r * pitch;
        cv.rectangle(card, new cv.Point(Math.round(x0), Math.round(y0)), new cv.Point(Math.round(x0 + pitch) - 1, Math.round(y0 + pitch) - 1), scalar(cv, ink), -1);
      }
    });
  }
  // text lines (just ink blocks, enough to look like print)
  rect(cv, card, 18.5 * S, 25.2 * S, 14 * S, 1.4 * S, ink);
  rect(cv, card, 18.5 * S, 27.6 * S, 12 * S, 1.0 * S, line);
  rect(cv, card, 18.5 * S, 29.8 * S, 30 * S, 1.0 * S, line);
  return card;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Warp the card into a scene and degrade it. Returns an RGBA frame. */
export function renderScene(cv: CV, card: CV, o: SceneOptions): FrameLike {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, card.cols, 0, card.cols, card.rows, 0, card.rows]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, o.quad.flat());
  const Hs = cv.getPerspectiveTransform(src, dst);
  const bg = o.background ?? [96, 92, 88];
  const scene = new cv.Mat();
  cv.warpPerspective(card, scene, Hs, new cv.Size(o.width, o.height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, scalar(cv, bg));
  if (o.blurSigma && o.blurSigma > 0) cv.GaussianBlur(scene, scene, new cv.Size(0, 0), o.blurSigma);
  const data = new Uint8ClampedArray(scene.data);
  const tint = o.tint ?? [1, 1, 1], bright = o.brightness ?? 0, ns = o.noiseSigma ?? 0;
  const rnd = mulberry32(o.seed ?? 1);
  const gauss = () => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let i = 0; i < data.length; i += 4) {
    const n = ns > 0 ? gauss() * ns : 0;
    data[i] = data[i] * tint[0] + bright + n;
    data[i + 1] = data[i + 1] * tint[1] + bright + n;
    data[i + 2] = data[i + 2] * tint[2] + bright + n;
    data[i + 3] = 255;
  }
  src.delete(); dst.delete(); Hs.delete(); scene.delete();
  return { data, width: o.width, height: o.height };
}

/** A card quad centred in the scene with a mild perspective tilt (0 = frontal). */
export function tiltedQuad(width: number, height: number, cardPxWidth: number, tilt = 0.08, rotDeg = 0): Array<[number, number]> {
  const cw = cardPxWidth, ch = cardPxWidth * (CARD_H_MM / CARD_W_MM);
  const cx = width / 2, cy = height / 2;
  const base: Array<[number, number]> = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]];
  const r = (rotDeg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return base.map(([x, y], i) => {
    // perspective: top edge narrower than bottom edge
    const k = i < 2 ? 1 - tilt : 1 + tilt;
    const px = x * k, py = y;
    return [cx + px * cos - py * sin, cy + px * sin + py * cos];
  });
}
