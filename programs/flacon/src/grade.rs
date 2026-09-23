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
    if tamper == TAMPER_OPENED_NOW || tamper == TAMPER_OPENED_BEFORE {
        return GRADE_VOID;
    }
    if heat == INDICATOR_TRIGGERED || hum == INDICATOR_TRIGGERED {
        return GRADE_C;
    }
    if fill >= GRADE_FILL_A_MIN {
        return GRADE_A;
    }
    if fill >= GRADE_FILL_B_MIN {
        return GRADE_B;
    }
    GRADE_D
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
}
