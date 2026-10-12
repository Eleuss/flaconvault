import { HEAT_DECISIVE_INDEX, Indicator } from "@flaconvault/proof";
import { classify, makeWhiteBalance, rgbToLab } from "./color.ts";
import type { CardReading, CV, FieldReading, FrameLike, HeatFieldsConfig, PatchSet, Rgb, RoiMm } from "./types.ts";
import { detectCardQuad } from "./frame.ts";
import { hexToRgb } from "./color.ts";

export const CARD_W_MM = 66;
export const CARD_H_MM = 34;
export const ARUCO_ID = 7;
export const CONFIDENCE_THRESHOLD = 0.85;

type Pt = [number, number];

export function markerCornersMm(cfg: HeatFieldsConfig): Pt[] {
  const { x, y, size } = cfg.aruco;
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
}
/** Corners of the printed QR *symbol* (what QRCodeDetector returns), not the 6.5 mm box with its quiet zone. */
export function qrCornersMm(cfg: HeatFieldsConfig): Pt[] {
  const sym = cfg.qr_symbol ?? { x: cfg.qr.x + (cfg.qr.size - 5.055) / 2, y: cfg.qr.y + (cfg.qr.size - 5.055) / 2, size: 5.055 };
  const { x, y, size } = sym;
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
}
export function patchRectsMm(cfg: HeatFieldsConfig, group: "heat" | "uv" | "hum"): RoiMm[] {
  const { size, gap, y, groups } = cfg.patches_mm;
  const inset = size * 0.2;
  return [0, 1, 2, 3].map((i) => ({ x: groups[group] + i * (size + gap) + inset, y: y + inset, w: size * 0.6, h: size * 0.6 }));
}

/**
 * Anchor features used to refine the homography after the first (marker-only) warp: printed elements that are
 * dark or saturated on the white card, spread across its width. Centre in mm + expected blob area in mm².
 */
export function anchorFeaturesMm(cfg: HeatFieldsConfig, stage: 0 | 1): Array<{ name: string; mm: Pt; areaMm2: number; windowMm: number }> {
  const { size, gap, y, groups } = cfg.patches_mm;
  const c = (x0: number, i: number): Pt => [x0 + i * (size + gap) + size / 2, y + size / 2];
  const hm = cfg.humidity_mm;
  const dot = { name: "hum-dot", mm: [hm.cx, hm.cy] as Pt, areaMm2: Math.PI * hm.r * hm.r, windowMm: hm.r + 3.5 };
  if (stage === 0) return [dot]; // the only blob of that size on the card — safe with a wide window
  return [
    dot,
    { name: "heat-black", mm: c(groups.heat, 1), areaMm2: size * size, windowMm: 2.5 },
    { name: "uv-blue", mm: c(groups.uv, 1), areaMm2: size * size, windowMm: 2.5 },
    { name: "hum-blue", mm: c(groups.hum, 0), areaMm2: size * size, windowMm: 2.5 },
    { name: "hum-pink", mm: c(groups.hum, 1), areaMm2: size * size, windowMm: 2.5 },
  ];
}

function meanRect(cv: CV, mat: CV, r: RoiMm, s: number): Rgb {
  const rect = new cv.Rect(Math.round(r.x * s), Math.round(r.y * s), Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s)));
  const roi = mat.roi(rect);
  const m = cv.mean(roi);
  roi.delete();
  return [m[0], m[1], m[2]];
}
function meanCircle(cv: CV, mat: CV, cx: number, cy: number, r: number): Rgb {
  const mask = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
  cv.circle(mask, new cv.Point(Math.round(cx), Math.round(cy)), Math.max(1, Math.round(r)), new cv.Scalar(255), -1);
  const m = cv.mean(mat, mask);
  mask.delete();
  return [m[0], m[1], m[2]];
}
function pointsMat(cv: CV, pts: Pt[]): CV {
  return cv.matFromArray(pts.length, 1, cv.CV_32FC2, pts.flat());
}
function applyH(h: number[], p: Pt): Pt {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
}
function homography(cv: CV, src: Pt[], dst: Pt[]): CV {
  const s = pointsMat(cv, src), d = pointsMat(cv, dst);
  let H: CV;
  try { H = cv.findHomography(s, d, 0); }
  catch { H = cv.getPerspectiveTransform(s, d); }
  s.delete(); d.delete();
  return H;
}
function invert(cv: CV, H: CV): number[] {
  const inv = new cv.Mat();
  cv.invert(H, inv);
  const a = Array.from(inv.data64F) as number[];
  inv.delete();
  return a;
}

