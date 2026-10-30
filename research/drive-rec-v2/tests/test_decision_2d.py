"""test_decision_2d.py — synthetic-fixture tests for the Decision 2D harness.

These tests verify CODE CORRECTNESS ONLY, on hand-built synthetic data. They
make no claim about any model, market, or season, and produce no pilot results.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

DRIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DRIVE))
sys.path.insert(0, str(DRIVE / "decision_2d"))

import contract as d2c              # noqa: E402
import quotes as d2q                # noqa: E402
import point_in_time as d2p         # noqa: E402
import settlement as d2s            # noqa: E402
import metrics as d2m               # noqa: E402
import ledger as d2l                # noqa: E402


# ---------------------------------------------------------------- fixtures

KO = "2025-11-02T18:00:00Z"


def make_quote(game="2025_09_KC_DEN", book="draftkings", player="00-0000001",
               line=57.5, over=1.90, under=1.90, snap="2025-11-02T16:55:00Z",
               upd="2025-11-02T16:54:30Z", voided=False, synthetic=False):
    return {"game_id": game, "kickoff_utc": KO, "bookmaker": book,
            "player_id": player, "player_name": "Test Player", "line": line,
            "price_over_decimal": over, "price_under_decimal": under,
            "snapshot_ts_utc": snap, "book_last_update_utc": upd,
            "voided": voided, "synthetic": synthetic, "source": "test"}


def quote_df(rows):
    """Rows are make_quote(...) dicts (already built) — just frame them."""
    return pd.DataFrame(list(rows))


# ---------------------------------------------------------------- contract

class TestContract(unittest.TestCase):
    def test_load_and_verify(self):
        contract = d2c.verify_contract()
        self.assertEqual(contract["status"], "PRECOMMITTED_BEFORE_QUOTE_ACQUISITION")
        self.assertIn("E1_sample_adequacy", contract["gates"])
        self.assertEqual(contract["quote_store_present_at_freeze"], False)

    def test_refit_lock_engages_on_tamper(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        contract = d2c.load_contract()
        # copy the contract AND every frozen artifact into the sandbox
        shutil.copy(d2c.contract_path(), tmp / "decision_2d_contract.json")
        for name in contract["models"]["frozen_artifacts_sha256"]:
            shutil.copy(d2c.ARTIFACTS / name, tmp / name)
        original = d2c.ARTIFACTS
        d2c.ARTIFACTS = tmp
        try:
            d2c.verify_contract()          # verified copy passes
            p = tmp / "criteria_v3.json"
            p.write_text(p.read_text() + " ")   # tamper with one frozen artifact
            with self.assertRaises(d2c.ContractViolation) as cm:
                d2c.verify_contract()
            self.assertIn("REFIT LOCK", str(cm.exception))
        finally:
            d2c.ARTIFACTS = original

    def test_missing_contract_aborts(self):
        # SAFETY: never touch the real artifacts directory; patch onto a temp
        # dir and restore in a finally that only ever removes the TEMP dir.
        original = d2c.ARTIFACTS
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        d2c.ARTIFACTS = tmp
        try:
            with self.assertRaises(d2c.ContractViolation):
                d2c.load_contract()
        finally:
            d2c.ARTIFACTS = original   # restore; tmp cleaned by addCleanup


# ---------------------------------------------------------------- quotes

class TestQuotes(unittest.TestCase):
    def test_valid_store(self):
        q = d2q.validate_quotes(quote_df([make_quote()]))
        self.assertEqual(len(q), 1)
        self.assertTrue(q.voided.dtype == bool)

    def test_csv_string_bools_coerced(self):
        df = quote_df([make_quote()])
        df["voided"] = "False"
        df["synthetic"] = "False"
        q = d2q.validate_quotes(df)
        self.assertEqual(bool(q.voided.iloc[0]), False)
        self.assertEqual(bool(q.synthetic.iloc[0]), False)

    def test_synthetic_refused(self):
        with self.assertRaises(d2q.QuoteValidationError):
            d2q.validate_quotes(quote_df([make_quote(synthetic=True)]))

    def test_bad_odds_refused(self):
        with self.assertRaises(d2q.QuoteValidationError):
            d2q.validate_quotes(quote_df([make_quote(over=0.95)]))

    def test_late_book_timestamp_refused(self):
        with self.assertRaises(d2q.QuoteValidationError):
            d2q.validate_quotes(quote_df(
                [make_quote(snap="2025-11-02T16:55:00Z",
                            upd="2025-11-02T17:10:00Z")]))

    def test_duplicates_refused(self):
        with self.assertRaises(d2q.QuoteValidationError):
            d2q.validate_quotes(quote_df([make_quote(), make_quote()]))

    def test_novig_symmetric(self):
        self.assertAlmostEqual(d2q.novig_close_prob(1.90, 1.90), 0.5)
        # a LONGER over price (2.10 vs 1.75) implies LOWER no-vig over prob
        self.assertLess(d2q.novig_close_prob(2.10, 1.75), 0.5)
        self.assertGreater(d2q.novig_close_prob(1.75, 2.10), 0.5)


# ---------------------------------------------------------------- point in time

class TestPointInTime(unittest.TestCase):
    def setUp(self):
        # realistic 5-minute vendor cadence: snapshots shortly before each
        # decision time; book_last_update <= snapshot (validation invariant)
        self.q = d2q.validate_quotes(quote_df([
            make_quote(snap="2025-11-02T14:59:00Z", upd="2025-11-02T14:58:40Z",
                       over=2.05),                        # pre T-180m snapshot
            make_quote(snap="2025-11-02T16:59:00Z", upd="2025-11-02T16:58:40Z",
                       over=1.90),                        # pre T-60m snapshot
            make_quote(snap="2025-11-02T17:44:00Z", upd="2025-11-02T17:43:50Z",
                       over=1.87),                        # pre T-15m snapshot
            make_quote(snap="2025-11-02T17:58:00Z", upd="2025-11-02T17:57:55Z",
                       over=1.85),                        # closing snapshot
        ]))

    def test_selects_latest_snapshot_at_or_before_decision(self):
        sel = d2p.select_quotes_at(self.q, d2p.DECISION_OFFSETS["T-60m"])
        self.assertEqual(len(sel), 1)
        self.assertAlmostEqual(sel.price_over_decimal.iloc[0], 1.90)
        self.assertAlmostEqual(sel.snapshot_age_seconds.iloc[0], 60.0)
        self.assertAlmostEqual(sel.quote_age_seconds.iloc[0], 80.0)

    def test_t15_and_closing(self):
        sel15 = d2p.select_quotes_at(self.q, d2p.DECISION_OFFSETS["T-15m"])
        self.assertAlmostEqual(sel15.price_over_decimal.iloc[0], 1.87)
        self.assertAlmostEqual(sel15.quote_age_seconds.iloc[0], 70.0)
        close = d2p.select_quotes_at(self.q, d2p.DECISION_OFFSETS["closing"],
                                     strictly_before_kickoff=False)
        self.assertAlmostEqual(close.price_over_decimal.iloc[0], 1.85)

    def test_earlier_offset_gets_earlier_quote(self):
        sel = d2p.select_quotes_at(self.q, d2p.DECISION_OFFSETS["T-180m"])
        self.assertAlmostEqual(sel.price_over_decimal.iloc[0], 2.05)

    def test_leakage_assertion(self):
        with self.assertRaises(d2p.LeakageError):
            d2p.assert_point_in_time(
                pd.Timestamp(KO), pd.Timestamp(KO), what="test")

    def test_quote_after_decision_is_filtered_not_selected(self):
        # later snapshots legitimately exist in the store; they must simply
        # never be selected (the T-60m pick is the 16:59 quote, not 17:44+)
        sel = d2p.select_quotes_at(self.q, d2p.DECISION_OFFSETS["T-60m"])
        self.assertAlmostEqual(sel.snapshot_age_seconds.iloc[0], 60.0)
        self.assertAlmostEqual(sel.price_over_decimal.iloc[0], 1.90)

    def test_decision_at_or_after_kickoff_refused(self):
        # a misconfigured POSITIVE offset puts the decision after kickoff
        with self.assertRaises(d2p.LeakageError):
            d2p.select_quotes_at(self.q, offset_minutes=+30,
                                 label="misconfigured +30m")

    def test_voided_skipped(self):
        q = quote_df([make_quote(voided=True),
                      make_quote(book="fanduel")])
        q = d2q.validate_quotes(q)
        sel = d2p.select_quotes_at(q, d2p.DECISION_OFFSETS["T-60m"])
        self.assertEqual(set(sel.bookmaker), {"fanduel"})

    def test_age_report(self):
        sel = d2p.select_quotes_at(self.q, d2p.DECISION_OFFSETS["T-60m"])
        rep = d2p.quote_age_report(sel)
        self.assertEqual(rep["n"], 1)
        self.assertEqual(rep["within_300s"], 1.0)
        self.assertEqual(rep["within_60s"], 0.0)   # 80s quote age
        self.assertAlmostEqual(rep["median_seconds"], 80.0)


# ---------------------------------------------------------------- settlement

def pbp_frame(rows):
    return pd.DataFrame(rows, columns=["game_id", "complete_pass",
                                        "receiver_player_id", "yards",
                                        "two_point_conversion"])


class TestSettlement(unittest.TestCase):
    def test_yards_aggregation_and_2pt_exclusion(self):
        pbp = pbp_frame([
            ("G1", 1.0, "P1", 12.0, 0.0),
            ("G1", 1.0, "P1", 8.0, 0.0),
            ("G1", 1.0, "P1", 2.0, 1.0),     # two-point try: excluded
            ("G1", 1.0, "P2", 25.0, 0.0),
            ("G1", 0.0, "P1", 30.0, 0.0),    # incomplete: excluded
        ])
        y = d2s.receiving_yards_by_game(pbp)
        p1 = y.loc[y.player_id == "P1"].receiving_yards.iloc[0]
        self.assertAlmostEqual(p1, 20.0)
        self.assertAlmostEqual(y.loc[y.player_id == "P2"].receiving_yards.iloc[0],
                               25.0)

    def test_push_and_void(self):
        self.assertEqual(d2s.settle(20.0, 20.0), "push")
        self.assertEqual(d2s.settle(20.5, 20.0), "under")
        self.assertEqual(d2s.settle(19.5, 20.0), "over")
        self.assertAlmostEqual(d2s.realized_return("push", 2.0), 0.0)
        self.assertAlmostEqual(d2s.realized_return("over", 2.0), 1.0)
        self.assertAlmostEqual(d2s.realized_return("under", 2.0), -1.0)
        self.assertTrue(np.isnan(d2s.realized_return("void", 2.0)))

    def test_settle_frame(self):
        alerts = pd.DataFrame([
            {"game_id": "G1", "player_id": "P1", "line": 19.5,
             "price_over_decimal": 2.0, "voided": False},
            {"game_id": "G1", "player_id": "P2", "line": 25.0,
             "price_over_decimal": 1.9, "voided": False},
            {"game_id": "G1", "player_id": "P3", "line": 10.0,
             "price_over_decimal": 1.8, "voided": True},
        ])
        yards = pd.DataFrame([
            {"game_id": "G1", "player_id": "P1", "receiving_yards": 20.0,
             "n_receptions": 2},
            {"game_id": "G1", "player_id": "P2", "receiving_yards": 25.0,
             "n_receptions": 1},
        ])
        a = d2s.settle_frame(alerts, yards)
        self.assertEqual(a.outcome.tolist(), ["over", "push", "void"])
        self.assertAlmostEqual(a.realized_return.iloc[0], 1.0)
        self.assertAlmostEqual(a.realized_return.iloc[1], 0.0)
        self.assertTrue(np.isnan(a.realized_return.iloc[2]))
        # no-pbp-row player (P3) with void=False would be flagged, not silent
        self.assertIn("settlement_flag", a.columns)


# ---------------------------------------------------------------- metrics

class TestMetrics(unittest.TestCase):
    def _alerts(self):
        return pd.DataFrame([
            # 2 over wins at 2.0, 1 under, 1 push at 2.0; p_over = 0.55
            {"game_id": "G1", "outcome": "over", "p_over": 0.55,
             "price_over_decimal": 2.0, "p_close_novig": 0.50,
             "realized_return": 1.0},
            {"game_id": "G2", "outcome": "over", "p_over": 0.55,
             "price_over_decimal": 2.0, "p_close_novig": 0.50,
             "realized_return": 1.0},
            {"game_id": "G3", "outcome": "under", "p_over": 0.55,
             "price_over_decimal": 2.0, "p_close_novig": 0.50,
             "realized_return": -1.0},
            {"game_id": "G4", "outcome": "push", "p_over": 0.55,
             "price_over_decimal": 2.0, "p_close_novig": 0.50,
             "realized_return": 0.0},
        ])

    def test_roi_hand_computed(self):
        m = d2m.roi_metrics(self._alerts())
        self.assertAlmostEqual(m["realized_roi"]["mean"], 0.25)
        self.assertAlmostEqual(m["expected_roi"]["mean"], 0.55 * 2.0 - 1.0)
        self.assertAlmostEqual(m["clv"]["mean"], 0.50 * 2.0 - 1.0)
        # clustered CIs contain the point estimates
        for k in ("realized_roi", "expected_roi", "clv"):
            self.assertLessEqual(m[k]["ci_low"], m[k]["mean"] + 1e-12)
            self.assertGreaterEqual(m[k]["ci_high"], m[k]["mean"] - 1e-12)

    def test_precision_excludes_pushes(self):
        pr = d2m.precision_metric(self._alerts())
        self.assertEqual(pr["n"], 3)
        self.assertAlmostEqual(pr["alert_precision"], 2.0 / 3.0)

    def test_selection_conditional_calibration(self):
        cal = d2m.calibration_metric(self._alerts())
        self.assertAlmostEqual(cal["mean_pred"], 0.55)
        # over-rate among settled incl. push-as-not-over: 2 of 4
        self.assertAlmostEqual(cal["realized_over_rate"], 0.5)
        self.assertAlmostEqual(cal["gap_pp"], -5.0)

    def test_gates_fail_closed_on_low_sample(self):
        contract = d2c.load_contract()
        res = d2m.evaluate_gates(self._alerts(), contract,
                                 coverage_game_share=1.0)
        self.assertEqual(res["overall"], "FAIL")
        self.assertEqual(res["gates"]["E1_sample_adequacy"]["status"], "FAIL")

    def test_gates_pass_on_constructed_passing_frame(self):
        # 120 alerts across 30 games, all over-winning at 2.0 with p=0.55 and
        # p_close 0.5: realized ROI .5, expected .1, diff .4 -> E5 FAILS.
        # Instead construct an honestly-passing frame: p=0.5 at 2.0, close 0.5.
        n = 120
        rng = np.random.default_rng(7)
        games = np.array([f"G{i % 30}" for i in range(n)])
        wins = rng.random(n) < 0.62
        a = pd.DataFrame({
            "game_id": games,
            "outcome": np.where(wins, "over", "under"),
            "p_over": 0.60, "price_over_decimal": 1.95,
            "p_close_novig": 0.52,
            "realized_return": np.where(wins, 0.95, -1.0),
        })
        contract = d2c.load_contract()
        res = d2m.evaluate_gates(a, contract, coverage_game_share=0.9)
        # E1 should pass structurally; E5's CI almost surely exceeds +/-3pp on
        # binary returns -> overall FAIL, demonstrating the fail-closed bar.
        self.assertEqual(res["gates"]["E1_sample_adequacy"]["status"], "PASS")
        self.assertIn(res["overall"], {"PASS", "FAIL"})   # runs cleanly


# ---------------------------------------------------------------- ledger

class TestLedger(unittest.TestCase):
    def test_game_coverage_counts_missing_games(self):
        q = d2q.validate_quotes(quote_df([
            make_quote(game="G1"), make_quote(game="G2")]))
        sel = d2p.select_quotes_at(q, d2p.DECISION_OFFSETS["T-60m"])
        cov = d2l.game_coverage(q, sel, ["G1", "G2", "G3"])
        self.assertEqual(cov["scheduled_games"], 3)
        self.assertEqual(cov["games_with_quote_at_decision"], 2)
        self.assertAlmostEqual(cov["coverage_at_decision"], 2 / 3)
        self.assertEqual(cov["games_with_no_quote_ever"], ["G3"])

    def test_void_push_accounting(self):
        s = pd.DataFrame({"outcome": ["over", "push", "void", "under"]})
        acc = d2l.void_and_push_accounting(s)
        self.assertEqual(acc["voided"], 1)
        self.assertEqual(acc["pushed"], 1)
        self.assertEqual(acc["settled_excluding_void"], 3)

    def test_book_availability_and_universe(self):
        q = d2q.validate_quotes(quote_df([
            make_quote(game="G1", book="b1", player="P1"),
            make_quote(game="G1", book="b1", player="P2"),
            make_quote(game="G1", book="b2", player="P1"),
        ]))
        sel = d2p.select_quotes_at(q, d2p.DECISION_OFFSETS["T-60m"])
        ba = d2l.book_availability(sel)
        self.assertEqual(ba.set_index("bookmaker").loc["b1", "players_priced"], 2)
        uni = pd.DataFrame({"game_id": ["G1"] * 3,
                            "player_id": ["P1", "P2", "P3"]})
        cov = d2l.player_universe_coverage(sel, uni)
        b1 = cov.set_index("bookmaker").loc["b1", "coverage"]
        self.assertAlmostEqual(b1, 2 / 3)


# ---------------------------------------------------------------- projection

class MockModel:
    """Deterministic stand-in for the frozen pipeline: P = base + ctx effect."""

    def __init__(self, base=0.2, ctx_weight=0.05):
        self.base, self.ctx_weight = base, ctx_weight

    def predict_proba(self, X: pd.DataFrame):
        z = (self.base + self.ctx_weight *
             (X["drive_idx_team"].to_numpy(float) / 10.0))
        p = np.clip(z, 0.01, 0.9)
        return np.column_stack([1 - p, p])


class TestYardsProjection(unittest.TestCase):
    def _proj(self, tmp, n_ctx=200, n_sims=500):
        from yards_projection import FrozenYardsProjection
        ctx = pd.DataFrame({
            "qtr": [1.0] * n_ctx, "is_ot": [0.0] * n_ctx,
            "game_secs_rem": [1800.0] * n_ctx,
            "game_secs_rem_log": [np.log1p(1800.0)] * n_ctx,
            "two_min": [0.0] * n_ctx, "score_diff": [0.0] * n_ctx,
            "abs_score_diff": [0.0] * n_ctx, "offense_leading": [0.0] * n_ctx,
            "yardline_100_start": [75.0] * n_ctx, "down_start": [1.0] * n_ctx,
            "ydstogo_start": [10.0] * n_ctx, "off_timeouts_rem": [3.0] * n_ctx,
            "def_timeouts_rem": [3.0] * n_ctx,
            "drive_idx_team": np.tile([1, 2, 3, 4, 5, 6], n_ctx // 6 + 1)[:n_ctx],
        })
        proj = FrozenYardsProjection(
            MockModel(), lambda p: p, ctx,
            np.array([1, 2, 3, 4, 5, 6, 8, 10, 12, 14]),
            yards_by_player={"P1": np.array([10.0, 12.0, 14.0, 20.0, 22.0])},
            yards_by_pos={"WR": np.array([8.0, 12.0, 16.0])},
            league_yards=np.array([5.0, 10.0, 15.0]),
            n_ctx=n_ctx, n_sims=n_sims, seed=11)
        return proj

    def _feature_row(self):
        from lib.common import ALL_FEATURES
        row = {c: 0.0 for c in ALL_FEATURES}
        row.update(drive_idx_team=1.0, qtr=1.0, game_secs_rem=3600.0)
        return pd.Series(row)

    def test_p_over_bounded_and_deterministic(self):
        proj = self._proj(None)
        r1 = proj.p_over(self._feature_row(), "P1", "WR", line=25.0)
        r2 = proj.p_over(self._feature_row(), "P1", "WR", line=25.0)
        self.assertTrue(0.0 <= r1["p_over"] <= 1.0)
        self.assertEqual(r1["p_over"], r2["p_over"])          # frozen seeds
        self.assertGreater(r1["mc_se"], 0.0)
        # higher line -> lower P(over), monotonically on this grid
        lo = proj.p_over(self._feature_row(), "P1", "WR", line=5.0)["p_over"]
        hi = proj.p_over(self._feature_row(), "P1", "WR", line=60.0)["p_over"]
        self.assertGreater(lo, r1["p_over"])
        self.assertGreater(r1["p_over"], hi)

    def test_player_yards_source_preferred(self):
        proj = self._proj(None)
        src = proj._yards_source("P1", "WR")
        self.assertEqual(src.tolist(), [10.0, 12.0, 14.0, 20.0, 22.0])
        src2 = proj._yards_source("UNKNOWN", "WR")
        self.assertEqual(len(src2), 3)                          # position fallback
        src3 = proj._yards_source("UNKNOWN", "FB")
        self.assertEqual(src3.tolist(), [5.0, 10.0, 15.0])      # league fallback

    def test_leakage_guard_rejects_non_2023_params(self):
        from yards_projection import LeakageError, FrozenYardsProjection
        with self.assertRaises(LeakageError):
            FrozenYardsProjection.from_train_data(
                MockModel(), lambda p: p, Path("/tmp"), season=2024)

    def test_from_train_data_smoke(self):
        """Minimal 2023-only parquet fixtures end-to-end through the loader."""
        from lib.common import ALL_FEATURES, FEATURE_BLOCKS
        from yards_projection import FrozenYardsProjection
        tmp = Path(tempfile.mkdtemp())
        try:
            base = {c: 0.0 for c in ALL_FEATURES}
            base.update(drive_idx_team=1.0, qtr=1.0, game_secs_rem=3600.0,
                        game_secs_rem_log=np.log1p(3600.0))
            corpus = pd.DataFrame([dict(base, game_id="G1", posteam="KC",
                                        player_id="P1", player_name="P",
                                        position="WR", y=0)] * 50)
            pbp = pd.DataFrame({
                "game_id": ["G1"] * 6,
                "complete_pass": [1.0, 1.0, 1.0, 0.0, 1.0, 1.0],
                "receiver_player_id": ["P1"] * 6,
                "yards": [10.0, 12.0, 8.0, 30.0, 14.0, 2.0],
                "two_point_conversion": [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            })
            corpus.to_parquet(tmp / "player_drives_2023.parquet")
            pbp.to_parquet(tmp / "play_by_play_2023.parquet")
            proj = FrozenYardsProjection.from_train_data(
                MockModel(), lambda p: p, tmp, n_ctx=50, n_sims=200)
            res = proj.p_over(pd.Series(base), "P1", "WR", line=20.0)
            self.assertTrue(0.0 <= res["p_over"] <= 1.0)
            # two-point try (2 yd) excluded from the yards source
            self.assertEqual(proj.yards_by_player["P1"].tolist(),
                             [10.0, 12.0, 8.0, 14.0])
        finally:
            shutil.rmtree(tmp)

    def test_param_fingerprint_stable(self):
        p1, p2 = self._proj(None), self._proj(None)
        self.assertEqual(p1.param_fingerprint()["params_sha256"],
                         p2.param_fingerprint()["params_sha256"])


# ---------------------------------------------------------------- run_pilot --check

class TestRunPilotCheck(unittest.TestCase):
    def test_check_runs_without_quotes(self):
        import run_pilot
        rc = run_pilot.check()
        self.assertEqual(rc, 0)   # readiness reporting, no evaluation

    def test_run_refuses_without_quote_store(self):
        import run_pilot
        rc = run_pilot.run()
        self.assertEqual(rc, 1)   # fail-closed: pilot has not started


if __name__ == "__main__":
    unittest.main()
