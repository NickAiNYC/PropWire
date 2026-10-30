"""08_ev_reliability_gate.py — economic reliability gate with SIMULATED quotes.

*** ALL PRICE-BASED RESULTS IN THIS SCRIPT ARE HYPOTHETICAL. ***
The historical corpus contains no genuine contemporaneous market quotes. Quotes here are
synthetic, constructed exactly as frozen in criteria v3 (C8) BEFORE candidate
evaluation:

  market reference probability = calibrated probability of the same player computed
  from the feature row of the team drive K drives earlier in the same game (a stale,
  less-informed version of the calibrated model). For a player's first drive of a game
  (or when no earlier row exists within K drives), the reference is a
  context-neutralized row (league-median context, zero in-game counters).

  quote        Q = reference * (1 + vig),  clipped to [0.01, 0.95]
  executed odds D = 1 / (Q * (1 + slippage))
  model EV       = p_model * D - 1
  realized return R = y * D - 1

Baseline scenario: vig=0.06, K=1, slippage=0.02. Sensitivity grid: vig x latency x
slippage as frozen in criteria v3. This analysis measures how claimed edges survive
calibration error, price quality and latency UNDER THESE ASSUMPTIONS ONLY. It cannot
establish executable betting profitability, and it never touches a real sportsbook
adapter (all adapters remain disabled).

Outputs: artifacts/ev_gate_<season>.json, artifacts/ev_gate_sensitivity_<season>.csv
"""

from __future__ import annotations

import bisect
import json
import sys

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ALL_FEATURES, ARTIFACTS, DATA, DEV_SEASON, FEATURE_BLOCKS, \
    HOLDOUT_SEASON, UNSEEN_SEASON  # noqa: E402
from lib.metrics import clustered_gap_ci, clustered_mean_ci  # noqa: E402

BASELINE = {"vig": 0.06, "latency": 1, "slippage": 0.02}
EV_BANDS = [0.0, 0.03, 0.05, 0.08]
PROB_THRESHOLDS = [0.25, 0.30]
ALERT_REGION_MIN_P = 0.25   # the engine's conviction gate: EV bands are evaluated
                            # within p_model >= 0.25, per Decision 2C's "regions where
                            # the alert engine would operate"
SENSITIVITY = {
    "vig": [0.03, 0.06, 0.10],
    "latency": [0, 1, 2, 4, "frozen_pregame"],
    "slippage": [0.00, 0.02, 0.05],
}
C = json.load(open(ARTIFACTS / "criteria_v3.json"))
C4_MAX_GAP = C["C4_ev_band_probability_calibration"]["point_gap_abs_max"]
C4_MIN_N = C["C4_ev_band_probability_calibration"]["min_n_per_band"]


# ---------------------------------------------------------------------------
# Reference probabilities (stale market model)
# ---------------------------------------------------------------------------

def neutral_reference(pred: pd.DataFrame, pdf: pd.DataFrame, model, iso) -> np.ndarray:
    """Context-neutralized calibrated probability (pre-game quote level)."""
    ctx_cols = FEATURE_BLOCKS["context"]
    med = pd.read_parquet(DATA / f"player_drives_{DEV_SEASON}.parquet",
                          columns=ctx_cols).median()
    first = pred.drive_idx_team == 1
    feats = pdf.loc[first, ALL_FEATURES].copy()
    for c in ctx_cols:
        feats[c] = float(med[c])
    feats["drive_idx_team"] = 1.0
    p = model.predict_proba(feats)[:, 1]
    out = np.full(len(pred), np.nan)
    out[first.to_numpy()] = iso.predict(p)
    return out


def lag_references(pred: pd.DataFrame, neutral: np.ndarray) -> dict:
    """Reference probabilities for latencies 0,1,2,4 and 'frozen_pregame'.

    latency K = the most recent same-player row at least K team-drives earlier;
    if none exists, the pre-game neutral reference.
    """
    order = pred.sort_values(["game_id", "player_id", "drive_idx_team"])
    groups = {}
    for pos, (gid, pid, didx) in enumerate(
            zip(order.game_id, order.player_id, order.drive_idx_team)):
        groups.setdefault((gid, pid), []).append((int(didx), pos))

    refs = {k: np.full(len(pred), np.nan) for k in (0, 1, 2, 4)}
    for (gid, pid), entries in groups.items():
        didx = [e[0] for e in entries]
        pos = [e[1] for e in entries]
        for k in (0, 1, 2, 4):
            for (d, p) in entries:
                target = d - k
                i = bisect.bisect_right(didx, target) - 1
                if i >= 0:
                    refs[k][p] = pred.p_cal.to_numpy()[pos[i]]
                else:
                    refs[k][p] = neutral[p]
    return refs


