// Run the card reader on photos (JPEG or PNG) and write an annotated warped card next to each, as <name>.warped.png:
//   node packages/vision/scripts/calibrate.ts a.jpg b.png
// The overlay follows the layout the reader used: cfg.frame for the card in its holder, the marker layout otherwise.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCard } from "../src/pipeline.ts";
import type { CardReading, HeatFieldsConfig, RoiMm } from "../src/types.ts";
import { decodeImage, encodePng, type RgbaImage } from "./image-io.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../docs/heat_fields.json", import.meta.url), "utf8")) as HeatFieldsConfig;
const mod = await import("@techstark/opencv-js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cv: any = await ((mod as any).default ?? mod);

type Colour = [number, number, number];
const RED: Colour = [255, 0, 0], GREEN: Colour = [0, 160, 0], BLUE: Colour = [0, 0, 255], MAGENTA: Colour = [255, 0, 255], ORANGE: Colour = [255, 140, 0];

/** Output path: never the input file itself (a calibration photo must not be overwritten). */
export function warpedName(file: string): string {
  const out = /\.(png|jpe?g)$/i.test(file) ? file.replace(/\.(png|jpe?g)$/i, ".warped.png") : `${file}.warped.png`;
  if (resolve(out) === resolve(file)) throw new Error(`Refusing to overwrite the input ${file}`);
  return out;
}

function overlay(img: RgbaImage, r: CardReading): void {
  const S = cfg.px_per_mm;
  const px = (x: number, y: number, c: Colour) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  };
  const rect = (q: RoiMm, c: Colour) => {
    const x = Math.round(q.x * S), y = Math.round(q.y * S), w = Math.round(q.w * S), h = Math.round(q.h * S);
    for (let i = 0; i <= w; i++) { px(x + i, y, c); px(x + i, y + h, c); }
    for (let j = 0; j <= h; j++) { px(x, y + j, c); px(x + w, y + j, c); }
  };
  const circ = (cx: number, cy: number, rr: number, c: Colour) => { for (let a = 0; a < 720; a++) px(Math.round((cx + rr * Math.cos(a / 114.6)) * S), Math.round((cy + rr * Math.sin(a / 114.6)) * S), c); };
  if (r.quality.mode === "frame" && cfg.frame) {
    const fr = cfg.frame;
    rect(fr.window_mm, BLUE);
    rect(fr.strip_mm, ORANGE);
    for (const f of fr.fields) rect(f.roi_mm, RED);
    rect(fr.white_ref_mm, GREEN);
    rect(fr.uv_mm, MAGENTA);
    circ(fr.humidity_mm.cx, fr.humidity_mm.cy, fr.humidity_mm.roi_r, RED);
    circ(fr.black_ref.cx, fr.black_ref.cy, fr.black_ref.r0, GREEN);
    circ(fr.black_ref.cx, fr.black_ref.cy, fr.black_ref.r1, GREEN);
  } else {
    rect(cfg.window_mm, BLUE);
    for (const f of cfg.fields) rect(f.roi_mm, RED);
    circ(cfg.humidity_mm.cx, cfg.humidity_mm.cy, cfg.humidity_mm.roi_r, RED);
    rect({ x: cfg.aruco.x, y: cfg.aruco.y, w: cfg.aruco.size, h: cfg.aruco.size }, GREEN);
    rect({ x: cfg.qr.x, y: cfg.qr.y, w: cfg.qr.size, h: cfg.qr.size }, GREEN);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) {
    const outFile = warpedName(file);
    const img = decodeImage(readFileSync(file));
    const r = readCard(cv, img, cfg, { preview: true, debug: true });
    console.log(`== ${file}`);
    console.log(JSON.stringify({ found: r.found, reason: r.reason, mode: r.quality.mode, heat: r.heat, heatLevels: r.heatLevels, humidity: r.humidity, uv: r.uv, confidence: r.confidence, anchors: r.quality.anchors, groups: r.quality.groups, ms: Math.round(r.ms) }));
    for (const l of r.debug ?? []) console.log("  " + l);
    if (r.warped) {
      const out: RgbaImage = { data: new Uint8ClampedArray(r.warped.data), width: r.warped.width, height: r.warped.height };
      overlay(out, r);
      writeFileSync(outFile, encodePng(out));
      console.log("  warped →", outFile);
    }
  }
}
