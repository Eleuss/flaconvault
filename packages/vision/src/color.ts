import type { Lab, Rgb } from "./types.ts";

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/** sRGB (0..255) → CIE L*a*b* (D65). */
export function rgbToLab([r, g, b]: Rgb): Lab {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.072175) / 1.0;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIE76 colour difference — enough for the coarse contrasts on the card (grey/black, blue/pink). */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
export const clamp255 = (v: number) => Math.max(0, Math.min(255, v));

/**
 * Two-point white balance per indicator group: a linear map per channel that sends the measured
 * grey patch to the printed grey (#767676 = 118) and the white patch to 255.
 */
export function makeWhiteBalance(grey: Rgb, white: Rgb, target = { grey: 118, white: 255 }): { apply: (c: Rgb) => Rgb; ok: boolean } {
  const gains: Array<[number, number]> = [0, 1, 2].map((i) => {
    const span = white[i] - grey[i];
    if (span < 12) return [1, 0]; // degenerate (over/under-exposed): leave channel as is
    const a = (target.white - target.grey) / span;
    return [a, target.grey - a * grey[i]];
  });
  const ok = [0, 1, 2].every((i) => white[i] - grey[i] >= 12);
  return { ok, apply: (c) => [clamp255(gains[0][0] * c[0] + gains[0][1]), clamp255(gains[1][0] * c[1] + gains[1][1]), clamp255(gains[2][0] * c[2] + gains[2][1])] };
}

/** Nearest-reference decision with a margin-based confidence (sigmoid, 0.5 at 6 ΔE margin, ≈0.85 at 9.5). */
export function classify(sample: Rgb, intact: Rgb, triggered: Rgb): { level: 0 | 1; confidence: number; dIntact: number; dTriggered: number } {
  const s = rgbToLab(sample);
  const dIntact = deltaE(s, rgbToLab(intact));
  const dTriggered = deltaE(s, rgbToLab(triggered));
  const margin = Math.abs(dIntact - dTriggered);
  let confidence = 1 / (1 + Math.exp(-(margin - 6) / 2));
  if (Math.min(dIntact, dTriggered) > 35) confidence = Math.min(confidence, 0.3); // far from both references: glare, wrong crop
  return { level: dTriggered < dIntact ? 1 : 0, confidence, dIntact, dTriggered };
}