# ---------------------------------------------------------------------------
# EV analysis
# ---------------------------------------------------------------------------

def band_stats(df, mask, p_col, D) -> dict:
    sub = df.loc[mask]
    if len(sub) == 0:
        return {"n": 0}
    p, y = sub[p_col].to_numpy(), sub.y.to_numpy()
    g = sub.game_id.to_numpy()
    ev = p * D[mask] - 1.0
    ret = y * D[mask] - 1.0
    freq_ci = clustered_gap_ci(np.zeros(len(sub)), y, g)  # CI of observed rate itself
    ret_ci = clustered_mean_ci(ret, g)
    ev_ci = clustered_mean_ci(ev, g)
    out = {
        "n": int(len(sub)), "n_games": int(sub.game_id.nunique()),
        "mean_pred_prob": float(p.mean()),
        "realized_freq": float(y.mean()),
        "prob_gap_obs_minus_pred": float(y.mean() - p.mean()),
        "realized_freq_ci": [freq_ci["gap_ci_low"], freq_ci["gap_ci_high"]],
        "mean_predicted_ev": float(ev.mean()),
        "median_predicted_ev": float(np.median(ev)),
        "mean_predicted_ev_ci": [ev_ci["ci_low"], ev_ci["ci_high"]],
        "mean_realized_return": float(ret.mean()),
        "median_realized_return": float(np.median(ret)),
        "mean_realized_return_ci": [ret_ci["ci_low"], ret_ci["ci_high"]],
        "mean_decimal_odds": float(D[mask].mean()),
        "median_decimal_odds": float(np.median(D[mask])),
        "share_quotes_implied_prob_lt_5pct": float((D[mask] > 20).mean()),
    }
    return out


def c4_check(stats: dict) -> dict:
    if stats.get("n", 0) == 0:
        return {"status": "LOW_SAMPLE", "reason": "no qualifying observations"}
    if stats["n"] < C4_MIN_N:
        return {"status": "LOW_SAMPLE",
                "reason": f"n={stats['n']} < {C4_MIN_N}; cannot support PASS"}
    ok = abs(stats["prob_gap_obs_minus_pred"]) <= C4_MAX_GAP
    return {"status": "PASS" if ok else "FAIL",
            "gap": stats["prob_gap_obs_minus_pred"],
            "threshold": C4_MAX_GAP}


