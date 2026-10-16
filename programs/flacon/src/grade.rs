//! Grade rule (briefing §4.5). Identical logic lives in `packages/proof/src/grade.ts`;
//! the unit test below checks this implementation against `docs/vectors.json` `grades[]`.
//!
//! ```text
//! VOID  if server.verdict != VALID or tamper ∈ {OPENED_NOW, OPENED_BEFORE} or seal dead
//! C     else if heat == TRIGGERED or hum == TRIGGERED
//! A     else if fill ≥ 90
//! B     else if fill ≥ 60
//! D     otherwise
//! UNREADABLE never lowers the grade (it only sets an off-chain "review recommended" flag).
//! ```
//!
//! Passport grade after a scan (`passport_after_scan`): only the irreversible states are sticky.
//!
//! ```text
//! VOID  if the passport is void or VOID already, or the scan reports an opened seal (sets passport.void)
//! C     else if the passport is C already, or the scan has heat/humidity TRIGGERED
//! A/B/D else from the latest scan's fill level
//! ```
//!
//! A heat or humidity indicator cannot un-trigger and an opened seal cannot close again, so a later scan
//! (for example one without a photo, whose indicators are MISSING) never erases C or VOID. The fill level
//! is different: it is a reading that the person scanning sets with a slider, no tier verifies it, and a
//! bottle is only ever emptied, never refilled. Taking A/B/D from the latest scan means one mistaken or
//! malicious low reading (a visitor scanning at tier 1 with the slider at 0) is corrected by the next
//! honest scan instead of degrading the passport for good. A C bottle stays C at any fill level, so the
//! heat-damage marker is never replaced by D.

use anchor_lang::prelude::*;

use crate::constants::*;

/// `fill >= GRADE_FILL_A_MIN` → A
#[constant]
pub const GRADE_FILL_A_MIN: u8 = 90;
/// `fill >= GRADE_FILL_B_MIN` → B
#[constant]
pub const GRADE_FILL_B_MIN: u8 = 60;

/// Grade of a scan the program is about to accept. The server only signs `VALID`
/// verdicts and `record_scan` rejects dead seals before it gets here, so the
/// verdict and seal-dead branches of the rule are implicitly satisfied.
pub fn grade(tamper: u8, heat: u8, hum: u8, fill: u8) -> u8 {
    if is_opened(tamper) {
        return GRADE_VOID;
    }
    if is_triggered(heat, hum) {
        return GRADE_C;
    }
    grade_from_fill(fill)
}

/// A / B / D from the fill level alone.
pub fn grade_from_fill(fill: u8) -> u8 {
    if fill >= GRADE_FILL_A_MIN {
        GRADE_A
    } else if fill >= GRADE_FILL_B_MIN {
        GRADE_B
    } else {
        GRADE_D
    }
}

/// `true` when the tamper code says the seal was opened (now or before).
pub fn is_opened(tamper: u8) -> bool {
    tamper == TAMPER_OPENED_NOW || tamper == TAMPER_OPENED_BEFORE
}

/// `true` when the heat or the humidity indicator has triggered (irreversible).
pub fn is_triggered(heat: u8, hum: u8) -> bool {
    heat == INDICATOR_TRIGGERED || hum == INDICATOR_TRIGGERED
}

/// Passport `(grade, void)` after accepting a scan (see the module docs): VOID and C are sticky, A/B/D
/// follow the latest scan's fill level. An opened seal or a VOID grade makes the passport void for good.
pub fn passport_after_scan(old_grade: u8, old_void: bool, tamper: u8, heat: u8, hum: u8, fill: u8) -> (u8, bool) {
    if old_void || old_grade == GRADE_VOID || is_opened(tamper) {
        return (GRADE_VOID, true);
    }
    if old_grade == GRADE_C || is_triggered(heat, hum) {
        return (GRADE_C, false);
    }
    (grade_from_fill(fill), false)
}

