"""lib/metrics.py — calibration metrics and game-clustered bootstrap intervals.

All confidence intervals resample GAMES (not rows) with replacement, because
player-drive rows within a game are strongly correlated (shared game script,
shared drive context). Row-level bootstrap would materially understate
uncertainty and is not used anywhere in this pipeline.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

N_BOOT_DEFAULT = 1000
SEED_DEFAULT = 20240101


def brier(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def logloss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    y = np.asarray(y)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc(y: np.ndarray, p: np.ndarray) -> float:
    return float(roc_auc_score(np.asarray(y), np.asarray(p)))


def reliability_table(y: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict]:
    """Equal-width bins on predicted probability."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    out = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p > lo) & (p <= hi) if i > 0 else (p >= lo) & (p <= hi)
        if m.sum() == 0:
            out.append({"bin": i, "p_low": lo, "p_high": hi, "n": 0,
                        "mean_pred": None, "obs_rate": None})
            continue
        out.append({"bin": i, "p_low": float(lo), "p_high": float(hi),
                    "n": int(m.sum()), "mean_pred": float(p[m].mean()),
                    "obs_rate": float(y[m].mean())})
    return out


def ece_decile(y: np.ndarray, p: np.ndarray) -> float:
    """Decile-based expected calibration error (weighted |pred - obs|)."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    qs = np.quantile(p, np.linspace(0, 1, 11))
    total, ece = len(p), 0.0
    for i in range(10):
        lo, hi = qs[i], qs[i + 1]
        m = (p > lo) & (p <= hi) if i > 0 else (p >= lo) & (p <= hi)
        if m.sum() == 0:
            continue
        ece += (m.sum() / total) * abs(p[m].mean() - y[m].mean())
    return float(ece)


def top_decile_stats(y: np.ndarray, p: np.ndarray) -> dict:
    y, p = np.asarray(y, float), np.asarray(p, float)
    thr = np.quantile(p, 0.9)
    m = p >= thr
    return {"threshold": float(thr), "n": int(m.sum()),
            "mean_pred": float(p[m].mean()), "obs_rate": float(y[m].mean()),
            "gap_pred_minus_obs": float(p[m].mean() - y[m].mean())}


def _per_cluster_sums(values: np.ndarray, clusters: np.ndarray) -> np.ndarray:
    df = pd.DataFrame({"v": values, "c": clusters})
    g = df.groupby("c").v.sum()
    return g.to_numpy(dtype=float)


def _cluster_sizes(clusters: np.ndarray) -> np.ndarray:
    return np.unique(clusters, return_counts=True)[1].astype(float)


def clustered_mean_ci(values, clusters, n_boot=N_BOOT_DEFAULT, seed=SEED_DEFAULT,
                      alpha=0.05) -> dict:
    """CI for the mean of `values`, resampling clusters with replacement."""
    values = np.asarray(values, float)
    clusters = np.asarray(clusters)
    sums = _per_cluster_sums(values, clusters)
    sizes = _cluster_sizes(clusters)
    rng = np.random.default_rng(seed)
    n_clu = len(sums)
    idx = rng.integers(0, n_clu, size=(n_boot, n_clu))
    boot = sums[idx].sum(axis=1) / sizes[idx].sum(axis=1)
    lo, hi = np.quantile(boot, [alpha / 2, 1 - alpha / 2])
    return {"mean": float(values.mean()), "ci_low": float(lo), "ci_high": float(hi),
            "n_clusters": int(n_clu)}


def clustered_gap_ci(pred, y, clusters, n_boot=N_BOOT_DEFAULT, seed=SEED_DEFAULT,
                     alpha=0.05) -> dict:
    """CI for (observed rate - mean predicted probability), cluster-resampled."""
    pred, y = np.asarray(pred, float), np.asarray(y, float)
    clusters = np.asarray(clusters)
    df = pd.DataFrame({"p": pred, "y": y, "c": clusters})
    g = df.groupby("c").agg(sp=("p", "sum"), sy=("y", "sum"), n=("y", "size"))
    sp, sy, n = (g.sp.to_numpy(float), g.sy.to_numpy(float), g.n.to_numpy(float))
    rng = np.random.default_rng(seed)
    n_clu = len(sp)
    idx = rng.integers(0, n_clu, size=(n_boot, n_clu))
    gap = sy[idx].sum(axis=1) / n[idx].sum(axis=1) - sp[idx].sum(axis=1) / n[idx].sum(axis=1)
    lo, hi = np.quantile(gap, [alpha / 2, 1 - alpha / 2])
    return {
        "n": int(len(y)), "n_games": int(n_clu),
        "mean_pred": float(pred.mean()), "obs_rate": float(y.mean()),
        "gap_obs_minus_pred": float(y.mean() - pred.mean()),
        "gap_ci_low": float(lo), "gap_ci_high": float(hi),
    }


def clustered_diff_ci(a, b, clusters, n_boot=N_BOOT_DEFAULT, seed=SEED_DEFAULT,
                      alpha=0.05) -> dict:
    """CI for mean(a) - mean(b) (e.g., per-row Brier of model A minus model B)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    clusters = np.asarray(clusters)
    df = pd.DataFrame({"a": a, "b": b, "c": clusters})
    g = df.groupby("c").agg(sa=("a", "sum"), sb=("b", "sum"), n=("a", "size"))
    sa, sb, n = (g.sa.to_numpy(float), g.sb.to_numpy(float), g.n.to_numpy(float))
    rng = np.random.default_rng(seed)
    n_clu = len(sa)
    idx = rng.integers(0, n_clu, size=(n_boot, n_clu))
    diff = sa[idx].sum(axis=1) / n[idx].sum(axis=1) - sb[idx].sum(axis=1) / n[idx].sum(axis=1)
    lo, hi = np.quantile(diff, [alpha / 2, 1 - alpha / 2])
    return {"diff": float(a.mean() - b.mean()), "ci_low": float(lo),
            "ci_high": float(hi), "n_games": int(n_clu)}
