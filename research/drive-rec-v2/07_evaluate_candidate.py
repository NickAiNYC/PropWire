"""07_evaluate_candidate.py — evaluate the recalibrated candidate under criteria v3.

Slices evaluated (criteria v3, frozen in artifacts/criteria_v3.json BEFORE this run):
  * HOLDOUT_2025 — previously inspected holdout (label enforced everywhere).
  * UNSEEN_2026 — genuinely unseen prospective slice (weeks 1-7).

Checks implemented here: C1 (sample adequacy), C2 (top-decile calibration),
C3 (alert-region calibration, incl. the incumbent's original p >= 0.30 operating
point), C5 (global non-degradation), C6 (clustered uncertainty bounds), and
prospective-slice reporting. C4 (EV-band calibration) and C7/C8 (economic gate) are
implemented in 08_ev_reliability_gate.py; the fail-closed promotion verdict (C9) is
assembled by 09_make_report.py from both outputs.

Outputs: artifacts/candidate_evaluation_<season>.json
"""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ARTIFACTS, HOLDOUT_SEASON, SEASONS_MODELED, TRAIN_SEASON, \
    UNSEEN_SEASON  # noqa: E402
from lib.metrics import (auc, brier, clustered_diff_ci, clustered_gap_ci,
                         ece_decile, logloss, reliability_table,
                         top_decile_stats)  # noqa: E402

C = json.load(open(ARTIFACTS / "criteria_v3.json"))
POINT_ABS = C["C2_top_decile_calibration"]["point_gap_abs_max"]          # 0.030
POINT_REL = C["C2_top_decile_calibration"]["point_gap_rel_max"]          # 0.10
CI_CONTAIN = C["C2_top_decile_calibration"]["ci_containment_abs"]        # 0.050
MIN_N = 300
MIN_GAMES = 25

SEASON_NOTES = {
    HOLDOUT_SEASON: "PREVIOUSLY INSPECTED HOLDOUT — informed model-development "
                    "decisions; not an untouched final test set (Decision 2C).",
    UNSEEN_SEASON: "GENUINELY UNSEEN — no development decision in this rebuild has "
                   "used 2026 data; weeks 1-7.",
}


def gap_check(df_sl: pd.DataFrame, p_col: str) -> dict:
    """C1 + C2/C3-style check on one slice using one probability column."""
    n = int(len(df_sl))
    games = int(df_sl.game_id.nunique())
    if n < MIN_N or games < MIN_GAMES:
        return {"status": "LOW_SAMPLE", "n": n, "n_games": games,
                "note": f"below MIN_N={MIN_N} or MIN_GAMES={MIN_GAMES}; cannot "
                        f"support PASS (fail-closed)"}
    stats = clustered_gap_ci(df_sl[p_col].to_numpy(), df_sl.y.to_numpy(),
                             df_sl.game_id.to_numpy())
    gap = stats["gap_obs_minus_pred"]           # obs - pred (negative = overprediction)
    rel = abs(gap / stats["obs_rate"]) if stats["obs_rate"] > 0 else None
    point_ok = abs(gap) <= POINT_ABS and (rel is not None and rel <= POINT_REL)
    ci_ok = -CI_CONTAIN <= stats["gap_ci_low"] and stats["gap_ci_high"] <= CI_CONTAIN
    stats.update({
        "n": n, "n_games": games,
        "relative_gap": None if rel is None else float(rel),
        "point_threshold_pass": bool(point_ok),
        "ci_containment_pass": bool(ci_ok),
        "status": "PASS" if (point_ok and ci_ok) else "FAIL",
        "thresholds": {"abs": POINT_ABS, "rel": POINT_REL, "ci_contain": CI_CONTAIN},
    })
    return stats


