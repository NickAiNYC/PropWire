"""yards_projection.py — frozen pregame receiving-yards distribution.

Contract (decision_2d_contract.json, models.frozen_prediction_path): the pilot's
market is NFL player receiving-yards over/under on primary lines, while the
frozen models are per-drive P(reception) models. The bridge is a Monte Carlo
transformation whose EVERY parameter is estimated from the 2023 TRAINING season
only (contexts, team drive counts, yards-per-reception distributions), applied
to each player's first-drive (pregame) feature row from the evaluation season's
corpus. Nothing may be tuned on 2024+ data; the harness asserts the training
source is the 2023 season.

Frozen Monte Carlo parameters: N_CTX = 2000 sampled contexts, N_SIMS = 4000
simulated games per player-game, fixed seed. MC noise is recorded (binomial
scale) and is part of the frozen protocol.

Simplifications (frozen and disclosed, not silently dropped):
  * within-game target funneling is not modeled (in-game counters stay at their
    pregame/first-drive values) — the simulation ignores the model's in-game
    feedback features by construction;
  * team drive counts are drawn league-wide from the 2023 empirical
    distribution, not conditioned on the specific matchup;
  * yards per reception are drawn i.i.d. from the player's 2023 empirical
    distribution (position-group fallback below 5 samples; league fallback for
    players absent from 2023).
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DRIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DRIVE))
from lib.common import FEATURE_BLOCKS, ALL_FEATURES  # noqa: E402

TRAIN_SEASON_ONLY = 2023
N_CTX = 2000          # frozen: context bank size
N_SIMS = 4000         # frozen: simulated games per player-game
MAX_DRIVES = 22       # frozen: clip on simulated team drives
MIN_PLAYER_YARDS_SAMPLES = 5
SEED = 20261031


class LeakageError(RuntimeError):
    pass


def _assert_train(path: Path, season: int) -> None:
    if season != TRAIN_SEASON_ONLY:
        raise LeakageError(
            f"transformation parameters may only come from the {TRAIN_SEASON_ONLY} "
            f"training season; got {season} ({path.name}). The contract forbids "
            "estimating anything on 2024+ data.")


class FrozenYardsProjection:
    """Pregame P(total receiving yards > line) via frozen Monte Carlo."""

    def __init__(self, model, calibrate, context_bank: pd.DataFrame,
                 drive_counts: np.ndarray, yards_by_player: dict,
                 yards_by_pos: dict, league_yards: np.ndarray,
                 n_ctx: int = N_CTX, n_sims: int = N_SIMS, seed: int = SEED):
        self.model = model
        self.calibrate = calibrate            # iso.predict for candidate; identity for incumbent
        self.ctx = context_bank[FEATURE_BLOCKS["context"]].to_numpy(float)
        self.drive_counts = np.clip(drive_counts.astype(int), 1, MAX_DRIVES)
        self.yards_by_player = yards_by_player
        self.yards_by_pos = yards_by_pos
        self.league_yards = league_yards
        self.n_ctx, self.n_sims, self.seed = n_ctx, n_sims, seed

    # ------------------------------------------------------------------
    @classmethod
    def from_train_data(cls, model, calibrate, data_dir: Path,
                        season: int = TRAIN_SEASON_ONLY,
                        n_ctx: int = N_CTX, n_sims: int = N_SIMS,
                        seed: int = SEED) -> "FrozenYardsProjection":
        _assert_train(Path(data_dir), season)
        corpus = pd.read_parquet(data_dir / f"player_drives_{season}.parquet")
        pbp = pd.read_parquet(
            data_dir / f"play_by_play_{season}.parquet",
            columns=["game_id", "complete_pass", "receiver_player_id", "yards",
                     "two_point_conversion"])

        rng = np.random.default_rng(seed)

        # 1. context bank: n_ctx rows sampled from the 2023 context distribution
        bank = corpus[FEATURE_BLOCKS["context"]].sample(
            n=n_ctx, replace=True, random_state=seed).reset_index(drop=True)

        # 2. team drive counts per team-game (2023 empirical distribution)
        dc = (corpus.groupby(["game_id", "posteam"]).drive_idx_team.max()
              .to_numpy(dtype=int))

        # 3. yards per completed reception (2023 pbp), excluding two-point tries
        catches = pbp.loc[(pbp.complete_pass == 1.0)
                          & pbp.receiver_player_id.notna()
                          & (pbp.two_point_conversion.fillna(0) != 1.0)]
        catches = catches.assign(
            pos=catches.receiver_player_id.map(
                corpus.drop_duplicates("player_id")
                .set_index("player_id").position).fillna("WR"))
        yards_by_player = {
            pid: g.yards.to_numpy(float)
            for pid, g in catches.groupby("receiver_player_id")}
        yards_by_pos = {
            pos: g.yards.to_numpy(float) for pos, g in catches.groupby("pos")}
        league = catches.yards.to_numpy(float)

        return cls(model, calibrate, bank, dc, yards_by_player, yards_by_pos,
                   league, n_ctx=n_ctx, n_sims=n_sims, seed=seed)

    # ------------------------------------------------------------------
    def _p_on_contexts(self, feature_row: pd.Series) -> np.ndarray:
        """P(reception) for one player under every banked context."""
        X = pd.DataFrame(np.tile(
            feature_row[ALL_FEATURES].to_numpy(dtype=float).reshape(1, -1),
            (self.n_ctx, 1)), columns=ALL_FEATURES)
        for c in FEATURE_BLOCKS["context"]:
            X[c] = self.ctx[:, FEATURE_BLOCKS["context"].index(c)]
        raw = self.model.predict_proba(X)[:, 1]
        return np.asarray(self.calibrate(raw), dtype=float)

    def _yards_source(self, player_id: str, pos: str) -> np.ndarray:
        arr = self.yards_by_player.get(player_id)
        if arr is not None and len(arr) >= MIN_PLAYER_YARDS_SAMPLES:
            return arr
        arr = self.yards_by_pos.get(pos)
        if arr is not None and len(arr):
            return arr
        return self.league_yards

    def simulate(self, feature_row: pd.Series, player_id: str, pos: str) -> dict:
        """Simulate N_SIMS games; return the total-yards distribution summary."""
        stable = int(hashlib.md5(str(player_id).encode()).hexdigest()[:8], 16)
        rng = np.random.default_rng(self.seed + stable % 100000)
        p = self._p_on_contexts(feature_row)                     # (n_ctx,)
        D = rng.choice(self.drive_counts, size=self.n_sims, replace=True)
        max_d = int(D.max())
        ctx_idx = rng.integers(0, self.n_ctx, size=(self.n_sims, max_d))
        p_mat = p[ctx_idx]                                       # (n_sims, max_d)
        mask = np.arange(max_d)[None, :] < D[:, None]
        caught = (rng.random((self.n_sims, max_d)) < p_mat) & mask
        src = self._yards_source(player_id, pos)
        yards = src[rng.integers(0, len(src), size=(self.n_sims, max_d))]
        total = (caught * yards).sum(axis=1)
        return {"mean": float(total.mean()), "sd": float(total.std()),
                "q10": float(np.quantile(total, 0.10)),
                "q50": float(np.quantile(total, 0.50)),
                "q90": float(np.quantile(total, 0.90)),
                "_total": total}

    def p_over(self, feature_row: pd.Series, player_id: str, pos: str,
               line: float) -> dict:
        sim = self.simulate(feature_row, player_id, pos)
        total = sim.pop("_total")
        p = float((total > line).mean())
        # frozen MC noise scale for audit: binomial se of p at n_sims
        se = float(np.sqrt(max(p * (1 - p), 1e-12) / self.n_sims))
        return {"p_over": p, "mc_se": se,
                "line": float(line), "yards_dist": sim}

    def p_over_frame(self, first_rows: pd.DataFrame, lines: pd.DataFrame) -> pd.DataFrame:
        """first_rows: per (game_id, player_id) first-drive corpus rows (has
        ALL_FEATURES + position). lines: game_id, player_id, line (book quotes).
        Returns lines joined with p_over + distribution summaries."""
        out = []
        fr = first_rows.set_index(["game_id", "player_id"])
        for r in lines.itertuples(index=False):
            key = (r.game_id, r.player_id)
            if key not in fr.index:
                out.append({"game_id": r.game_id, "player_id": r.player_id,
                            "line": r.line, "p_over": np.nan,
                            "note": "player not in causal universe corpus"})
                continue
            row = fr.loc[key]
            res = self.p_over(row, r.player_id, row.get("position", "WR"), r.line)
            res.update({"game_id": r.game_id, "player_id": r.player_id})
            out.append(res)
        return pd.DataFrame(out)

    def param_fingerprint(self) -> dict:
        """Audit fingerprint of every frozen parameter (recorded in run artifacts)."""
        h = hashlib.sha256()
        h.update(self.ctx.tobytes())
        h.update(self.drive_counts.tobytes())
        h.update(self.league_yards.tobytes())
        for pid in sorted(self.yards_by_player):
            h.update(str(pid).encode())
            h.update(self.yards_by_player[pid].tobytes())
        return {"n_ctx": self.n_ctx, "n_sims": self.n_sims, "seed": self.seed,
                "max_drives": MAX_DRIVES,
                "train_season": TRAIN_SEASON_ONLY,
                "params_sha256": h.hexdigest()}
