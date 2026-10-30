r"""10_selection_amplification.py — Decision 2C review diagnostic (user §2).

QUESTION ORDERED BY THE DECISION 2C REVIEW:
"Investigate how much of the deviation comes from the EV >= 5% selection mechanism,
 which may amplify calibration and pricing errors. Also distinguish unconditional
 calibration from calibration conditional on a model-derived betting opportunity.
 Passing decile-ECE does not establish calibration within the subset selected by
 an EV threshold."

METHOD (all numbers HYPOTHETICAL — simulated quotes exactly as frozen in criteria
v3 C8 and reconstructed by script 08; quote construction is imported from 08 so the
C4 3.05pp failure reproduces bit-for-bit):

For each model (candidate p_cal, incumbent p_incumbent) and each season:

  A  = alert region  {p_model >= 0.25}
  S_b = A ∩ {simulated EV >= b}   for b in {0%, 3%, 5%, 8%}

  1. Conditional-vs-unconditional gap:  gap(X) = mean(y) - mean(p) on X, with
     game-clustered bootstrap CIs. The amplification is gap(S_5%) - gap(A).
  2. Threshold gradient: gap at each EV band — selection amplification shows up
     as |gap| growing with b while the unconditional gap stays flat.
  3. Matched-probability control: re-weight the NON-selected rows in A\S_5% to the
     p-distribution (fixed bins) of the selected rows. gap(control) isolates what
     the selected set's probability COMPOSITION alone would predict;
     gap(S_5%) - gap(control) is then attributable to the SELECTION MECHANISM
     itself (rows where the model beats its own stale reference), not to the
     probability level. Game-clustered bootstrap CIs on both parts.
  4. Mechanism probes: corr(p - ref, y - p) inside A; mean(p - ref) and mean(y -
     ref) inside S_5% — the latter tests whether reality tracks the stale
     reference better than the fresh model precisely on the rows the EV filter
     selects (i.e. whether the EV signal is mostly self-disagreement noise).

Outputs: artifacts/selection_amplification_<season>.json (one per season) and
artifacts/selection_amplification_summary.json. Console summary. No model is
refit; this is a read-only diagnostic on preserved row-level predictions.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DRIVE = Path(__file__).resolve().parent
sys.path.insert(0, str(DRIVE))
from lib.common import ARTIFACTS, DATA, DEV_SEASON, HOLDOUT_SEASON, UNSEEN_SEASON  # noqa: E402
from lib.metrics import clustered_gap_ci  # noqa: E402

# import script 08 for the EXACT quote/reference construction (frozen C8 scenario)
spec = importlib.util.spec_from_file_location("ev_gate_08", DRIVE / "08_ev_reliability_gate.py")
ev08 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev08)

BASELINE = ev08.BASELINE                    # {"vig": 0.06, "latency": 1, "slippage": 0.02}
ALERT_REGION_MIN_P = ev08.ALERT_REGION_MIN_P
EV_BANDS = [0.0, 0.03, 0.05, 0.08]
P_BINS = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.70]   # fixed matching bins
N_BOOT, SEED = 1000, 20261030


def game_cluster_bootstrap_gap(df: pd.DataFrame, p_col: str, mask: np.ndarray,
                               n_boot: int = N_BOOT, seed: int = SEED) -> list[float]:
    """95% game-clustered bootstrap CI of gap = mean(y) - mean(p) within mask."""
    sub = df.loc[mask].reset_index(drop=True)
    rng = np.random.default_rng(seed)
    games = sub.game_id.unique()
    by_game = sub.groupby("game_id").indices      # positional indices
    y_arr, p_arr = sub.y.to_numpy(), sub[p_col].to_numpy()
    gaps = []
    for _ in range(n_boot):
        pick = rng.choice(games, size=len(games), replace=True)
        idx = np.concatenate([by_game[g] for g in pick])
        gaps.append(y_arr[idx].mean() - p_arr[idx].mean())
    return [float(np.percentile(gaps, 2.5)), float(np.percentile(gaps, 97.5))]


def matched_control(df: pd.DataFrame, p_col: str, sel: np.ndarray, alert: np.ndarray,
                    bins: list[float]) -> dict:
    """Re-weight A\\S to S's p-distribution; bootstrap the stratified gap.

    control_gap = sum_b w_b * gap_b, w_b = share of selected rows in bin b,
    gap_b = gap among non-selected alert-region rows in bin b.
    """
    p = df[p_col].to_numpy()
    y = df.y.to_numpy()
    g = df.game_id.to_numpy()
    un = alert & ~sel
    bin_id = np.digitize(p, bins) - 1          # 0..len(bins)-1 (right-open bins)
    nb = len(bins)
    sel_cnt = np.bincount(bin_id[sel], minlength=nb).astype(float)
    gaps, used_bins, weights = [], [], []
    total_sel = sel_cnt.sum()
    for b in range(nb):
        m_un = un & (bin_id == b)
        k = sel_cnt[b]
        if k <= 0:
            continue
        if m_un.sum() == 0:                    # no control rows in this bin
            continue
        used_bins.append(b)
        weights.append(k / total_sel)
        gaps.append(y[m_un].mean() - p[m_un].mean())
    control_gap = float(np.dot(weights, gaps))

    # game-clustered bootstrap of the stratified statistic
    rng = np.random.default_rng(SEED + 7)
    games = np.unique(g[alert])
    pos_of_game = {gm: np.where(g == gm)[0] for gm in games}   # positions, computed once
    boot = []
    for _ in range(N_BOOT):
        pick = rng.choice(games, size=len(games), replace=True)
        idx = np.concatenate([pos_of_game[gm] for gm in pick])
        s = sel[idx]
        u = un[idx]
        bidx = bin_id[idx]
        sc = np.bincount(bidx[s], minlength=nb).astype(float)
        tot = sc.sum()
        gb, wb = [], []
        for b in used_bins:
            mu = u & (bidx == b)
            if sc[b] <= 0 or mu.sum() == 0:
                continue
            wb.append(sc[b] / tot)
            gb.append(y[idx][mu].mean() - p[idx][mu].mean())
        if wb:
            boot.append(float(np.dot(wb, gb)))
    ci = [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))]
    return {
        "bins": bins, "bins_used": used_bins,
        "weights": [float(w) for w in weights],
        "control_gap": control_gap, "control_gap_ci": ci,
        "share_selected_rows_in_skipped_bins": float(1.0 - sum(weights)),
    }


def analyze_season(pred: pd.DataFrame, p_col: str, ref: np.ndarray,
                   model_name: str) -> dict:
    Q = np.clip(np.asarray(ref) * (1 + BASELINE["vig"]), 0.01, 0.95)
    D = 1.0 / (Q * (1 + BASELINE["slippage"]))
    p = pred[p_col].to_numpy()
    y = pred.y.to_numpy()
    ev = p * D - 1.0
    alert = p >= ALERT_REGION_MIN_P

    def gap_stats(mask):
        if mask.sum() == 0:
            return {"n": 0}
        return {
            "n": int(mask.sum()),
            "n_games": int(pred.loc[mask, "game_id"].nunique()),
            "mean_pred": float(p[mask].mean()),
            "observed": float(y[mask].mean()),
            "gap_pp": float((y[mask].mean() - p[mask].mean()) * 100),
            "gap_ci_pp": [c * 100 for c in game_cluster_bootstrap_gap(pred, p_col, mask)],
            "mean_p_minus_ref_pp": float(((p - np.asarray(ref))[mask].mean()) * 100),
            "mean_y_minus_ref_pp": float(((y - np.asarray(ref))[mask].mean()) * 100),
        }

    out = {
        "model": model_name,
        "hypothetical": True,
        "quote_scenario": "criteria v3 C8 baseline (vig 0.06, latency 1 drive, slippage 0.02), references from script 08",
        "unconditional_alert_region": gap_stats(alert),
        "conditional_on_ev_band": {},
    }
    for b in EV_BANDS:
        sel = (ev >= b) & alert
        out["conditional_on_ev_band"][f"EV >= {b:.0%}"] = gap_stats(sel)

    sel5 = (ev >= 0.05) & alert
    if sel5.sum() > 0:
        ctrl = matched_control(pred, p_col, sel5, alert, P_BINS)
        gap_sel = out["conditional_on_ev_band"]["EV >= 5%"]["gap_pp"]
        gap_alert = out["unconditional_alert_region"]["gap_pp"]
        out["amplification_ev5"] = {
            "gap_unconditional_pp": gap_alert,
            "gap_selected_pp": gap_sel,
            "total_amplification_pp": gap_sel - gap_alert,
            "composition_part_pp": ctrl["control_gap"] - gap_alert,
            "selection_mechanism_part_pp": gap_sel - ctrl["control_gap"],
            "matched_control": ctrl,
        }
        # mechanism probes inside the alert region
        pr = p - np.asarray(ref)
        out["mechanism_probes"] = {
            "corr_p_minus_ref_vs_y_minus_p_alert_region":
                float(np.corrcoef(pr[alert], (y - p)[alert])[0, 1]),
            "note": (
                "corr > 0 means rows where the model most exceeds its own stale "
                "reference are also rows where it overpredicts reality: the EV "
                "filter then selects calibration error."),
        }
    return out


def main() -> int:
    import joblib
    model = joblib.load(ARTIFACTS / "incumbent_model.joblib")
    iso = joblib.load(ARTIFACTS / "isotonic_calibrator.joblib")

    summary = {}
    for season, label in ((DEV_SEASON, "development (cross-fitted candidate)"),
                          (HOLDOUT_SEASON, "previously inspected holdout"),
                          (UNSEEN_SEASON, "genuinely unseen prospective (weeks 1-7)")):
        pred = pd.read_csv(ARTIFACTS / f"candidate_predictions_{season}.csv.gz")
        pdf = pd.read_parquet(DATA / f"player_drives_{season}.parquet")
        assert len(pred) == len(pdf), "row alignment broken"

        neutral = ev08.neutral_reference(pred, pdf, model, iso)
        refs = ev08.lag_references(pred, neutral)
        ref = refs[BASELINE["latency"]]

        season_out = {
            "season": season, "label": label,
            "candidate": analyze_season(pred, "p_cal", ref, "candidate (isotonic)"),
            "incumbent": analyze_season(pred, "p_incumbent", ref, "incumbent (logistic)"),
        }
        with open(ARTIFACTS / f"selection_amplification_{season}.json", "w") as f:
            json.dump(season_out, f, indent=2)
        summary[season] = season_out

        # reproduction check against the frozen C4 failure
        c5 = season_out["candidate"]["conditional_on_ev_band"].get("EV >= 5%", {})
        if c5.get("n"):
            print(f"[{season}] candidate EV>=5% gap = {c5['gap_pp']:+.2f}pp "
                  f"(n={c5['n']}) [ev_gate_2025/2026 reference: "
                  f"{-3.0499 if season == HOLDOUT_SEASON else float('nan'):+.2f}pp]"
                  if season != UNSEEN_SEASON else
                  f"[{season}] candidate EV>=5% gap = {c5['gap_pp']:+.2f}pp (n={c5['n']})")
        for mname in ("candidate", "incumbent"):
            a = season_out[mname]["unconditional_alert_region"]
            amp = season_out[mname].get("amplification_ev5")
            if amp:
                print(f"  {mname:10s} gap: alert-region {a['gap_pp']:+.2f}pp -> "
                      f"EV>=5% {amp['gap_selected_pp']:+.2f}pp | "
                      f"composition {amp['composition_part_pp']:+.2f}pp + "
                      f"selection-mechanism {amp['selection_mechanism_part_pp']:+.2f}pp")

    with open(ARTIFACTS / "selection_amplification_summary.json", "w") as f:
        json.dump({"generated": "script 10", "seasons": summary}, f, indent=2)
    print("[output] artifacts/selection_amplification_<season>.json + summary")
    return 0


if __name__ == "__main__":
    sys.exit(main())
