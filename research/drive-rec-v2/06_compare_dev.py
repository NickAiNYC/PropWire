"""06_compare_dev.py — incumbent vs recalibrated candidate ON DEVELOPMENT DATA ONLY.

Decision 2C, item 2: this comparison happens on 2024 development data BEFORE any
further holdout evaluation. All candidate numbers here use the CROSS-FITTED isotonic
(fit on weeks 1-9 -> applied to weeks 10-18, and vice versa), so no dev row is scored
by a calibrator that saw its own half-season. The full-fit in-sample variant is also
reported but explicitly labeled in-sample.

Outputs: artifacts/dev_comparison.json
"""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ARTIFACTS, DEV_SEASON  # noqa: E402
from lib.metrics import (auc, brier, clustered_diff_ci, clustered_gap_ci,
                         ece_decile, logloss, reliability_table,
                         top_decile_stats)  # noqa: E402


def model_block(df: pd.DataFrame, p_col: str) -> dict:
    y = df.y.to_numpy()
    p = df[p_col].to_numpy()
    g = df.game_id.to_numpy()
    return {
        "brier": brier(y, p), "log_loss": logloss(y, p), "auc": auc(y, p),
        "ece_decile": ece_decile(y, p),
        "top_decile": top_decile_stats(y, p),
        "tail_slices": {
            f"{p_col} >= 0.25": clustered_gap_ci(p[p >= 0.25], y[p >= 0.25], g[p >= 0.25]),
            f"{p_col} >= 0.30": clustered_gap_ci(p[p >= 0.30], y[p >= 0.30], g[p >= 0.30]),
            f"{p_col} >= 0.40": clustered_gap_ci(p[p >= 0.40], y[p >= 0.40], g[p >= 0.40]),
        },
        "reliability": reliability_table(y, p, bins=10),
    }


def main() -> int:
    dev = pd.read_csv(ARTIFACTS / f"candidate_predictions_{DEV_SEASON}.csv.gz")
    y = dev.y.to_numpy()
    g = dev.game_id.to_numpy()

    inc = model_block(dev, "p_incumbent")
    cand_cf = model_block(dev, "p_cal_crossfit")
    cand_full = model_block(dev, "p_cal")  # in-sample for the calibrator

    diffs = {
        "brier_candidate_crossfit_minus_incumbent": clustered_diff_ci(
            (dev.p_cal_crossfit - y) ** 2, (dev.p_incumbent - y) ** 2, g),
        "logloss_candidate_crossfit_minus_incumbent": clustered_diff_ci(
            -np.where(dev.y == 1, np.log(np.clip(dev.p_cal_crossfit, 1e-6, 1)),
                      np.log(np.clip(1 - dev.p_cal_crossfit, 1e-6, 1))),
            -np.where(dev.y == 1, np.log(np.clip(dev.p_incumbent, 1e-6, 1)),
                      np.log(np.clip(1 - dev.p_incumbent, 1e-6, 1))), g),
        "brier_candidate_fullfit_insample_minus_incumbent": clustered_diff_ci(
            (dev.p_cal - y) ** 2, (dev.p_incumbent - y) ** 2, g),
    }

    out = {
        "season": DEV_SEASON,
        "comparison_order": "development data only; evaluated before any holdout "
                            "evaluation of the candidate (Decision 2C item 2)",
        "candidate_variant": "cross-fitted isotonic (weeks 1-9 <-> weeks 10-18)",
        "n_rows": int(len(dev)),
        "n_games": int(dev.game_id.nunique()),
        "incumbent": inc,
        "candidate_crossfit": cand_cf,
        "candidate_fullfit_insample": cand_full,
        "clustered_differences": diffs,
    }
    with open(ARTIFACTS / "dev_comparison.json", "w") as f:
        json.dump(out, f, indent=2)

    for name, blk in [("incumbent", inc), ("candidate (crossfit)", cand_cf)]:
        t30 = blk["tail_slices"].get(f"{'p_incumbent' if 'incumbent' in name else 'p_cal'} >= 0.30")
        print(f"[dev {name}] brier={blk['brier']:.4f} logloss={blk['log_loss']:.4f} "
              f"auc={blk['auc']:.4f} ece={blk['ece_decile']:.4f}")
    d = diffs["brier_candidate_crossfit_minus_incumbent"]
    print(f"[dev] Brier diff (candidate-incumbent): {d['diff']:+.5f} "
          f"CI[{d['ci_low']:+.5f},{d['ci_high']:+.5f}]")
    print("[dev comparison] written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