/** "Darkness" map of an RGBA image: 255 − min(R,G,B). White → 0, black → 238, blue/pink → 117..197. */
function darknessMap(cv: CV, rgba: CV): CV {
  const ch = new cv.MatVector();
  cv.split(rgba, ch);
  const mn = new cv.Mat();
  cv.min(ch.get(0), ch.get(1), mn);
  cv.min(mn, ch.get(2), mn);
  const dark = new cv.Mat();
  cv.subtract(new cv.Mat(mn.rows, mn.cols, cv.CV_8UC1, new cv.Scalar(255)), mn, dark);
  ch.delete(); mn.delete();
  return dark;
}

/**
 * Find one printed blob near its expected position in the warped card. Returns its centroid (warped px) or null.
 * Rejects blobs that touch the search window (clipped neighbours) or whose area is implausible.
 */
function locateBlob(cv: CV, dark: CV, cxPx: number, cyPx: number, winPx: number, areaPx: number, thresh: number): Pt | null {
  const x0 = Math.max(0, Math.round(cxPx - winPx)), y0 = Math.max(0, Math.round(cyPx - winPx));
  const x1 = Math.min(dark.cols, Math.round(cxPx + winPx)), y1 = Math.min(dark.rows, Math.round(cyPx + winPx));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const roi = dark.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
  const bin = new cv.Mat();
  cv.threshold(roi, bin, thresh, 255, cv.THRESH_BINARY);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best: { pt: Pt; score: number } | null = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    const bb = cv.boundingRect(c);
    const touches = bb.x <= 0 || bb.y <= 0 || bb.x + bb.width >= bin.cols || bb.y + bb.height >= bin.rows;
    if (!touches && area > 0.35 * areaPx && area < 1.7 * areaPx) {
      const m = cv.moments(c);
      const pt: Pt = [x0 + m.m10 / m.m00, y0 + m.m01 / m.m00];
      const score = Math.abs(area - areaPx) / areaPx + Math.hypot(pt[0] - cxPx, pt[1] - cyPx) / winPx;
      if (!best || score < best.score) best = { pt, score };
    }
    c.delete();
  }
  roi.delete(); bin.delete(); contours.delete(); hier.delete();
  return best?.pt ?? null;
}

/** Global search for the humidity dot: the only circular blob of its size on the card. */
function locateDot(cv: CV, dark: CV, cxPx: number, cyPx: number, areaPx: number, thresh: number, dbg?: (...a: unknown[]) => void): Pt | null {
  const bin = new cv.Mat();
  cv.threshold(dark, bin, thresh, 255, cv.THRESH_BINARY);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  // RETR_LIST: the ring sits inside the white card, which is itself a hole in the dark holder/background blob
  cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  let best: { pt: Pt; score: number } | null = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area > 0.3 * areaPx && area < 3 * areaPx) { const per = cv.arcLength(c, true); dbg?.("dot cand area", area / areaPx, "circ", per > 0 ? (4 * Math.PI * area) / (per * per) : 0, "bb", JSON.stringify(cv.boundingRect(c))); }
    if (area > 0.55 * areaPx && area < 1.6 * areaPx) {
      const per = cv.arcLength(c, true);
      const circ = per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
      if (circ > 0.8) {
        const m = cv.moments(c);
        const pt: Pt = [m.m10 / m.m00, m.m01 / m.m00];
        const score = Math.hypot(pt[0] - cxPx, pt[1] - cyPx) / Math.sqrt(areaPx) + (1 - circ) * 5;
        if (!best || score < best.score) best = { pt, score };
      }
    }
    c.delete();
  }
  bin.delete(); contours.delete(); hier.delete();
  return best?.pt ?? null;
}

