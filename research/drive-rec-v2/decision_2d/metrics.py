"""metrics.py — economic metrics with game-clustered bootstrap CIs.

Every headline number in the pilot is reported with a 95% game-clustered
bootstrap CI (resample games with replacement; replicates and seeds fixed per
the contract's uncertainty section). Metrics (contract §4):

  realized ROI   mean settled realized_return (pushes at 0, voids excluded)
  expected ROI   mean P_hat(over) * D_entry - 1
  CLV            mean p_close_novig * D_entry - 1
  alert precision  share of settled non-push alerts where the over won
  calibration    mean P_hat(over) vs realized over-rate INSIDE the selected
                 subset (selection-conditional, per the Decision 2C finding)
  coverage       game / player / freshness coverage (from the ledger)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

N_BOOT = 1000
SEED = 20261030


def _clustered(values: np.ndarray, games: np.ndarray,
               stat=np.mean, n_boot: int = N_BOOT, seed: int = SEED) -> dict:
    """Game-clustered bootstrap of a per-row statistic's mean."""
    values = np.asarray(values, dtype=float)
    games = np.asarray(games)
    ok = np.isfinite(values)
    values, games = values[ok], games[ok]
    if len(values) == 0:
        return {"n": 0}
    uniq = np.unique(games)
    pos = {g: np.where(games == g)[0] for g in uniq}
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(n_boot):
        idx = np.concatenate([pos[g] for g in rng.choice(uniq, len(uniq), True)])
        boots.append(stat(values[idx]))
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {"n": int(len(values)), "n_games": int(len(uniq)),
            "mean": float(values.mean()),
            "ci_low": float(lo), "ci_high": float(hi)}


def clustered_mean(values, games, **kw) -> dict:
    return _clustered(values, games, **kw)


def clustered_diff(a, b, games, n_boot: int = N_BOOT, seed: int = SEED) -> dict:
    """Game-clustered bootstrap of mean(a) - mean(b) on the SAME rows."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    games = np.asarray(games)
    uniq = np.unique(games)
    pos = {g: np.where(games == g)[0] for g in uniq}
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(n_boot):
        idx = np.concatenate([pos[g] for g in rng.choice(uniq, len(uniq), True)])
        boots.append(a[idx].mean() - b[idx].mean())
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {"diff": float(a.mean() - b.mean()),
            "ci_low": float(lo), "ci_high": float(hi)}


def roi_metrics(alerts: pd.DataFrame) -> dict:
    """Realized/expected ROI + CLV on a settled alerts frame.

    Required columns: realized_return, p_over, price_over_decimal,
    p_close_novig, game_id, outcome.
    """
    settled = alerts.loc[alerts.outcome != "void"]
    g = settled.game_id.to_numpy()
    exp = (settled.p_over * settled.price_over_decimal - 1.0).to_numpy()
    clv = (settled.p_close_novig * settled.price_over_decimal - 1.0).to_numpy()
    real = settled.realized_return.to_numpy(dtype=float)
    return {
        "realized_roi": _clustered(real, g),
        "expected_roi": _clustered(exp, g),
        "clv": _clustered(clv, g),
        "expected_vs_realized_diff": clustered_diff(real, exp, g),
    }


def precision_metric(alerts: pd.DataFrame) -> dict:
    """Alert precision: share of settled non-push alerts where over won."""
    s = alerts.loc[~alerts.outcome.isin(["void", "push"])]
    if len(s) == 0:
        return {"n": 0}
    return {
        "n": int(len(s)),
        "n_games": int(s.game_id.nunique()),
        "alert_precision": float((s.outcome == "over").mean()),
    }


def calibration_metric(alerts: pd.DataFrame) -> dict:
    """SELECTION-CONDITIONAL calibration: mean P_hat(over) vs realized over-rate
    inside the selected subset, with a game-clustered CI of the gap."""
    settled = alerts.loc[alerts.outcome != "void"]
    p, y = settled.p_over.to_numpy(float), (settled.outcome == "over").to_numpy(float)
    gap = _clustered(y - p, settled.game_id.to_numpy())
    gap["mean_pred"] = float(p.mean())
    gap["realized_over_rate"] = float(y.mean())
    gap["gap_pp"] = float((y.mean() - p.mean()) * 100)
    gap["gap_ci_pp"] = [gap["ci_low"] * 100, gap["ci_high"] * 100]
    return gap


def evaluate_gates(alerts: pd.DataFrame, contract: dict,
                   coverage_game_share: float) -> dict:
    """Evaluate the precommitted gates E1-E6 (fail-closed) on a settled frame.

    E6's license/timestamp sub-checks are verified OUTSIDE this function (data
    acquisition + quotes.validate_quotes); here we check the coverage share.
    Returns per-gate {status, detail}; overall status = worst.
    """
    m = roi_metrics(alerts)
    cal = calibration_metric(alerts)
    pr = precision_metric(alerts)
    settled = alerts.loc[alerts.outcome != "void"]

    def fail_closed(cond, detail):
        return {"status": "PASS" if cond else "FAIL", "detail": detail}

    n, ng = len(settled), settled.game_id.nunique()
    e1 = fail_closed(n >= 100 and ng >= 25,
                     f"n={n} settled alerts across {ng} games "
                     f"(need >=100 and >=25; LOW_SAMPLE blocks promotion)")
    gap_ok = abs(cal["gap_pp"]) <= 3.0
    ci_ok = cal["gap_ci_pp"][0] >= -5.0 and cal["gap_ci_pp"][1] <= 5.0
    e2 = fail_closed(gap_ok and ci_ok,
                     f"selection-conditional gap {cal['gap_pp']:+.2f}pp "
                     f"(<=3.0pp required), CI {cal['gap_ci_pp']} within +/-5pp: {ci_ok}")
    r = m["realized_roi"]
    e3 = fail_closed(r.get("mean", -1) > 0 and r.get("ci_low", -1) >= -0.01,
                     f"realized ROI {r['mean']:+.4f}, CI [{r['ci_low']:+.4f}, "
                     f"{r['ci_high']:+.4f}] (need mean>0 and ci_low>=-0.01)")
    c = m["clv"]
    e4 = fail_closed(c.get("mean", -1) >= 0,
                     f"mean CLV {c['mean']:+.4f} (need >=0)")
    d = m["expected_vs_realized_diff"]
    e5 = fail_closed(d["ci_low"] >= -0.03 and d["ci_high"] <= 0.03,
                     f"realized-expected diff {d['diff']:+.4f}, CI "
                     f"[{d['ci_low']:+.4f}, {d['ci_high']:+.4f}] (full CI must lie "
                     "within +/-3pp — deliberately demanding; failing here means "
                     "the study cannot rule out material EV overstatement)")
    e6 = fail_closed(coverage_game_share >= 0.70,
                     f"game coverage at primary decision timestamp "
                     f"{coverage_game_share:.1%} (need >=70%)")
    gates = {"E1_sample_adequacy": e1, "E2_selection_conditional_calibration": e2,
             "E3_realized_roi": e3, "E4_clv": e4,
             "E5_expected_vs_realized": e5, "E6_data_integrity_coverage": e6}
    statuses = [v["status"] for v in gates.values()]
    overall = "PASS" if all(s == "PASS" for s in statuses) else "FAIL"
    return {"overall": overall, "gates": gates,
            "metrics": {"roi": m, "calibration": cal, "precision": pr}}
