"""The verifier's passport grade mirrors record_scan (programs/flacon/src/grade.rs passport_after_scan): VOID is sticky
(void passport, or any scan graded VOID), C is sticky once any scan graded C, otherwise A/B/D follow the latest scan.
The same rule runs on confirmation (service.apply_confirmed_scan → db.set_passport_grade), in the reconcile job's
chain refresh and in purge-seed's recompute, so 'chain wins' never flips a grade back and forth."""
import itertools

import pytest

from fv import proof
from fv.db import set_passport_grade
from fv.enums import VALID, Grade, Indicator, Tamper
from tests.conftest import ADMIN, passport_pda, sig
from tests.test_chain import passport_bytes
from tests.test_stats_grade import MEDIA, SERIAL, _confirm, _verify

A, B, C, D, VOID = Grade.A, Grade.B, Grade.C, Grade.D, Grade.VOID


def rust_passport_after_scan(old_grade: int, old_void: bool, tamper: int, heat: int, hum: int, fill: int) -> tuple[int, bool]:
    """Line-by-line transcription of programs/flacon/src/grade.rs passport_after_scan (raw scan fields, not a grade)."""
    if old_void or old_grade == VOID or tamper in (Tamper.OPENED_NOW, Tamper.OPENED_BEFORE):
        return VOID, True
    if old_grade == C or heat == Indicator.TRIGGERED or hum == Indicator.TRIGGERED:
        return C, False
    return (A if fill >= 90 else B if fill >= 60 else D), False


def test_mirror_equals_the_program_rule_for_every_input():
    indicators = sorted(Indicator.values())
    for old_grade, old_void, tamper, heat, hum, fill in itertools.product(
            sorted(Grade.values()), (False, True), sorted(Tamper.values()), indicators, indicators, (0, 59, 60, 89, 90, 100)):
        scan_grade, _ = proof.compute_grade(verdict=VALID, tamper=tamper, heat=heat, hum=hum, fill=fill)
        want = rust_passport_after_scan(old_grade, old_void, tamper, heat, hum, fill)
        assert proof.passport_after_scan(old_grade, old_void, scan_grade) == want, (old_grade, old_void, tamper, heat, hum, fill)


def test_mirror_matches_the_program_unit_tests():
    # grade.rs heat_c_is_sticky_fill_follows_the_latest_scan
    assert proof.passport_after_scan(A, False, C) == (C, False)
    assert proof.passport_after_scan(C, False, A) == (C, False)          # a later scan without photo keeps C
    assert proof.passport_after_scan(C, False, D) == (C, False)          # a low fill never replaces C with D
    assert proof.passport_after_scan(D, False, C) == (C, False)
    # grade.rs one_low_fill_reading_is_corrected_by_the_next_scan
    assert proof.passport_after_scan(A, False, D) == (D, False)
    assert proof.passport_after_scan(D, False, A) == (A, False)
    assert proof.passport_after_scan(A, False, B) == (B, False) and proof.passport_after_scan(B, False, A) == (A, False)
    # grade.rs opened_seal_voids_for_good
    assert proof.passport_after_scan(A, False, VOID) == (VOID, True) and proof.passport_after_scan(C, False, VOID) == (VOID, True)
    assert proof.passport_after_scan(VOID, False, A) == (VOID, True)     # legacy VOID grade without the flag
    assert proof.passport_after_scan(A, True, A) == (VOID, True)


def test_an_older_scan_confirmed_late_never_sets_a_fill_grade():
    assert proof.passport_after_scan(A, False, D, latest=False) == (A, False)
    assert proof.passport_after_scan(D, False, A, latest=False) == (D, False)
    assert proof.passport_after_scan(A, False, C, latest=False) == (C, False)        # but C and VOID still count
    assert proof.passport_after_scan(B, False, VOID, latest=False) == (VOID, True)