def analyze(df, p_col, ref, vig, slippage) -> dict:
    Q = np.clip(np.asarray(ref) * (1 + vig), 0.01, 0.95)
    D = 1.0 / (Q * (1 + slippage))
    alert_region = df[p_col].to_numpy() >= ALERT_REGION_MIN_P
    out = {
        "alert_region_note": (
            f"EV bands are evaluated within the alert region {p_col} >= "
            f"{ALERT_REGION_MIN_P} (the engine's conviction gate). Probability "
            "thresholds below are unconditional."),
        "ev_bands": {},
        "prob_thresholds": {},
    }
    for b in EV_BANDS:
        ev = df[p_col].to_numpy() * D - 1.0
        mask = (ev >= b) & alert_region
        out["ev_bands"][f"EV >= {b:.0%}"] = band_stats(df, mask, p_col, D)
    for thr in PROB_THRESHOLDS:
        mask = df[p_col].to_numpy() >= thr
        out["prob_thresholds"][f"{p_col} >= {thr:.2f}"] = band_stats(df, mask, p_col, D)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    model = joblib.load(ARTIFACTS / "incumbent_model.joblib")
    iso = joblib.load(ARTIFACTS / "isotonic_calibrator.joblib")

    for season in (HOLDOUT_SEASON, UNSEEN_SEASON):
        pred = pd.read_csv(ARTIFACTS / f"candidate_predictions_{season}.csv.gz")
        pdf = pd.read_parquet(DATA / f"player_drives_{season}.parquet")
        assert len(pred) == len(pdf), "row alignment broken"

        neutral = neutral_reference(pred, pdf, model, iso)
        refs = lag_references(pred, neutral)
        refs["frozen_pregame"] = neutral

        # ---------------- baseline scenario ----------------
        base = {
            "scenario": "BASELINE (frozen in criteria v3 C8 before evaluation)",
            "vig": BASELINE["vig"], "latency_drives": BASELINE["latency"],
            "execution_slippage": BASELINE["slippage"],
            "hypothetical": True,
            "incumbent": analyze(pred, "p_incumbent", refs[BASELINE["latency"]],
                                 BASELINE["vig"], BASELINE["slippage"]),
            "candidate": analyze(pred, "p_cal", refs[BASELINE["latency"]],
                                 BASELINE["vig"], BASELINE["slippage"]),
        }
        base["c4_checks_candidate"] = {
            k: c4_check(v) for k, v in base["candidate"]["ev_bands"].items()
        }

        # ---------------- sensitivity grid ----------------
        grid_rows = []
        for vig in SENSITIVITY["vig"]:
            for lat in SENSITIVITY["latency"]:
                for slip in SENSITIVITY["slippage"]:
                    ref = refs[lat] if lat != "frozen_pregame" else refs["frozen_pregame"]
                    for p_col, mname in (("p_cal", "candidate"), ("p_incumbent", "incumbent")):
                        Q = np.clip(np.asarray(ref) * (1 + vig), 0.01, 0.95)
                        D = 1.0 / (Q * (1 + slip))
                        ev = pred[p_col].to_numpy() * D - 1.0
                        region = pred[p_col].to_numpy() >= ALERT_REGION_MIN_P
                        for b in (0.03, 0.05):
                            m = (ev >= b) & region
                            if m.sum() == 0:
                                grid_rows.append({"vig": vig, "latency": str(lat),
                                                  "slippage": slip, "model": mname,
                                                  "band": f"EV>={b:.0%}", "n": 0})
                                continue
                            st = band_stats(pred, m, p_col, D)
                            grid_rows.append({
                                "vig": vig, "latency": str(lat), "slippage": slip,
                                "model": mname, "band": f"EV>={b:.0%}",
                                "n": st["n"],
                                "mean_pred_prob": st["mean_pred_prob"],
                                "realized_freq": st["realized_freq"],
                                "mean_predicted_ev": st["mean_predicted_ev"],
                                "mean_realized_return": st["mean_realized_return"],
                                "return_ci_low": st["mean_realized_return_ci"][0],
                                "return_ci_high": st["mean_realized_return_ci"][1],
                            })
        grid = pd.DataFrame(grid_rows)
        grid.to_csv(ARTIFACTS / f"ev_gate_sensitivity_{season}.csv", index=False)

        out = {
            "season": season,
            "label": ("previously inspected holdout" if season == HOLDOUT_SEASON
                      else "genuinely unseen prospective (weeks 1-7)"),
            "hypothetical_warning": (
                "SIMULATED PRICES ONLY. The corpus contains no genuine contemporaneous "
                "market quotes; every EV/return number below is hypothetical and cannot "
                "establish executable betting profitability."),
            "quote_construction": C["C8_baseline_quote_scenario"],
            "analysis_note": (
                "EV bands are evaluated within the alert region (model probability "
                ">= 0.25). An initial unconditional implementation was dominated by "
                "longshot quotes outside the engine's operating region; the restriction "
                "to the alert region matches Decision 2C's requirement to evaluate "
                "'the regions where the alert engine would operate'. Quote construction "
                "parameters are exactly as frozen in criteria v3."),
            "baseline": base,
        }
        with open(ARTIFACTS / f"ev_gate_{season}.json", "w") as f:
            json.dump(out, f, indent=2)

        print(f"[ev gate {season}] baseline scenario "
              f"(vig={BASELINE['vig']}, K={BASELINE['latency']}, "
              f"slip={BASELINE['slippage']}), alert region p>=0.25:")
        for mname in ("incumbent", "candidate"):
            for k, st in base[mname]["ev_bands"].items():
                if st.get("n"):
                    print(f"  {mname:10s} {k}: n={st['n']:5d} "
                          f"predP={st['mean_pred_prob']:.3f} obs={st['realized_freq']:.3f} "
                          f"EVpred={st['mean_predicted_ev']:+.3f} "
                          f"(med {st['median_predicted_ev']:+.3f}) "
                          f"Rreal={st['mean_realized_return']:+.3f} "
                          f"CI[{st['mean_realized_return_ci'][0]:+.3f},"
                          f"{st['mean_realized_return_ci'][1]:+.3f}] "
                          f"D_med={st['median_decimal_odds']:.1f}")
                else:
                    print(f"  {mname:10s} {k}: n=0")
        print(f"  C4 (candidate): " + ", ".join(
            f"{k}={v['status']}" for k, v in base["c4_checks_candidate"].items()))

    return 0


if __name__ == "__main__":
    sys.exit(main())
