"""Verifier operations repairs (second review round): confirmation order and the grade (M6), the reconcile job's
creating signature (S8/M10), the Arweave queue (S8/S15), purge-seed and the leftover-seed warning (M1/M2), the
simulator escape hatch (M11) and the escrow counters after close_order (S10)."""
from tests.conftest import sig
from tests.test_stats_grade import MEDIA, SERIAL, _confirm, _verify


# ---------- M6: the grade does not depend on the order in which confirmations arrive ----------

def test_an_older_c_scan_confirmed_after_a_newer_clean_scan_still_lowers_the_grade(chain_client):
    c = chain_client
    tag = c.post("/api/dev/tag", json={"serial": SERIAL, "kind": 1}).json()
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 0
    hot = _verify(c, tag["uid"], tier=2, mediaHash=MEDIA, indicators={"heat": 1, "humidity": 0, "uv": 3},
                  heatLevels=[1, 1, 1, 1, 1, 0], fill=95)
    plain = _verify(c, tag["uid"])                         # signed after the hot one (newer ts / id), grades A
    assert (hot["grade"], plain["grade"]) == (2, 0)
    _confirm(c, plain, sig("m6-plain"))                    # the newer clean scan is confirmed first ...
    assert c.get(f"/api/passport/{SERIAL}").json()["grade"] == 0
    _confirm(c, hot, sig("m6-hot"))                        # ... the older C arrives late (lost / retried confirm POST)
    p = c.get(f"/api/passport/{SERIAL}").json()
    assert p["grade"] == 2 and p["void"] is False