/// Full rule including the off-chain flags — used by tests and off-chain readers.
pub fn grade_with_flags(
    verdict_valid: bool,
    seal_dead: bool,
    tamper: u8,
    heat: u8,
    hum: u8,
    fill: u8,
) -> u8 {
    if !verdict_valid || seal_dead {
        return GRADE_VOID;
    }
    grade(tamper, heat, hum, fill)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/vectors.json");
        let raw = std::fs::read_to_string(path).expect("docs/vectors.json");
        serde_json::from_str(&raw).expect("valid json")
    }

    fn u8_of(v: &serde_json::Value) -> u8 {
        v.as_u64().expect("u8 field") as u8
    }

    #[test]
    fn grade_table_matches_vectors() {
        let v = vectors();
        let rows = v["grades"].as_array().expect("grades[]");
        assert_eq!(rows.len(), 18, "vectors.grades has 18 rows");
        for row in rows {
            let valid = row["verdict"] == "VALID";
            let dead = row["sealDead"].as_bool().unwrap_or(false);
            let expected = u8_of(&row["grade"]);
            let got = grade_with_flags(
                valid,
                dead,
                u8_of(&row["tamper"]),
                u8_of(&row["heat"]),
                u8_of(&row["hum"]),
                u8_of(&row["fill"]),
            );
            assert_eq!(got, expected, "row {row}");
            if valid && !dead {
                // the on-chain path (no flags) must agree
                assert_eq!(
                    grade(
                        u8_of(&row["tamper"]),
                        u8_of(&row["heat"]),
                        u8_of(&row["hum"]),
                        u8_of(&row["fill"])
                    ),
                    expected,
                    "on-chain grade for row {row}"
                );
            } else {
                assert_eq!(expected, GRADE_VOID);
            }
        }
    }

    #[test]
    fn scan_vectors_grade() {
        let v = vectors();
        for s in v["scans"].as_array().expect("scans[]") {
            let i = &s["input"];
            let got = grade(
                u8_of(&i["tamper"]),
                u8_of(&i["heat"]),
                u8_of(&i["hum"]),
                u8_of(&i["fill"]),
            );
            assert_eq!(got, u8_of(&s["grade"]), "scan {}", s["name"]);
        }
    }

    #[test]
    fn thresholds() {
        assert_eq!(grade(TAMPER_UNKNOWN, 0, 0, 100), GRADE_A);
        assert_eq!(grade(TAMPER_UNKNOWN, 0, 0, 90), GRADE_A);
        assert_eq!(grade(TAMPER_UNKNOWN, 0, 0, 89), GRADE_B);
        assert_eq!(grade(TAMPER_UNKNOWN, 0, 0, 60), GRADE_B);
        assert_eq!(grade(TAMPER_UNKNOWN, 0, 0, 59), GRADE_D);
        assert_eq!(grade(TAMPER_UNKNOWN, 0, 0, 0), GRADE_D);
        assert_eq!(grade(TAMPER_UNKNOWN, INDICATOR_TRIGGERED, 0, 100), GRADE_C);
        assert_eq!(grade(TAMPER_UNKNOWN, 0, INDICATOR_TRIGGERED, 100), GRADE_C);
        // UNREADABLE / MISSING never lower the grade
        assert_eq!(grade(TAMPER_UNKNOWN, INDICATOR_UNREADABLE, INDICATOR_MISSING, 95), GRADE_A);
        assert_eq!(grade(TAMPER_OPENED_NOW, 0, 0, 100), GRADE_VOID);
        assert_eq!(grade(TAMPER_OPENED_BEFORE, 0, 0, 100), GRADE_VOID);
        assert_eq!(grade(TAMPER_CLOSED, 0, 0, 100), GRADE_A);
        assert_eq!(grade_with_flags(false, false, TAMPER_UNKNOWN, 0, 0, 100), GRADE_VOID);
        assert_eq!(grade_with_flags(true, true, TAMPER_UNKNOWN, 0, 0, 100), GRADE_VOID);
    }

    #[test]
    fn heat_c_is_sticky_fill_follows_the_latest_scan() {
        // heat TRIGGERED → C; a later scan without photo (indicators MISSING, fill 95) keeps C
        let (g, v) = passport_after_scan(GRADE_A, false, TAMPER_UNKNOWN, INDICATOR_TRIGGERED, INDICATOR_INTACT, 95);
        assert_eq!((g, v), (GRADE_C, false));
        let (g, v) = passport_after_scan(g, v, TAMPER_UNKNOWN, INDICATOR_MISSING, INDICATOR_MISSING, 95);
        assert_eq!((g, v), (GRADE_C, false));
        let (g, v) = passport_after_scan(g, v, TAMPER_UNKNOWN, INDICATOR_UNREADABLE, INDICATOR_INTACT, 100);
        assert_eq!((g, v), (GRADE_C, false));
        // a low fill never replaces the heat-damage marker C with D
        assert_eq!(passport_after_scan(GRADE_C, false, TAMPER_UNKNOWN, 0, 0, 0), (GRADE_C, false));
        // humidity counts like heat
        assert_eq!(passport_after_scan(GRADE_A, false, TAMPER_UNKNOWN, INDICATOR_INTACT, INDICATOR_TRIGGERED, 95), (GRADE_C, false));
        // a D bottle that is then heat-damaged becomes C
        assert_eq!(passport_after_scan(GRADE_D, false, TAMPER_UNKNOWN, INDICATOR_TRIGGERED, 0, 10), (GRADE_C, false));
    }

    #[test]
    fn one_low_fill_reading_is_corrected_by_the_next_scan() {
        // a tier-1 scan with the slider at 0 (griefing, or a slip) → D …
        let (g, v) = passport_after_scan(GRADE_A, false, TAMPER_UNKNOWN, INDICATOR_MISSING, INDICATOR_MISSING, 0);
        assert_eq!((g, v), (GRADE_D, false));
        // … and the next honest scan at fill 95 brings the passport back to A
        assert_eq!(passport_after_scan(g, v, TAMPER_UNKNOWN, INDICATOR_INTACT, INDICATOR_INTACT, 95), (GRADE_A, false));
        // A/B/D follow the latest fill level in both directions
        assert_eq!(passport_after_scan(GRADE_A, false, TAMPER_UNKNOWN, 0, 0, 70), (GRADE_B, false));
        assert_eq!(passport_after_scan(GRADE_B, false, TAMPER_UNKNOWN, 0, 0, 95), (GRADE_A, false));
        assert_eq!(passport_after_scan(GRADE_B, false, TAMPER_UNKNOWN, 0, 0, 59), (GRADE_D, false));
        assert_eq!(passport_after_scan(GRADE_D, false, TAMPER_UNKNOWN, 0, 0, 60), (GRADE_B, false));
    }

    #[test]
    fn opened_seal_voids_for_good() {
        for t in [TAMPER_OPENED_NOW, TAMPER_OPENED_BEFORE] {
            assert_eq!(passport_after_scan(GRADE_A, false, t, 0, 0, 100), (GRADE_VOID, true));
            assert_eq!(passport_after_scan(GRADE_C, false, t, 0, 0, 100), (GRADE_VOID, true));
        }
        // a legacy passport with grade VOID but void=false becomes void, and never recovers
        assert_eq!(passport_after_scan(GRADE_VOID, false, TAMPER_CLOSED, 0, 0, 100), (GRADE_VOID, true));
        assert_eq!(passport_after_scan(GRADE_A, true, TAMPER_CLOSED, 0, 0, 100), (GRADE_VOID, true));
        assert!(!is_opened(TAMPER_UNKNOWN) && !is_opened(TAMPER_CLOSED));
        assert_eq!(grade_from_fill(90), GRADE_A);
        assert_eq!(grade_from_fill(89), GRADE_B);
        assert_eq!(grade_from_fill(60), GRADE_B);
        assert_eq!(grade_from_fill(59), GRADE_D);
    }
}
