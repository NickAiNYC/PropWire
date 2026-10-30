"""02_fit_incumbent.py — fit the FROZEN logistic incumbent on the 2023 season.

Design (rebuild spec, documented in README):
  * Training data: 2023 regular season only.
  * Hyperparameter (L2 strength) selection: temporal CV INSIDE 2023
    (weeks 1-9 train -> weeks 10-18 validation). The 2024 development season is
    therefore fully out-of-sample with respect to the logistic fit and remains
    pristine for isotonic recalibration (Decision 2C, item 1).
  * After selection, the model is refit on all of 2023 and FROZEN. Nothing in
    scripts 03-09 modifies it.
  * Out-of-sample predictions are emitted for 2024 (development), 2025
    (previously inspected holdout) and 2026 (genuinely unseen, weeks 1-7).

Outputs:
  artifacts/incumbent_model.json        coefficients, scaler stats, CV table
  artifacts/incumbent_model.joblib      (gitignored, reproducible via this script)
  artifacts/incumbent_predictions_<season>.csv.gz   row-level predictions + keys
"""

from __future__ import annotations

import json
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ALL_FEATURES, ARTIFACTS, DATA, DEV_SEASON, HOLDOUT_SEASON, \
    SEASONS_MODELED, TRAIN_SEASON, UNSEEN_SEASON  # noqa: E402

PRED_COLS = [
    "game_id", "season", "week", "drive", "drive_idx_team", "posteam", "defteam",
    "player_id", "player_name", "pos_group", "y",
    "b1_empirical", "b2_target_share", "b3_possession_survival",
    "qtr", "game_secs_rem", "score_diff", "two_min", "yardline_100_start",
    "p_blend_share", "p_ingame_tgts_so_far",
    "lag1_row", "lag2_row", "lag4_row", "drive_idx_team",
]

C_GRID = [0.01, 0.03, 0.1, 0.3, 1.0, 3.0]


def main() -> int:
    frames = {s: pd.read_parquet(DATA / f"player_drives_{s}.parquet")
              for s in SEASONS_MODELED}
    train = frames[TRAIN_SEASON]

    # ---- temporal CV inside the training season (weeks 1-9 -> weeks 10-18) ----
    tr_a = train[train.week <= 9]
    tr_b = train[train.week >= 10]
    cv_table = []
    for c in C_GRID:
        pipe = Pipeline([
            ("scale", StandardScaler()),
            ("lr", LogisticRegression(penalty="l2", C=c, solver="lbfgs",
                                      max_iter=3000, random_state=0)),
        ])
        pipe.fit(tr_a[ALL_FEATURES], tr_a.y)
        p = pipe.predict_proba(tr_b[ALL_FEATURES])[:, 1]
        cv_table.append({
            "C": c,
            "val_log_loss": float(log_loss(tr_b.y, p, labels=[0, 1])),
            "val_brier": float(brier_score_loss(tr_b.y, p)),
            "val_auc": float(roc_auc_score(tr_b.y, p)),
        })
        print(f"[cv] C={c}: logloss={cv_table[-1]['val_log_loss']:.4f} "
              f"brier={cv_table[-1]['val_brier']:.4f} auc={cv_table[-1]['val_auc']:.4f}")
    best = min(cv_table, key=lambda r: r["val_log_loss"])
    print(f"[cv] chosen C={best['C']} by validation log loss (weeks 10-18, 2023)")

    # ---- refit on ALL of 2023 and freeze ----
    incumbent = Pipeline([
        ("scale", StandardScaler()),
        ("lr", LogisticRegression(penalty="l2", C=best["C"], solver="lbfgs",
                                  max_iter=3000, random_state=0)),
    ])
    incumbent.fit(train[ALL_FEATURES], train.y)
    joblib.dump(incumbent, ARTIFACTS / "incumbent_model.joblib")

    lr = incumbent.named_steps["lr"]
    sc = incumbent.named_steps["scale"]
    model_json = {
        "model": "logistic_regression_l2",
        "train_season": TRAIN_SEASON,
        "train_rows": int(len(train)),
        "train_positive_rate": float(train.y.mean()),
        "features": ALL_FEATURES,
        "C": best["C"],
        "cv_split": "2023 weeks 1-9 train / weeks 10-18 validation (temporal)",
        "cv_table": cv_table,
        "scaler_mean": [float(v) for v in sc.mean_],
        "scaler_scale": [float(v) for v in sc.scale_],
        "coef": [float(v) for v in lr.coef_[0]],
        "intercept": float(lr.intercept_[0]),
    }
    with open(ARTIFACTS / "incumbent_model.json", "w") as f:
        json.dump(model_json, f, indent=2)

    # ---- out-of-sample predictions ----
    for season in SEASONS_MODELED:
        df = frames[season]
        p = incumbent.predict_proba(df[ALL_FEATURES])[:, 1]
        out = df[PRED_COLS].copy()
        out["p_incumbent"] = p
        out.to_csv(ARTIFACTS / f"incumbent_predictions_{season}.csv.gz", index=False)

        in_sample = season == TRAIN_SEASON
        metrics = {
            "season": season,
            "rows": int(len(df)),
            "games": int(df.game_id.nunique()),
            "in_sample_wrt_logistic_fit": in_sample,
            "brier": float(brier_score_loss(df.y, p)),
            "log_loss": float(log_loss(df.y, p, labels=[0, 1])),
            "auc": float(roc_auc_score(df.y, p)),
        }
        tail = df[p >= 0.30]
        metrics["tail_p_ge_030"] = {
            "n": int(len(tail)),
            "mean_predicted": float(p[p >= 0.30].mean()) if len(tail) else None,
            "observed_rate": float(tail.y.mean()) if len(tail) else None,
        }
        for b in ("b1_empirical", "b2_target_share", "b3_possession_survival"):
            metrics[f"{b}_brier"] = float(brier_score_loss(df.y, df[b]))
            metrics[f"{b}_log_loss"] = float(log_loss(df.y, df[b], labels=[0, 1]))
        print(f"[{season}] rows={len(df):,} brier={metrics['brier']:.4f} "
              f"logloss={metrics['log_loss']:.4f} auc={metrics['auc']:.4f} "
              f"tail(n={metrics['tail_p_ge_030']['n']}, "
              f"pred={metrics['tail_p_ge_030']['mean_predicted']}, "
              f"obs={metrics['tail_p_ge_030']['observed_rate']})")

    print("[incumbent] frozen and predictions emitted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