def test_chain_refresh_rule():
    assert proof.passport_from_chain(D, False, A, False) == (A, False)               # chain wins for A/B/D (griefed D fixed)
    assert proof.passport_from_chain(A, False, D, False) == (D, False)
    assert proof.passport_from_chain(C, False, A, False) == (C, False)               # C sticky on the DB side ...
    assert proof.passport_from_chain(A, False, C, False) == (C, False)               # ... and on the chain side
    assert proof.passport_from_chain(A, True, A, False) == (VOID, True)              # VOID sticky on either side
    assert proof.passport_from_chain(A, False, VOID, False) == (VOID, True)
    assert proof.passport_from_chain(A, False, A, True) == (VOID, True)
    assert proof.passport_from_chain(A, False, D, False, chain_current=False) == (A, False)   # lagging read: DB's A/B/D
    assert proof.passport_from_chain(A, False, C, False, chain_current=False) == (C, False)   # sticky states still apply


def test_set_passport_grade_follows_the_program_rule(client):
    with client.app.state.db.connect() as conn:
        grade = lambda: tuple(conn.execute("SELECT grade, void FROM passports WHERE serial=?", (SERIAL,)).fetchone())  # noqa: E731
        conn.execute("UPDATE passports SET grade=0, void=0 WHERE serial=?", (SERIAL,))
        set_passport_grade(conn, SERIAL, D)
        assert grade() == (D, 0)                                         # one low fill reading ...
        set_passport_grade(conn, SERIAL, A)
        assert grade() == (A, 0)                                         # ... is corrected by the next scan
        set_passport_grade(conn, SERIAL, D, latest=False)
        assert grade() == (A, 0)                                         # an older scan never overwrites a newer fill
        set_passport_grade(conn, SERIAL, C, latest=False)
        assert grade() == (C, 0)                                         # but its C counts
        set_passport_grade(conn, SERIAL, A)
        assert grade() == (C, 0)
        set_passport_grade(conn, SERIAL, VOID)
        assert grade() == (VOID, 1)
        set_passport_grade(conn, SERIAL, A)
        assert grade() == (VOID, 1)


def _grade(c, serial=SERIAL) -> tuple[int, bool]:
    p = c.get(f"/api/passport/{serial}").json()
    return p["grade"], p["void"]


def _reconcile_against(c, grade: int, void: bool, scan_count: int) -> dict:
    c.rpc.accounts[passport_pda(SERIAL)] = passport_bytes(serial_hash=proof.serial_hash(SERIAL), grade=grade, void=void,
                                                          scan_count=scan_count)
    return c.post("/api/reconcile", headers=ADMIN).json()


@pytest.mark.parametrize("scans", [
    # (fill, heat): a griefing low fill corrected by the next honest scan, then heat damage, then a no-photo scan
    [(95, 0), (0, 0), (95, 0), (70, 0), (95, 1), (95, 3), (0, 0)],
    [(10, 0), (65, 0), (95, 3), (95, 1), (40, 0)],
])
def test_confirmations_and_reconcile_agree_after_every_scan(chain_client, scans):
    """After each confirmed scan the DB grade equals what record_scan stored, and reconcile reading that account changes
    nothing — no flip back and forth between the confirm path and 'chain wins'."""
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    with c.app.state.db.connect() as conn:                                # the seed leaves SN-2026-000001 at A
        assert tuple(conn.execute("SELECT grade, void FROM passports WHERE serial=?", (SERIAL,)).fetchone()) == (A, 0)
    chain = (A, False)
    for i, (fill, heat) in enumerate(scans, start=1):
        heat_levels = [1, 1, 1, 1, 1, 0] if heat == Indicator.TRIGGERED else [0, 0, 0, 0, 0, 0]
        v = _verify(c, tag["uid"], fill=fill, indicators={"heat": heat, "humidity": 0, "uv": 3}, heatLevels=heat_levels,
                    **({"tier": 2, "mediaHash": MEDIA} if heat == Indicator.TRIGGERED else {}))
        _confirm(c, v, sig(f"mirror-{len(scans)}-{i}"))
        chain = rust_passport_after_scan(*chain, Tamper.UNKNOWN, heat, 0, fill)
        assert _grade(c) == chain, (i, fill, heat)
        s = _reconcile_against(c, *chain, scan_count=i)
        assert s["refreshed"]["passports"] == 0, (i, s)
        assert _grade(c) == chain


