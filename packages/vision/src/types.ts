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
  /** Physical Rev C card in its 3D-printed holder: the holder's window outline is the fiducial (no marker, no patches). */
  frame?: FrameLayout;
}
export interface FrameLayout {
  /** the visible card rectangle (holder window) in card mm, origin = card top-left */
  window_mm: RoiMm;
  /** the blue heat label as seen through its window (on the card plane; used as the main anchor) */
  strip_mm: RoiMm;
  /** per-layout overrides of reference_colors (e.g. this card's humidity dot colours) */
  reference_colors?: Record<string, string>;
  /** plain white card area used as the white reference */
  white_ref_mm: RoiMm;
  /** black reference: the printed ring around the humidity dot (annulus r0..r1 around its centre) */
  black_ref: { cx: number; cy: number; r0: number; r1: number };
  /** humidity dot centre and the radius of the sampled disc (the black ring around the dot is black_ref) */
  humidity_mm: { cx: number; cy: number; roi_r: number };
  uv_mm: RoiMm;
  fields: Array<{ index: number; temp_c: number; decisive: boolean; roi_mm: RoiMm }>;
}

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

export interface PatchSet { intact: Rgb; triggered: Rgb; grey: Rgb; white: Rgb }

export interface FieldReading {
  level: 0 | 1; confidence: number; dIntact: number; dTriggered: number; rgb: Rgb;
  /** frame mode: share of the region's pixels that are sensor-clipped (darkest channel ≥ GLARE_CLIP_LEVEL) */
  clipped?: number;
  /** frame mode: clipped > GLARE_MAX_FRACTION, i.e. a highlight hides the region's colour; its confidence is then 0 */
  glare?: boolean;
}

export interface CardReading {
  /** a card was located (marker or holder window); its indicators may still be UNREADABLE */
  found: boolean;
  /** why the card was not found, or why an indicator is UNREADABLE (missing heat label, failed white balance, …) */
  reason?: string;
  /**
   * six 0/1 fields (29/33/34/37/40/42 °C), nearest reference per field. All zero unless heat is INTACT or TRIGGERED,
   * so a guessed 40 °C field never reaches the chain; the per-field measurements stay in heatFields.
   */
  heatLevels: number[];
  heatFields: FieldReading[];
  /** indicator codes (proof enums): 0 INTACT · 1 TRIGGERED · 2 UNREADABLE · 3 MISSING */
  heat: number;
  humidity: number;
  humidityField: FieldReading | null;
  /** 0 INTACT · 1 TRIGGERED · 2 UNREADABLE · 3 MISSING (3 unless the layout carries a UV field) */
  uv: number;
  uvField?: FieldReading | null;
  confidence: { heat: number; humidity: number };
  quality: { markerPx: number; qrUsed: boolean; anchors: string[]; groups: Record<"heat" | "hum", { greyL: number; whiteL: number; ok: boolean }>; mode?: "marker" | "frame" };
  homography: number[] | null;
  /** 660×340 RGBA card image when opts.preview is set */
  warped: FrameLike | null;
  ms: number;
  debug?: string[];
  /**
   * set by combineReadings: frames captured, frames that voted (card found and, in frame mode, anchored on its heat
   * label), and how many of the voters agree with each combined verdict
   */
  votes?: { frames: number; found: number; heat: number; humidity: number; uv: number };
}
