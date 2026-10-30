"""04_define_criteria_v3.py — define acceptance criteria v3 BEFORE candidate evaluation.

Written and frozen before any recalibrated-model number exists in this run (strictest
reading of Decision 2C item 3: criteria are fixed before the candidate is evaluated on
ANY slice, including the development-season comparison). The artifact records its own
definition timestamp and content hash; the git history of this file provides the audit
trail that it preceded scripts 05-08.

Criteria v3 applies to the CANDIDATE = frozen logistic incumbent + isotonic
recalibration fitted on 2024 development data only.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ARTIFACTS  # noqa: E402

CRITERIA_V3 = {
    "version": "v3",
    "defined_at_utc": None,  # filled below
    "applies_to": (
        "CANDIDATE = frozen logistic incumbent (trained on 2023 only, C=0.01) + "
        "isotonic recalibration fitted on 2024 development data only"
    ),
    "ordering_guarantee": (
        "This file was generated before scripts 05-08 were executed in this run; "
        "no candidate prediction existed at definition time."
    ),
    "evaluation_slices": {
        "DEV_CROSSFIT_2024": (
            "2024 development season, cross-fitted isotonic "
            "(fit weeks 1-9 -> applied weeks 10-18, and vice versa); comparison "
            "against incumbent BEFORE any holdout evaluation"
        ),
        "HOLDOUT_2025": "2025 season, previously inspected holdout (labeled as such)",
        "UNSEEN_2026": "2026 weeks 1-7, genuinely unseen prospective slice",
    },

    "C1_sample_adequacy": {
        "rule": "A slice is EVALUABLE only if it has >= 300 player-drive rows from "
                ">= 25 distinct games. Smaller slices are LOW_SAMPLE: reported, and "
                "cannot support a PASS.",
        "promotion_effect": "LOW_SAMPLE on any primary slice blocks promotion "
                            "(fail-closed).",
    },

    "C2_top_decile_calibration": {
        "point_gap_abs_max": 0.030,
        "point_gap_rel_max": 0.10,
        "ci_containment_abs": 0.050,
        "rule": "Within the top 10% of predicted probability (candidate's own "
                "ranking): |mean_pred - obs| <= 0.030 AND <= 10% relative, AND the "
                "95% game-clustered bootstrap CI of (obs - mean_pred) lies entirely "
                "within +/- 0.050.",
    },

    "C3_alert_region_calibration": {
        "primary_thresholds": ["p_cal >= 0.25", "p_cal >= 0.30"],
        "secondary_thresholds_reported_only": ["p_cal >= 0.35", "p_cal >= 0.40"],
        "point_gap_abs_max": 0.030,
        "point_gap_rel_max": 0.10,
        "ci_containment_abs": 0.050,
        "rule": "Same thresholds as C2, applied at each primary threshold. "
                "Additionally, at the INCUMBENT's original operating point "
                "(p_incumbent >= 0.30), the candidate's calibrated probabilities must "
                "satisfy the same bounds, so the comparison is anchored at the "
                "engine's original alert region.",
    },

    "C4_ev_band_probability_calibration": {
        "bands": ["simulated_EV >= 0%", ">= 3%", ">= 5%", ">= 8%"],
        "point_gap_abs_max": 0.030,
        "min_n_per_band": 100,
        "rule": "Within each simulated-EV band containing >= 100 rows: "
                "|mean_pred - obs| <= 0.030. Bands with fewer rows are LOW_SAMPLE "
                "and cannot support a PASS.",
    },

    "C5_global_non_degradation": {
        "brier_tolerance": 0.002,
        "log_loss_tolerance": 0.010,
        "auc_tolerance": 0.002,
        "rule": "On every evaluation slice: candidate Brier <= incumbent + 0.002; "
                "candidate log loss <= incumbent + 0.010; candidate AUC >= incumbent "
                "- 0.002; candidate decile-ECE <= incumbent decile-ECE. Isotonic "
                "creates ties, so a small AUC reduction is tolerated.",
    },

    "C6_uncertainty_bounds": {
        "rule": "All PASS/FAIL calibration decisions use BOTH the point estimate and "
                "the 95% game-clustered bootstrap CI as specified in C2-C4. Intervals "
                "resample games with replacement (1000 replicates, fixed seeds).",
    },

    "C7_ev_reliability_gate_report_only": {
        "rule": "The historical corpus contains no genuine contemporaneous market "
                "quotes. All price-based EV analysis uses SIMULATED quotes and is "
                "labeled HYPOTHETICAL; it cannot establish executable betting "
                "profitability. The gate reports, per alert threshold: qualifying "
                "observations, mean predicted probability vs realized frequency, "
                "predicted vs realized return at the evaluated prices, game-clustered "
                "95% CIs, and sensitivity to quote latency, stale prices, and "
                "execution assumptions. Only the probability component of C4 is "
                "binding; realized-return reporting is informational.",
    },

    "C8_baseline_quote_scenario": {
        "note": "Fixed NOW, before candidate evaluation, so no quote parameter can be "
                "tuned to results.",
        "market_reference": "calibrated probability of the same player computed with "
                            "the feature row from the previous team drive in the same "
                            "game (lag-1 staleness); for a player's first drive of a "
                            "game, a context-neutralized row (median context, zero "
                            "in-game counters)",
        "vig": 0.06,
        "quote_latency_drives": 1,
        "execution_slippage": 0.02,
        "sensitivity_grid": {
            "vig": [0.03, 0.06, 0.10],
            "quote_latency_drives": [0, 1, 2, 4, "frozen_pregame"],
            "execution_slippage": [0.00, 0.02, 0.05],
        },
        "decimal_odds_formula": "D = 1 / (reference_prob * (1 + vig))",
        "model_ev_formula": "EV_model = p * D_exec - 1, "
                            "D_exec = 1 / (reference * (1 + vig) * (1 + slippage))",
        "realized_return_formula": "R = y * D_exec - 1",
    },

    "C9_fail_closed_promotion": {
        "rule": "The candidate is promoted to CANDIDATE_CALIBRATED (research-only "
                "status change) ONLY if every evaluable primary criterion passes on "
                "BOTH HOLDOUT_2025 and UNSEEN_2026. Any FAIL, or any LOW_SAMPLE on a "
                "primary slice, leaves status RESEARCH_ONLY. The CALIBRATED "
                "production label remains BLOCKED pending human sign-off, which is "
                "DEFERRED per Decision 2C. HUMAN_REVIEW.md is not signed.",
    },

    "relationship_to_criteria_v2": (
        "Criteria v2 (Brier/log-loss improvement over baselines, reliability, "
        "minimum samples) is retained for the incumbent evaluation in script 03. "
        "Criteria v3 adds the tail/decile thresholds, uncertainty bounds, EV-band "
        "probability checks and the economic reporting requirements ordered by "
        "Decision 2C."
    ),
}


def main() -> int:
    doc = dict(CRITERIA_V3)
    doc["defined_at_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
    blob = json.dumps(doc, sort_keys=True).encode()
    doc["content_sha256"] = hashlib.sha256(blob).hexdigest()
    with open(ARTIFACTS / "criteria_v3.json", "w") as f:
        json.dump(doc, f, indent=2)
    print(f"[criteria v3] frozen at {doc['defined_at_utc']} "
          f"(sha256 {doc['content_sha256'][:16]}...)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