function notFound(reason: string, t0: number): CardReading {
  return {
    found: false, reason, heatLevels: [0, 0, 0, 0, 0, 0], heatFields: [], heat: Indicator.MISSING, humidity: Indicator.MISSING,
    humidityField: null, uv: 3, confidence: { heat: 0, humidity: 0 },
    quality: { markerPx: 0, qrUsed: false, anchors: [], groups: { heat: { greyL: 0, whiteL: 0, ok: false }, hum: { greyL: 0, whiteL: 0, ok: false } } },
    homography: null, warped: null, ms: now() - t0,
  };
}
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Briefing §9 pipeline: ArUco (DICT_4X4_50, id 7) → homography to a 660×340 card (10 px/mm) → white balance per
 * indicator group from its grey + white patch → ΔE of each ROI to the group's printed "Ausgang"/"Ausgelöst" patch.
 * Because a 6.5 mm marker extrapolates poorly over 66 mm, the homography is refined once from printed anchors
 * (humidity dot, blue/black patches) and the QR code's corners when they agree with the marker.
 */
export function readCard(cv: CV, frame: FrameLike, cfg: HeatFieldsConfig, opts: { preview?: boolean; debug?: boolean } = {}): CardReading {
  const t0 = now();
  const log: string[] = [];
  const dbg = (...a: unknown[]) => { if (opts.debug) log.push(a.map((x) => (typeof x === "number" ? x.toFixed(1) : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  const S = cfg.px_per_mm;
  const W = Math.round(CARD_W_MM * S), Hh = Math.round(CARD_H_MM * S);
  const trash: CV[] = [];
  const keep = <T,>(m: T): T => { trash.push(m); return m; };
  const mmToPx = (p: Pt): Pt => [p[0] * S, p[1] * S];
  try {
    const src = keep(cv.matFromImageData({ data: frame.data, width: frame.width, height: frame.height }));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 1. ArUco
    const dict = keep(cv.getPredefinedDictionary(cv.DICT_4X4_50));
    const params = keep(new cv.aruco_DetectorParameters());
    if (typeof cv.CORNER_REFINE_SUBPIX === "number") params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
    const refine = keep(new cv.aruco_RefineParameters(10, 3, true));
    const detector = keep(new cv.aruco_ArucoDetector(dict, params, refine));
    const corners = keep(new cv.MatVector()), ids = keep(new cv.Mat()), rejected = keep(new cv.MatVector());
    detector.detectMarkers(gray, corners, ids, rejected);
    const idList: number[] = Array.from(ids.data32S ?? []);
    const idx = idList.indexOf(ARUCO_ID);
    if (idx < 0 && cfg.frame) return readCardFrame(cv, src, gray, cfg, opts, t0, log, dbg);
    if (idx < 0) return notFound(idList.length ? `Marker ${idList.join(",")} found, but not ID ${ARUCO_ID}` : "Card not detected", t0);
    const cm = corners.get(idx);
    const c: number[] = Array.from(cm.data32F);
    cm.delete();
    const markerImg: Pt[] = [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]];
    const markerPx = [0, 1, 2, 3].reduce((a, i) => a + Math.hypot(markerImg[(i + 1) % 4][0] - markerImg[i][0], markerImg[(i + 1) % 4][1] - markerImg[i][1]), 0) / 4;

    // 2. coarse homography (marker, + QR if consistent)
    let srcPts: Pt[] = [...markerImg];
    let dstPts: Pt[] = markerCornersMm(cfg).map(mmToPx);
    let qrUsed = false;
    let H = keep(homography(cv, srcPts, dstPts));
    dbg("marker img", markerImg.map((p) => p.map(Math.round)), "H0", Array.from(H.data64F as Float64Array).map((v) => +v.toFixed(5)));
    try {
      const qr = keep(new cv.QRCodeDetector());
      const pts = keep(new cv.Mat());
      const ok = qr.detect(gray, pts);
      if (ok && pts.rows * pts.cols === 4) {
        const q: number[] = Array.from(pts.data32F);
        const qrImg: Pt[] = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
        // Local plausibility (independent of perspective extrapolation): size ratio and offset along the marker's x-axis.
        const qrMm = qrCornersMm(cfg), mkMm = markerCornersMm(cfg);
        const centre = (p: Pt[]): Pt => [p.reduce((a, v) => a + v[0], 0) / 4, p.reduce((a, v) => a + v[1], 0) / 4];
        const cm = centre(markerImg), cq = centre(qrImg);
        const qrPx = [0, 1, 2, 3].reduce((a, i) => a + Math.hypot(qrImg[(i + 1) % 4][0] - qrImg[i][0], qrImg[(i + 1) % 4][1] - qrImg[i][1]), 0) / 4;
        const expRatio = (qrMm[1][0] - qrMm[0][0]) / cfg.aruco.size;
        const xAxis: Pt = [(markerImg[1][0] - markerImg[0][0]) / markerPx, (markerImg[1][1] - markerImg[0][1]) / markerPx];
        const yAxis: Pt = [(markerImg[3][0] - markerImg[0][0]) / markerPx, (markerImg[3][1] - markerImg[0][1]) / markerPx];
        const dx = ((cq[0] - cm[0]) * xAxis[0] + (cq[1] - cm[1]) * xAxis[1]) / markerPx; // in marker units
        const dy = ((cq[0] - cm[0]) * yAxis[0] + (cq[1] - cm[1]) * yAxis[1]) / markerPx;
        const [emx, emy] = centre(mkMm), [eqx, eqy] = centre(qrMm);
        const expDx = (eqx - emx) / cfg.aruco.size, expDy = (eqy - emy) / cfg.aruco.size;
        const okRatio = Math.abs(qrPx / markerPx - expRatio) < 0.12;
        const okPos = Math.hypot(dx - expDx, dy - expDy) < 0.2;
        dbg("qr ratio", qrPx / markerPx, "exp", expRatio, "offset", [dx, dy], "exp", [expDx, expDy], okRatio && okPos ? "USE" : "reject");
        if (okRatio && okPos) {
          srcPts.push(...qrImg);
          dstPts.push(...qrMm.map(mmToPx));
          qrUsed = true;
          H = keep(homography(cv, srcPts, dstPts));
        }
      }
    } catch { /* QR is optional */ }

    // 3. refine from printed anchors across the card: stage 0 = humidity dot (wide window), stages 1–2 = dot + patches
    const anchors: string[] = [];
    const warped = keep(new cv.Mat());
    const whiteRect = patchRectsMm(cfg, "heat")[3]; // heat group's white patch, close to the marker → reliable even before refinement
    for (let round = 0; round < 3; round++) {
      cv.warpPerspective(src, warped, H, new cv.Size(W, Hh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
      const dark = darknessMap(cv, warped);
      const wRgb = meanRect(cv, warped, whiteRect, S);
      const thresh = Math.min(200, 255 - Math.min(wRgb[0], wRgb[1], wRgb[2]) + 45); // relative to the card's white under this light
      const hi = invert(cv, H);
      const foundSrc: Pt[] = [], foundDst: Pt[] = [], names: string[] = [];
      for (const f of anchorFeaturesMm(cfg, round === 0 ? 0 : 1)) {
        const [ex, ey] = mmToPx(f.mm);
        const pt = f.name === "hum-dot" && round === 0
          ? locateDot(cv, dark, ex, ey, f.areaMm2 * S * S, thresh)
          : locateBlob(cv, dark, ex, ey, f.windowMm * S, f.areaMm2 * S * S, thresh);
        dbg("round", round, f.name, "expected", [ex, ey], "found", pt ? pt.map((v) => +v.toFixed(1)) : null, pt ? ["src", applyH(hi, pt).map((v) => +v.toFixed(1))] : "");
        if (!pt) continue;
        foundSrc.push(applyH(hi, pt));
        foundDst.push([ex, ey]);
        names.push(f.name);
      }
      dark.delete();
      if (foundSrc.length === 0) break;
      const H2 = homography(cv, [...srcPts, ...foundSrc], [...dstPts, ...foundDst]);
      keep(H2);
      H = H2;
      dbg("round", round, "H", Array.from(H.data64F as Float64Array).map((v) => +v.toFixed(5)));
      anchors.splice(0, anchors.length, ...names);
    }
    cv.warpPerspective(src, warped, H, new cv.Size(W, Hh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));

    // 4. reference patches + white balance per group
    const patches = (group: "heat" | "hum"): PatchSet => {
      const [intact, triggered, grey, white] = patchRectsMm(cfg, group).map((r) => meanRect(cv, warped, r, S));
      return { intact, triggered, grey, white };
    };
    const heatP = patches("heat"), humP = patches("hum");
    const wbHeat = makeWhiteBalance(heatP.grey, heatP.white), wbHum = makeWhiteBalance(humP.grey, humP.white);

    // 5. heat: six ROIs from heat_fields.json
    const heatFields: FieldReading[] = cfg.fields.map((f) => {
      const rgb = meanRect(cv, warped, f.roi_mm, S);
      return { rgb, ...classify(wbHeat.apply(rgb), wbHeat.apply(heatP.intact), wbHeat.apply(heatP.triggered)) };
    });
    const decisiveIdx = cfg.fields.findIndex((f) => f.decisive);
    const decisive = heatFields[decisiveIdx >= 0 ? decisiveIdx : HEAT_DECISIVE_INDEX];
    const heat = decisive.confidence < CONFIDENCE_THRESHOLD ? Indicator.UNREADABLE : decisive.level;

    // 6. humidity: circle ROI (inner 60 %)
    const hm = cfg.humidity_mm;
    const humRgb = meanCircle(cv, warped, hm.cx * S, hm.cy * S, hm.roi_r * S);
    const humidityField: FieldReading = { rgb: humRgb, ...classify(wbHum.apply(humRgb), wbHum.apply(humP.intact), wbHum.apply(humP.triggered)) };
    const humidity = humidityField.confidence < CONFIDENCE_THRESHOLD ? Indicator.UNREADABLE : humidityField.level;

    let preview: FrameLike | null = null;
    if (opts.preview) preview = { data: new Uint8ClampedArray(warped.data), width: W, height: Hh };

    return {
      found: true,
      heatLevels: heatFields.map((f) => f.level),
      heatFields, heat, humidity, humidityField, uv: 3,
      confidence: { heat: decisive.confidence, humidity: humidityField.confidence },
      quality: {
        markerPx, qrUsed, anchors, mode: "marker",
        groups: {
          heat: { greyL: rgbToLab(heatP.grey)[0], whiteL: rgbToLab(heatP.white)[0], ok: wbHeat.ok },
          hum: { greyL: rgbToLab(humP.grey)[0], whiteL: rgbToLab(humP.white)[0], ok: wbHum.ok },
        },
      },
      homography: Array.from(H.data64F),
      warped: preview,
      ms: now() - t0,
      debug: opts.debug ? log : undefined,
    };
  } finally {
    for (const m of trash) { try { m.delete(); } catch { /* embind objects without delete */ } }
  }
}


function meanAnnulus(cv: CV, mat: CV, cx: number, cy: number, r0: number, r1: number): Rgb {
  const mask = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
  cv.circle(mask, new cv.Point(Math.round(cx), Math.round(cy)), Math.max(1, Math.round(r1)), new cv.Scalar(255), -1);
  cv.circle(mask, new cv.Point(Math.round(cx), Math.round(cy)), Math.max(1, Math.round(r0)), new cv.Scalar(0), -1);
  const m = cv.mean(mat, mask);
  mask.delete();
  return [m[0], m[1], m[2]];
}

/**
 * Physical Rev C card in its holder: the holder window (62.5 × 30.5 mm) is the fiducial. Homography from its four
 * corners, refined once with the humidity ring; white balance from the card's white and the ring's black; ROIs and
 * reference colours from cfg.frame / cfg.reference_colors.
 */
function readCardFrame(cv: CV, src: CV, gray: CV, cfg: HeatFieldsConfig, opts: { preview?: boolean; debug?: boolean }, t0: number, log: string[], dbg: (...a: unknown[]) => void): CardReading {
  const fr = cfg.frame!;
  const S = cfg.px_per_mm;
  const W = Math.round(CARD_W_MM * S), Hh = Math.round(CARD_H_MM * S);
  const mmToPx = (p: Pt): Pt => [p[0] * S, p[1] * S];
  const trash: CV[] = [];
  const keep = <T,>(m: T): T => { trash.push(m); return m; };
  try {
    const win = fr.window_mm;
    const quad = detectCardQuad(cv, gray, win.w / win.h, dbg);
    if (!quad) return notFound("Card not detected (no card window in frame)", t0);
    const winPx = (Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1])) / 2;
    const dstWin: Pt[] = [[win.x, win.y], [win.x + win.w, win.y], [win.x + win.w, win.y + win.h], [win.x, win.y + win.h]];
    let srcPts: Pt[] = [...quad], dstPts: Pt[] = dstWin.map(mmToPx);
    let H = keep(homography(cv, srcPts, dstPts));
    const warped = keep(new cv.Mat());
    const anchors: string[] = [];
    // The card sits ~1.8 mm below the holder's top face, so at oblique angles the window outline is parallax-shifted
    // against the card. Refine on a feature that lies ON the card: the blue heat label (its window rectangle), whose
    // four corners fully determine the homography. Two rounds: from the coarse warp, then from the refined one.
    for (let round = 0; round < 2; round++) {
      cv.warpPerspective(src, warped, H, new cv.Size(W, Hh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
      const hi = invert(cv, H);
      const onCardSrc: Pt[] = [], onCardDst: Pt[] = [];
      const names: string[] = [];
      const strip = locateStripQuad(cv, warped, fr.strip_mm, S, dbg);
      if (strip) {
        const sm = fr.strip_mm;
        const dst: Pt[] = [[sm.x, sm.y], [sm.x + sm.w, sm.y], [sm.x + sm.w, sm.y + sm.h], [sm.x, sm.y + sm.h]];
        strip.forEach((p, i) => { onCardSrc.push(applyH(hi, p)); onCardDst.push(mmToPx(dst[i])); });
        names.push("heat-label");
      }
      // (the humidity ring is NOT used as an anchor: the card window's shadow rim merges with it and biases the centre)
      if (onCardSrc.length === 0) break;
      // ≥ 4 on-card points: use them alone (parallax-free); fewer: add them to the window corners
      const useSrc = onCardSrc.length >= 4 ? onCardSrc : [...quad, ...onCardSrc];
      const useDst = onCardSrc.length >= 4 ? onCardDst : [...dstWin.map(mmToPx), ...onCardDst];
      H = keep(homography(cv, useSrc, useDst));
      srcPts = useSrc; dstPts = useDst;
      anchors.splice(0, anchors.length, ...names);
      dbg("round", round, "anchors", names.join("+"), "H", Array.from(H.data64F as Float64Array).map((v) => +v.toFixed(5)));
    }
    cv.warpPerspective(src, warped, H, new cv.Size(W, Hh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
    // references: card white + ring black → two-point balance per channel (black target = #111111)
    const white = meanRect(cv, warped, fr.white_ref_mm, S);
    const black = meanAnnulus(cv, warped, fr.black_ref.cx * S, fr.black_ref.cy * S, fr.black_ref.r0 * S, fr.black_ref.r1 * S);
    const wb = makeWhiteBalance(black, white, { grey: 17, white: 255 });
    const ref = (k: string): Rgb => hexToRgb(fr.reference_colors?.[k] ?? cfg.reference_colors[k]);
    dbg("white", white.map(Math.round), "black", black.map(Math.round), "wb ok", wb.ok ? 1 : 0);

    const heatFields: FieldReading[] = fr.fields.map((f) => {
      const rgb = meanRect(cv, warped, f.roi_mm, S);
      return { rgb, ...classify(wb.apply(rgb), ref("heat_intact"), ref("heat_triggered")) };
    });
    const decisiveIdx = fr.fields.findIndex((f) => f.decisive);
    const decisive = heatFields[decisiveIdx >= 0 ? decisiveIdx : HEAT_DECISIVE_INDEX];
    const heat = decisive.confidence < CONFIDENCE_THRESHOLD ? Indicator.UNREADABLE : decisive.level;

    const hm = fr.humidity_mm;
    const humRgb = meanCircle(cv, warped, hm.cx * S, hm.cy * S, hm.roi_r * S);
    const humidityField: FieldReading = { rgb: humRgb, ...classify(wb.apply(humRgb), ref("humidity_intact"), ref("humidity_triggered")) };
    const humidity = humidityField.confidence < CONFIDENCE_THRESHOLD ? Indicator.UNREADABLE : humidityField.level;

    const uvRgb = meanRect(cv, warped, fr.uv_mm, S);
    const uvField: FieldReading = { rgb: uvRgb, ...classify(wb.apply(uvRgb), ref("uv_intact"), ref("uv_triggered")) };
    const uv = uvField.confidence < CONFIDENCE_THRESHOLD ? Indicator.UNREADABLE : uvField.level;
    dbg("heat", heatFields.map((f) => [f.level, +f.confidence.toFixed(2), f.rgb.map(Math.round)]), "hum", [humidityField.level, +humidityField.confidence.toFixed(2), humRgb.map(Math.round)], "uv", [uvField.level, +uvField.confidence.toFixed(2), uvRgb.map(Math.round)]);

    let preview: FrameLike | null = null;
    if (opts.preview) preview = { data: new Uint8ClampedArray(warped.data), width: W, height: Hh };
    return {
      found: true,
      heatLevels: heatFields.map((f) => f.level),
      heatFields, heat, humidity, humidityField, uv, uvField,
      confidence: { heat: decisive.confidence, humidity: humidityField.confidence },
      quality: {
        markerPx: winPx, qrUsed: false, anchors, mode: "frame",
        groups: { heat: { greyL: rgbToLab(black)[0], whiteL: rgbToLab(white)[0], ok: wb.ok }, hum: { greyL: rgbToLab(black)[0], whiteL: rgbToLab(white)[0], ok: wb.ok } },
      },
      homography: Array.from(H.data64F),
      warped: preview,
      ms: now() - t0,
      debug: opts.debug ? log : undefined,
    };
  } finally {
    for (const m of trash) { try { m.delete(); } catch { /* ignore */ } }
  }
}

/**
 * The saturated blue heat label seen through its window in the warped card: HSV mask (hue 190–230°, sat > 0.45),
 * largest blob near the expected rectangle, min-area rectangle → 4 corners (TL,TR,BR,BL in warped px).
 */
function locateStripQuad(cv: CV, warped: CV, expect: RoiMm, S: number, dbg?: (...a: unknown[]) => void): Pt[] | null {
  const rgb = new cv.Mat(), hsv = new cv.Mat(), mask = new cv.Mat();
  cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV); // H 0..180
  const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [95, 115, 60, 0]), hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [118, 255, 255, 0]);
  cv.inRange(hsv, lo, hi, mask);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const expArea = expect.w * expect.h * S * S, ecx = (expect.x + expect.w / 2) * S, ecy = (expect.y + expect.h / 2) * S;
  let best: { pts: Pt[]; score: number } | null = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area > 0.45 * expArea && area < 1.6 * expArea) {
      const rr = cv.minAreaRect(c);
      const w = Math.max(rr.size.width, rr.size.height), h = Math.min(rr.size.width, rr.size.height);
      const ar = w / Math.max(1, h), expAr = Math.max(expect.w, expect.h) / Math.min(expect.w, expect.h);
      const d = Math.hypot(rr.center.x - ecx, rr.center.y - ecy) / S;
      const score = Math.abs(ar - expAr) / expAr + d / 10 + Math.abs(area - expArea) / expArea;
      dbg?.("strip cand", "area", area / expArea, "ar", ar, "d mm", d, "score", score);
      if (Math.abs(ar - expAr) / expAr < 0.2 && d < 6 && (!best || score < best.score)) {
        const ang = (rr.angle * Math.PI) / 180, cs = Math.cos(ang), sn = Math.sin(ang);
        const hw = rr.size.width / 2, hh = rr.size.height / 2;
        const pts = ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(([x, y]) => [rr.center.x + x * cs - y * sn, rr.center.y + x * sn + y * cs] as Pt);
        // order TL,TR,BR,BL
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
        const tl = pts.filter((p) => p[0] < cx && p[1] < cy)[0], tr = pts.filter((p) => p[0] >= cx && p[1] < cy)[0];
        const br = pts.filter((p) => p[0] >= cx && p[1] >= cy)[0], bl = pts.filter((p) => p[0] < cx && p[1] >= cy)[0];
        if (tl && tr && br && bl) best = { pts: [tl, tr, br, bl], score };
      }
    }
    c.delete();
  }
  rgb.delete(); hsv.delete(); mask.delete(); lo.delete(); hi.delete(); k.delete(); contours.delete(); hier.delete();
  dbg?.("strip", best ? best.pts.map((p) => p.map((v) => +v.toFixed(1))) : null);
  return best?.pts ?? null;
}
