"""05_fit_recalibration.py — isotonic recalibration fitted on 2024 development data only.

Decision 2C, item 1: the underlying logistic model stays FROZEN (it is never refit,
re-tuned, or otherwise modified in this script or any downstream script). The only new
object is an isotonic mapping p_incumbent -> p_calibrated.

Two artifacts:
  1. Cross-fitted dev predictions: isotonic fitted on 2024 weeks 1-9 is applied to
     weeks 10-18 and vice versa, so every dev row receives a calibration produced
     without seeing its own half-season. This is the honest development comparison
     of script 06.
  2. The production candidate: isotonic fitted on ALL of 2024 (development data
     only, as ordered), applied to the 2025 previously-inspected holdout and the
     2026 genuinely-unseen slice.

Outputs:
  artifacts/isotonic_calibrator.json          full mapping (knots), fit metadata
  artifacts/isotonic_calibrator.joblib        (gitignored, reproducible)
  artifacts/candidate_predictions_<season>.csv.gz   p_incumbent + p_calibrated per row
"""

from __future__ import annotations

import json
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ARTIFACTS, DEV_SEASON, HOLDOUT_SEASON, SEASONS_MODELED, \
    TRAIN_SEASON, UNSEEN_SEASON  # noqa: E402


def fit_isotonic(p: np.ndarray, y: np.ndarray) -> IsotonicRegression:
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    iso.fit(p, y)
    return iso


def describe(iso: IsotonicRegression) -> dict:
    xs = np.asarray(iso.X_thresholds_, dtype=float)
    ys = np.asarray(iso.y_thresholds_, dtype=float)
    probe = {}
    for x in (0.05, 0.15, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70, 0.80):
        probe[f"input_{x:.2f}"] = float(iso.predict(np.array([x]))[0])
    return {
        "n_knots": int(len(xs)),
        "input_range": [float(xs.min()), float(xs.max())],
        "output_range": [float(ys.min()), float(ys.max())],
        "probe_input_to_output": probe,
    }


def main() -> int:
    dev = pd.read_csv(ARTIFACTS / f"incumbent_predictions_{DEV_SEASON}.csv.gz")

    # ---- 1. cross-fitted development predictions ----
    half_a = dev.week <= 9
    half_b = dev.week >= 10
    iso_a = fit_isotonic(dev.loc[half_a, "p_incumbent"].to_numpy(),
                         dev.loc[half_a, "y"].to_numpy())
    iso_b = fit_isotonic(dev.loc[half_b, "p_incumbent"].to_numpy(),
                         dev.loc[half_b, "y"].to_numpy())
    p_cf = np.empty(len(dev))
    p_cf[half_b.to_numpy()] = iso_a.predict(dev.loc[half_b, "p_incumbent"])
    p_cf[half_a.to_numpy()] = iso_b.predict(dev.loc[half_a, "p_incumbent"])
    dev["p_cal_crossfit"] = p_cf

    # ---- 2. production candidate: isotonic on ALL 2024 dev data ----
    iso_full = fit_isotonic(dev.p_incumbent.to_numpy(), dev.y.to_numpy())
    dev["p_cal"] = iso_full.predict(dev.p_incumbent.to_numpy())

    calibrator = {
        "method": "sklearn IsotonicRegression(out_of_bounds='clip', y_min=0, y_max=1)",
        "fitted_on": f"{DEV_SEASON} development season only (all weeks)",
        "n_fit_rows": int(len(dev)),
        "fit_positive_rate": float(dev.y.mean()),
        "underlying_model": "frozen logistic incumbent (2023 training season, C=0.01)",
        "full_fit": describe(iso_full),
        "crossfit_halfA_fit": describe(iso_a),
        "crossfit_halfB_fit": describe(iso_b),
    }
    with open(ARTIFACTS / "isotonic_calibrator.json", "w") as f:
        json.dump(calibrator, f, indent=2)
    joblib.dump(iso_full, ARTIFACTS / "isotonic_calibrator.joblib")
    dev.to_csv(ARTIFACTS / f"candidate_predictions_{DEV_SEASON}.csv.gz", index=False)

    print(f"[isotonic] fitted on {len(dev):,} dev rows "
          f"(positive rate {dev.y.mean():.4f})")
    print(f"[isotonic] full-fit knots={calibrator['full_fit']['n_knots']}, "
          f"output range {calibrator['full_fit']['output_range']}")
    print("[isotonic] input->output probes:",
          {k: round(v, 3) for k, v in calibrator["full_fit"]["probe_input_to_output"].items()})

    # ---- 3. apply the frozen full-2024 calibrator to other seasons ----
    for season in SEASONS_MODELED:
        if season == DEV_SEASON:
            continue
        df = pd.read_csv(ARTIFACTS / f"incumbent_predictions_{season}.csv.gz")
        df["p_cal"] = iso_full.predict(df.p_incumbent.to_numpy())
        df.to_csv(ARTIFACTS / f"candidate_predictions_{season}.csv.gz", index=False)
        n30 = int((df.p_cal >= 0.30).sum())
        n25 = int((df.p_cal >= 0.25).sum())
        print(f"[apply {season}] rows={len(df):,} p_cal>=0.25: {n25:,} "
              f"p_cal>=0.30: {n30:,} max p_cal={df.p_cal.max():.3f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
