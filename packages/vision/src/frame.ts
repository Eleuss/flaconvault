import type { CV } from "./types.ts";

type Pt = [number, number];

/** Order 4 points as top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(pts: Pt[]): Pt[] {
  const c: Pt = [pts.reduce((a, p) => a + p[0], 0) / 4, pts.reduce((a, p) => a + p[1], 0) / 4];
  const byAngle = [...pts].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  // after sorting by angle (y down) the order is clockwise starting somewhere; rotate so the first is top-left
  let start = 0, best = Infinity;
  byAngle.forEach((p, i) => { const s = p[0] + p[1]; if (s < best) { best = s; start = i; } });
  return [0, 1, 2, 3].map((i) => byAngle[(start + i) % 4]);
}

function lineIntersect(a: [number, number, number, number], b: [number, number, number, number]): Pt | null {
  // lines as (vx, vy, x0, y0)
  const d = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b[2] - a[2]) * b[1] - (b[3] - a[3]) * b[0]) / d;
  return [a[2] + a[0] * t, a[3] + a[1] * t];
}

/**
 * Find the card seen through the holder's window: the largest bright, convex quadrilateral that does not touch the
 * image border and has roughly the window's aspect ratio. Corners are refined by fitting a line to each side
 * (rounded corners, R 2 mm, would otherwise pull approxPolyDP's corners inwards). Returns TL,TR,BR,BL or null.
 */
export function detectCardQuad(cv: CV, gray: CV, aspect: number, dbg?: (...a: unknown[]) => void): Pt[] | null {
  const blur = new cv.Mat(), bin = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
  const imgArea = gray.rows * gray.cols;
  let best: { quad: Pt[]; score: number; contour: CV } | null = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < 0.02 * imgArea || area > 0.7 * imgArea) { c.delete(); continue; }
    const bb = cv.boundingRect(c);
    if (bb.x <= 1 || bb.y <= 1 || bb.x + bb.width >= gray.cols - 1 || bb.y + bb.height >= gray.rows - 1) { c.delete(); continue; }
    const per = cv.arcLength(c, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.03 * per, true);
    const n = approx.rows;
    if (n !== 4 || !cv.isContourConvex(approx)) { approx.delete(); c.delete(); continue; }
    const a: number[] = Array.from(approx.data32S);
    const quad = orderQuad([[a[0], a[1]], [a[2], a[3]], [a[4], a[5]], [a[6], a[7]]]);
    const w = (Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1])) / 2;
    const h = (Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1])) / 2;
    const ar = w / Math.max(1, h);
    const fill = area / Math.max(1, w * h);
    const score = Math.abs(ar - aspect) / aspect + (1 - fill) * 2 - Math.min(1, area / imgArea);
    dbg?.("quad cand", quad.map((p) => p.map(Math.round)), "ar", ar, "fill", fill, "score", score);
    approx.delete();
    if (Math.abs(ar - aspect) / aspect < 0.25 && fill > 0.85 && (!best || score < best.score)) {
      if (best) best.contour.delete();
      best = { quad, score, contour: c };
    } else c.delete();
  }
  let out: Pt[] | null = null;
  if (best) {
    // refine each side with a line fit over the contour points close to it, away from the corners
    const pts: Pt[] = [];
    const d: Int32Array = best.contour.data32S;
    for (let i = 0; i < d.length; i += 2) pts.push([d[i], d[i + 1]]);
    const q = best.quad;
    const lines: Array<[number, number, number, number] | null> = [];
    for (let s = 0; s < 4; s++) {
      const p0 = q[s], p1 = q[(s + 1) % 4];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
      const sel: number[] = [];
      for (const p of pts) {
        const t = (p[0] - p0[0]) * ux + (p[1] - p0[1]) * uy;
        const dist = Math.abs((p[0] - p0[0]) * uy - (p[1] - p0[1]) * ux);
        if (t > 0.12 * len && t < 0.88 * len && dist < 0.02 * len + 2) sel.push(p[0], p[1]);
      }
      if (sel.length < 20) { lines.push(null); continue; }
      const m = cv.matFromArray(sel.length / 2, 1, cv.CV_32SC2, sel);
      const l = new cv.Mat();
      cv.fitLine(m, l, cv.DIST_L2, 0, 0.01, 0.01);
      const v: number[] = Array.from(l.data32F);
      lines.push([v[0], v[1], v[2], v[3]]);
      m.delete(); l.delete();
    }
    if (lines.every((l) => l)) {
      const L = lines as Array<[number, number, number, number]>;
      const refined: Pt[] = [];
      for (let s = 0; s < 4; s++) {
        const p = lineIntersect(L[(s + 3) % 4], L[s]);
        if (!p) { refined.length = 0; break; }
        refined.push(p);
      }
      out = refined.length === 4 ? refined : q;
      dbg?.("quad refined", out.map((p) => p.map((v) => +v.toFixed(1))));
    } else out = q;
    best.contour.delete();
  }
  blur.delete(); bin.delete(); k.delete(); contours.delete(); hier.delete();
  return out;
}
