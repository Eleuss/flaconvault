import { ActorKind, FILL_NONE, Grade, Indicator, Tamper, Verdict, type GradeCode } from "./enums.ts";

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

export interface PassportGrade { grade: number; void: boolean }
export interface GradeFields { tamper: number; heat: number; hum: number; fill: number }

const isOpened = (tamper: number) => tamper === Tamper.OPENED_NOW || tamper === Tamper.OPENED_BEFORE;
const isTriggered = (heat: number, hum: number) => heat === Indicator.TRIGGERED || hum === Indicator.TRIGGERED;
const gradeFromFill = (fill: number) => (fill >= 90 ? Grade.A : fill >= 60 ? Grade.B : Grade.D);

/**
 * Passport (grade, void) after an accepted v1 scan, mirror of `grade::passport_after_scan` in Rust: VOID and C are
 * sticky, A/B/D follow the latest scan's fill level, an opened seal voids the passport for good.
 */
export function passportAfterScan(old: PassportGrade, f: GradeFields): PassportGrade {
  if (old.void || old.grade === Grade.VOID || isOpened(f.tamper)) return { grade: Grade.VOID, void: true };
  if (old.grade === Grade.C || isTriggered(f.heat, f.hum)) return { grade: Grade.C, void: false };
  return { grade: gradeFromFill(f.fill), void: false };
}

/**
 * v2 rule (docs/public-record.md §7.7, Rust `passport_after_scan_v2`): like v1, except that a scan without a fill
 * reading (FILL_NONE) leaves A/B/D unchanged. Apply it only when `actorChangesGrade(actorKind)`.
 */
export function passportAfterScanV2(old: PassportGrade, f: GradeFields): PassportGrade {
  if (f.fill !== FILL_NONE) return passportAfterScan(old, f);
  if (old.void || old.grade === Grade.VOID || isOpened(f.tamper)) return { grade: Grade.VOID, void: true };
  if (old.grade === Grade.C || isTriggered(f.heat, f.hum)) return { grade: Grade.C, void: false };
  return { grade: old.grade, void: false };
}

/** Only HOLDER, WALLET and PARTNER scans change grade and void; NONE (a visitor) and RECIPIENT are evidence only. */
export function actorChangesGrade(actorKind: number): boolean {
  return actorKind === ActorKind.HOLDER || actorKind === ActorKind.WALLET || actorKind === ActorKind.PARTNER;
}

/** Six 0/1 fields → u8 bitmask, bit i = heatLevels[i]. */
export function heatLevelsToMask(levels: readonly number[]): number {
  if (levels.length !== 6) throw new Error("heatLevels must have 6 entries");
  return levels.reduce((m, v, i) => (v ? m | (1 << i) : m), 0);
}
export function maskToHeatLevels(mask: number): number[] {
  return Array.from({ length: 6 }, (_, i) => (mask >> i) & 1);
}
