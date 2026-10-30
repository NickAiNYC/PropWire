"""03_evaluate_incumbent.py — evaluation of the frozen incumbent (the "before" picture).

This re-establishes, with freshly measured numbers, the status-quo calibration profile
that motivated Decision 2C: global metrics vs the three baselines, reliability tables,
and the high-probability tail slices where the alert engine would operate, with
game-clustered bootstrap intervals on the tail gaps.

The 2025 season is evaluated as a PREVIOUSLY INSPECTED HOLDOUT (it informed
model-development decisions in the prior research cycle and in this rebuild it is
inspected here, before the candidate evaluation). The 2026 season is evaluated as a
GENUINELY UNSEEN prospective slice (weeks 1-7, no development decision has ever used it).

Outputs: artifacts/incumbent_evaluation.json, artifacts/incumbent_reliability_<season>.csv
"""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ARTIFACTS, DEV_SEASON, HOLDOUT_SEASON, SEASONS_MODELED, \
    TRAIN_SEASON, UNSEEN_SEASON  # noqa: E402
from lib.metrics import (auc, brier, clustered_gap_ci, ece_decile, logloss,
                         reliability_table, top_decile_stats)  # noqa: E402

TAIL_THRESHOLDS = [0.25, 0.30, 0.35, 0.40]
SEASON_LABELS = {
    TRAIN_SEASON: "training (in-sample reference)",
    DEV_SEASON: "development",
    HOLDOUT_SEASON: "previously inspected holdout",
    UNSEEN_SEASON: "genuinely unseen prospective (weeks 1-7)",
}


def main() -> int:
    result = {"evaluated_at_note": "frozen logistic incumbent; no recalibration applied",
              "seasons": {}}

    for season in SEASONS_MODELED:
        df = pd.read_csv(ARTIFACTS / f"incumbent_predictions_{season}.csv.gz")
        p, y, g = df.p_incumbent.to_numpy(), df.y.to_numpy(), df.game_id.to_numpy()

        entry = {
            "label": SEASON_LABELS.get(season, str(season)),
            "rows": int(len(df)), "games": int(df.game_id.nunique()),
            "global": {
                "brier": brier(y, p), "log_loss": logloss(y, p), "auc": auc(y, p),
                "ece_decile": ece_decile(y, p),
            },
            "baselines": {
                b: {"brier": brier(y, df[b].to_numpy()),
                    "log_loss": logloss(y, df[b].to_numpy())}
                for b in ("b1_empirical", "b2_target_share", "b3_possession_survival")
            },
            "top_decile": top_decile_stats(y, p),
            "tail_slices": {},
        }

        for thr in TAIL_THRESHOLDS:
            m = p >= thr
            if m.sum() == 0:
                entry["tail_slices"][f"p_ge_{thr:.2f}"] = {"n": 0}
                continue
            stats = clustered_gap_ci(p[m], y[m], g[m])
            stats["relative_gap_pred_over_obs"] = (
                float((p[m].mean() - y[m].mean()) / y[m].mean())
                if y[m].mean() > 0 else None)
            entry["tail_slices"][f"p_ge_{thr:.2f}"] = stats

        rel = reliability_table(y, p, bins=10)
        pd.DataFrame(rel).to_csv(
            ARTIFACTS / f"incumbent_reliability_{season}.csv", index=False)
        entry["reliability"] = rel

        result["seasons"][season] = entry

        td = entry["top_decile"]
        t30 = entry["tail_slices"].get("p_ge_0.30", {})
        print(f"[{season} {SEASON_LABELS.get(season, '')}] "
              f"brier={entry['global']['brier']:.4f} auc={entry['global']['auc']:.4f} "
              f"ece={entry['global']['ece_decile']:.4f} | "
              f"topdec(n={td['n']}, pred={td['mean_pred']:.3f}, obs={td['obs_rate']:.3f}) | "
              f"p>=.30(n={t30.get('n')}, pred={t30.get('mean_pred')}, "
              f"obs={t30.get('obs_rate')}, gap={t30.get('gap_obs_minus_pred')}, "
              f"CI=[{t30.get('gap_ci_low'):.4f},{t30.get('gap_ci_high'):.4f}])"
              if t30.get("n") else "p>=.30 empty")

    with open(ARTIFACTS / "incumbent_evaluation.json", "w") as f:
        json.dump(result, f, indent=2)
    print("[incumbent evaluation] written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
