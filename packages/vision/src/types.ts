/** The OpenCV.js module object (typed loosely — the 5.x typings do not cover ArUco reliably). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

export interface FrameLike { data: Uint8ClampedArray | Uint8Array; width: number; height: number }

export interface RoiMm { x: number; y: number; w: number; h: number }
export interface HeatFieldsConfig {
  schema: string;
  px_per_mm: number;
  window_mm: RoiMm;
  strip_mm: RoiMm;
  reference_colors: Record<string, string>;
  humidity_mm: { cx: number; cy: number; r: number; roi_r: number };
  aruco: { dict: string; id: number; x: number; y: number; size: number };
  qr: { x: number; y: number; size: number };
  qr_symbol?: { x: number; y: number; size: number; modules: number };
  patches_mm: { size: number; gap: number; y: number; groups: Record<"heat" | "uv" | "hum", number>; order: string[] };
  fields: Array<{ index: number; temp_c: number; decisive: boolean; roi_mm: RoiMm }>;
}

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

export interface PatchSet { intact: Rgb; triggered: Rgb; grey: Rgb; white: Rgb }

export interface FieldReading { level: 0 | 1; confidence: number; dIntact: number; dTriggered: number; rgb: Rgb }

export interface CardReading {
  found: boolean;
  reason?: string;
  /** six 0/1 fields (29/33/34/37/40/42 °C) — nearest reference, regardless of confidence */
  heatLevels: number[];
  heatFields: FieldReading[];
  /** indicator codes (proof enums): 0 INTACT · 1 TRIGGERED · 2 UNREADABLE · 3 MISSING */
  heat: number;
  humidity: number;
  humidityField: FieldReading | null;
  uv: 3;
  confidence: { heat: number; humidity: number };
  quality: { markerPx: number; qrUsed: boolean; anchors: string[]; groups: Record<"heat" | "hum", { greyL: number; whiteL: number; ok: boolean }> };
  homography: number[] | null;
  /** 660×340 RGBA card image when opts.preview is set */
  warped: FrameLike | null;
  ms: number;
  debug?: string[];
}