def test_a_late_confirmation_of_an_older_low_fill_scan_keeps_the_newer_grade(chain_client):
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    low = _verify(c, tag["uid"], fill=0)                                 # counter n, grades D
    honest = _verify(c, tag["uid"], fill=95)                             # counter n+1, grades A
    assert (low["grade"], honest["grade"]) == (D, A)
    _confirm(c, honest, sig("late-honest"))
    _confirm(c, low, sig("late-low"))                                    # its confirm POST was retried / arrived late
    assert _grade(c) == (A, False)
    assert _reconcile_against(c, A, False, scan_count=2)["refreshed"]["passports"] == 0
    assert _grade(c) == (A, False)


def test_reconcile_lets_the_chain_correct_a_fill_grade_but_never_a_sticky_one(chain_client):
    from fv.db import onchain_scan_count
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    _confirm(c, _verify(c, tag["uid"], fill=0), sig("griefed"))
    _confirm(c, _verify(c, tag["uid"], fill=95), sig("honest"))
    assert _grade(c) == (A, False)
    with c.app.state.db.connect() as conn:
        assert onchain_scan_count(conn, SERIAL) == 2
    # a lagging RPC node still shows the griefed D after one scan: fewer scans than confirmed here → no flip back
    assert _reconcile_against(c, D, False, scan_count=1)["refreshed"]["passports"] == 0
    assert _grade(c) == (A, False)
    assert _reconcile_against(c, A, False, scan_count=2)["refreshed"]["passports"] == 0
    # another low reading confirmed here, then the chain applied a newer honest scan whose confirm never reached this
    # server: chain wins for A/B/D (the old 'worse of DB and chain' rule kept the griefed D)
    _confirm(c, _verify(c, tag["uid"], fill=0), sig("griefed-2"))
    assert _grade(c) == (D, False)
    assert _reconcile_against(c, A, False, scan_count=4)["refreshed"]["passports"] == 1
    assert _grade(c) == (A, False)
    # C on chain reaches the DB, and a later chain A never clears it
    assert _reconcile_against(c, C, False, scan_count=5)["refreshed"]["passports"] == 1
    assert _grade(c) == (C, False)
    assert _reconcile_against(c, A, False, scan_count=6)["refreshed"]["passports"] == 0
    assert _grade(c) == (C, False)
    # VOID on chain reaches the DB and stays
    assert _reconcile_against(c, VOID, True, scan_count=7)["refreshed"]["passports"] == 1
    assert _reconcile_against(c, A, False, scan_count=8)["refreshed"]["passports"] == 0
    assert _grade(c) == (VOID, True)


def test_purge_seed_recompute_uses_the_same_rule(client):
    from fv.routes_admin import _recompute_passport
    serial = "SN-2026-000002"

    def scans(*grades, chain=None):
        with client.app.state.db.connect() as conn:
            conn.execute("DELETE FROM events WHERE serial=? AND type IN (2, 9)", (serial,))
            for i, g in enumerate(grades):
                conn.execute("INSERT INTO events(serial, type, ts, status, tx_sig, payload_json) VALUES(?,?,?,?,?,?)",
                             (serial, 2, 1_790_000_000 + i, "confirmed", sig(f"recompute-{i}"),
                              f'{{"grade": {g}, "indicators": {{"heat": 0, "humidity": 0, "uv": 3}}}}'))
            res = _recompute_passport(conn, serial, chain)
            row = tuple(conn.execute("SELECT grade, void FROM passports WHERE serial=?", (serial,)).fetchone())
            assert row == (res["grade"], int(res["void"]))
            return res["grade"], res["void"]

    assert scans() == (A, False)
    assert scans(D, A) == (A, False)                                     # the newest fill wins (MAX kept D)
    assert scans(A, D) == (D, False)
    assert scans(C, A) == (C, False) and scans(A, VOID, A) == (VOID, True)
    chain = {"grade": B, "void": False, "scanCount": 2}
    assert scans(A, A, chain=chain) == (B, False)                         # the chain's A/B/D wins once it has scans
    assert scans(C, A, chain=chain) == (C, False)                         # C stays
    assert scans(A, A, A, chain=chain) == (A, False)                      # a chain read with fewer scans: DB's A/B/D
    assert scans(A, chain={"grade": A, "void": True, "scanCount": 0}) == (VOID, True)
