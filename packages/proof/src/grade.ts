import { Grade, Indicator, Tamper, Verdict, type GradeCode } from "./enums.ts";

export interface GradeInput {
  verdict: string;     // server.verdict
  tamper: number;
  heat: number;        // indicator code of the 40 °C field
  hum: number;         // indicator code of the 60 % point
  fill: number;        // 0..100
  sealDead?: boolean;  // SEAL_DEAD event exists
}
export interface GradeResult { grade: GradeCode; reviewRecommended: boolean }

/**
 * Briefing §4.5. Identical constants live in programs/flacon (Rust); tests compare via docs/vectors.json.
 *   VOID  if verdict != VALID or tamper ∈ {OPENED_NOW, OPENED_BEFORE} or seal dead
 *   C     else if heat == TRIGGERED or humidity == TRIGGERED
 *   A     else if fill ≥ 90
 *   B     else if fill ≥ 60
 *   D     otherwise
 *   UNREADABLE never lowers the grade; it sets reviewRecommended.
 */
export function computeGrade(i: GradeInput): GradeResult {
  const reviewRecommended = i.heat === Indicator.UNREADABLE || i.hum === Indicator.UNREADABLE;
  if (i.verdict !== Verdict.VALID || i.tamper === Tamper.OPENED_NOW || i.tamper === Tamper.OPENED_BEFORE || i.sealDead)
    return { grade: Grade.VOID, reviewRecommended };
  if (i.heat === Indicator.TRIGGERED || i.hum === Indicator.TRIGGERED) return { grade: Grade.C, reviewRecommended };
  if (i.fill >= 90) return { grade: Grade.A, reviewRecommended };
  if (i.fill >= 60) return { grade: Grade.B, reviewRecommended };
  return { grade: Grade.D, reviewRecommended };
}

/** Six 0/1 fields → u8 bitmask, bit i = heatLevels[i]. */
export function heatLevelsToMask(levels: readonly number[]): number {
  if (levels.length !== 6) throw new Error("heatLevels must have 6 entries");
  return levels.reduce((m, v, i) => (v ? m | (1 << i) : m), 0);
}
export function maskToHeatLevels(mask: number): number[] {
  return Array.from({ length: 6 }, (_, i) => (mask >> i) & 1);
}
