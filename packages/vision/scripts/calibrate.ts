// Run the card reader on PNG photos and write an annotated warped card next to each: node packages/vision/scripts/calibrate.ts a.png b.png
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { readCard } from "../src/pipeline.ts";
import type { HeatFieldsConfig } from "../src/types.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../docs/heat_fields.json", import.meta.url), "utf8")) as HeatFieldsConfig;
const mod = await import("@techstark/opencv-js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cv: any = await ((mod as any).default ?? mod);

for (const file of process.argv.slice(2)) {
  const png = PNG.sync.read(readFileSync(file));
  const r = readCard(cv, { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height }, cfg, { preview: true, debug: true });
  console.log(`== ${file}`);
  console.log(JSON.stringify({ found: r.found, reason: r.reason, mode: r.quality.mode, heat: r.heat, heatLevels: r.heatLevels, humidity: r.humidity, uv: r.uv, confidence: r.confidence, anchors: r.quality.anchors, groups: r.quality.groups, ms: Math.round(r.ms) }));
  for (const l of r.debug ?? []) console.log("  " + l);
  if (r.warped) {
    const S = cfg.px_per_mm, fr = cfg.frame!;
    const out = new PNG({ width: r.warped.width, height: r.warped.height });
    out.data = Buffer.from(r.warped.data);
    const px = (x: number, y: number, c: [number, number, number]) => { if (x < 0 || y < 0 || x >= out.width || y >= out.height) return; const i = (y * out.width + x) * 4; out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255; };
    const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => { for (let i = 0; i <= w; i++) { px(x + i, y, c); px(x + i, y + h, c); } for (let j = 0; j <= h; j++) { px(x, y + j, c); px(x + w, y + j, c); } };
    const circ = (cx: number, cy: number, rr: number, c: [number, number, number]) => { for (let a = 0; a < 360; a++) px(Math.round(cx + rr * Math.cos(a / 57.3)), Math.round(cy + rr * Math.sin(a / 57.3)), c); };
    for (const f of fr.fields) rect(Math.round(f.roi_mm.x * S), Math.round(f.roi_mm.y * S), Math.round(f.roi_mm.w * S), Math.round(f.roi_mm.h * S), [255, 0, 0]);
    rect(Math.round(fr.white_ref_mm.x * S), Math.round(fr.white_ref_mm.y * S), Math.round(fr.white_ref_mm.w * S), Math.round(fr.white_ref_mm.h * S), [0, 160, 0]);
    rect(Math.round(fr.uv_mm.x * S), Math.round(fr.uv_mm.y * S), Math.round(fr.uv_mm.w * S), Math.round(fr.uv_mm.h * S), [255, 0, 255]);
    circ(fr.humidity_mm.cx * S, fr.humidity_mm.cy * S, fr.humidity_mm.roi_r * S, [255, 0, 0]);
    circ(fr.black_ref.cx * S, fr.black_ref.cy * S, fr.black_ref.r0 * S, [0, 160, 0]);
    circ(fr.black_ref.cx * S, fr.black_ref.cy * S, fr.black_ref.r1 * S, [0, 160, 0]);
    rect(Math.round(fr.window_mm.x * S), Math.round(fr.window_mm.y * S), Math.round(fr.window_mm.w * S), Math.round(fr.window_mm.h * S), [0, 0, 255]);
    const outFile = file.replace(/\.png$/, ".warped.png");
    writeFileSync(outFile, PNG.sync.write(out));
    console.log("  warped →", outFile);
  }
}