def main() -> int:
    results = {"criteria_v3_sha256": C["content_sha256"], "seasons": {}}

    for season in (HOLDOUT_SEASON, UNSEEN_SEASON):
        df = pd.read_csv(ARTIFACTS / f"candidate_predictions_{season}.csv.gz")
        y = df.y.to_numpy()
        g = df.game_id.to_numpy()
        p_inc = df.p_incumbent.to_numpy()
        p_cal = df.p_cal.to_numpy()

        inc_global = {"brier": brier(y, p_inc), "log_loss": logloss(y, p_inc),
                      "auc": auc(y, p_inc), "ece_decile": ece_decile(y, p_inc)}
        cal_global = {"brier": brier(y, p_cal), "log_loss": logloss(y, p_cal),
                      "auc": auc(y, p_cal), "ece_decile": ece_decile(y, p_cal)}

        diffs = {
            "brier_cal_minus_inc": clustered_diff_ci((p_cal - y) ** 2,
                                                     (p_inc - y) ** 2, g),
            "logloss_cal_minus_inc": clustered_diff_ci(
                -np.where(y == 1, np.log(np.clip(p_cal, 1e-6, 1)),
                          np.log(np.clip(1 - p_cal, 1e-6, 1))),
                -np.where(y == 1, np.log(np.clip(p_inc, 1e-6, 1)),
                          np.log(np.clip(1 - p_inc, 1e-6, 1))), g),
        }

        c5 = {
            "brier_ok": bool(cal_global["brier"] <= inc_global["brier"]
                             + C["C5_global_non_degradation"]["brier_tolerance"]),
            "log_loss_ok": bool(cal_global["log_loss"] <= inc_global["log_loss"]
                                + C["C5_global_non_degradation"]["log_loss_tolerance"]),
            "auc_ok": bool(cal_global["auc"] >= inc_global["auc"]
                           - C["C5_global_non_degradation"]["auc_tolerance"]),
            "ece_ok": bool(cal_global["ece_decile"] <= inc_global["ece_decile"]),
        }
        c5["status"] = "PASS" if all(v for k, v in c5.items() if k.endswith("_ok")) \
            else "FAIL"

        checks = {
            "C2_top_decile": {
                "incumbent": top_decile_stats(y, p_inc),
                "candidate": top_decile_stats(y, p_cal),
                "candidate_check": None,
            },
            "C3_alert_regions": {
                "primary": {
                    "p_cal >= 0.25": gap_check(df[df.p_cal >= 0.25], "p_cal"),
                    "p_cal >= 0.30": gap_check(df[df.p_cal >= 0.30], "p_cal"),
                },
                "secondary_reported_only": {
                    "p_cal >= 0.35": gap_check(df[df.p_cal >= 0.35], "p_cal"),
                    "p_cal >= 0.40": gap_check(df[df.p_cal >= 0.40], "p_cal"),
                },
                "incumbent_operating_point": {
                    "p_inc >= 0.30 rows, candidate p_cal vs obs":
                        gap_check(df[df.p_incumbent >= 0.30], "p_cal"),
                    "p_inc >= 0.30 rows, incumbent p vs obs (reference)":
                        gap_check(df[df.p_incumbent >= 0.30], "p_incumbent"),
                    "p_inc >= 0.40 rows, candidate p_cal vs obs":
                        gap_check(df[df.p_incumbent >= 0.40], "p_cal"),
                },
            },
            "C5_global_non_degradation": c5,
        }

        # C2 on the candidate's own top decile
        td = top_decile_stats(y, p_cal)
        m = p_cal >= td["threshold"]
        c2 = gap_check(df[m], "p_cal")
        c2["decile_threshold"] = td["threshold"]
        checks["C2_top_decile"]["candidate_check"] = c2

        # prospective slices (informational, both models)
        pros = {}
        for dim, keyfn in [
            ("position", lambda r: r.pos_group),
            ("game_state", lambda r: ("leading" if r.score_diff > 0 else
                                      "trailing" if r.score_diff < 0 else "tied")),
            ("two_minute", lambda r: "two_min" if r.two_min == 1 else "normal"),
            ("half", lambda r: "first_half" if r.qtr <= 2 else "second_half_ot"),
        ]:
            pros[dim] = {}
            for key, sub in df.groupby(df.apply(keyfn, axis=1)):
                if len(sub) < MIN_N:
                    continue
                s_cal = clustered_gap_ci(sub.p_cal.to_numpy(), sub.y.to_numpy(),
                                         sub.game_id.to_numpy())
                s_inc = clustered_gap_ci(sub.p_incumbent.to_numpy(), sub.y.to_numpy(),
                                         sub.game_id.to_numpy())
                pros[dim][key] = {
                    "n": int(len(sub)),
                    "candidate": {k: s_cal[k] for k in
                                  ("mean_pred", "obs_rate", "gap_obs_minus_pred",
                                   "gap_ci_low", "gap_ci_high")},
                    "incumbent": {k: s_inc[k] for k in
                                  ("mean_pred", "obs_rate", "gap_obs_minus_pred",
                                   "gap_ci_low", "gap_ci_high")},
                }

        results["seasons"][season] = {
            "label": SEASON_NOTES[season],
            "rows": int(len(df)), "games": int(df.game_id.nunique()),
            "global": {"incumbent": inc_global, "candidate": cal_global,
                       "clustered_differences": diffs},
            "reliability": {"incumbent": reliability_table(y, p_inc, bins=10),
                            "candidate": reliability_table(y, p_cal, bins=10)},
            "criteria_checks": checks,
            "prospective_slices": pros,
        }

        # console summary
        print(f"[{season}] {SEASON_NOTES[season][:60]}...")
        print(f"  global: brier {inc_global['brier']:.4f}->{cal_global['brier']:.4f} "
              f"(d={diffs['brier_cal_minus_inc']['diff']:+.5f}), "
              f"logloss {inc_global['log_loss']:.4f}->{cal_global['log_loss']:.4f}, "
              f"auc {inc_global['auc']:.4f}->{cal_global['auc']:.4f}, "
              f"ece {inc_global['ece_decile']:.4f}->{cal_global['ece_decile']:.4f}")
        print(f"  C5: {c5['status']}")
        for k, v in checks["C3_alert_regions"]["primary"].items():
            print(f"  C3 {k}: {v['status']} (n={v.get('n')}, "
                  f"gap={v.get('gap_obs_minus_pred')}, "
                  f"CI=[{v.get('gap_ci_low'):.4f},{v.get('gap_ci_high'):.4f}])"
                  if v.get("n") else f"  C3 {k}: {v}")
        print(f"  C2 top decile: {c2['status']} (n={c2.get('n')}, "
              f"gap={c2.get('gap_obs_minus_pred')})")
        for k, v in checks["C3_alert_regions"]["incumbent_operating_point"].items():
            print(f"  anchor {k}: {v['status']}" if v.get("n") else f"  anchor {k}: {v}")

    with open(ARTIFACTS / "candidate_evaluation.json", "w") as f:
        json.dump(results, f, indent=2)
    print("[candidate evaluation] written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
