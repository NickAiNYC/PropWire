"""select_sample.py — deterministic, precommitted trial-game selection.

Decision 2D-V requires a SMALL, REPRESENTATIVE trial: games from BOTH seasons,
multiple sportsbooks, and examples of missing or changing lines. The selection
rule below was fixed BEFORE any quote request (see PRECOMMITMENT.md):

  * 4 games from the 2025 season (previously inspected holdout), one per week
    bin: 1-6, 7-12, 13-18, 19-22 (postseason included — the full acquisition
    covers 285 games incl. postseason);
  * 4 games from 2026 weeks 1-7 (the contract's "genuinely unseen" slice),
    one per week bin: 1-2, 3-4, 5-6, 7-7;
  * within each bin, the game is drawn by a seeded RNG whose seed is the
    SHA-256 of a fixed public string — no researcher discretion, reproducible
    by anyone from the same games.csv;
  * selection uses SCHEDULE METADATA ONLY (nflverse games.csv, CC BY 4.0);
    no odds, quotes, or outcomes are consulted.

The output manifest (artifacts/sample_manifest.json) is an input to
fetch_trial_quotes.py and to checks V1-V10. Changing the sample after seeing
quote data voidates the trial.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
DRIVE = HERE.parent
sys.path.insert(0, str(HERE))

from credit_meter import load_config  # noqa: E402


def derive_seed(seed_source: str) -> int:
    digest = hashlib.sha256(seed_source.encode()).hexdigest()
    return int(digest[:16], 16)


def stratified_pick(df: pd.DataFrame, bins: list[list[int]], rng,
                    season: int) -> list[dict]:
    picks = []
    for lo, hi in bins:
        pool = df.loc[(df.season == season) & (df.week >= lo) & (df.week <= hi)]
        if pool.empty:
            raise SystemExit(f"empty bin: season {season} weeks {lo}-{hi}")
        row = pool.sample(n=1, random_state=rng).iloc[0]
        picks.append({
            "game_id": str(row.game_id),
            "season": int(row.season),
            "week": int(row.week),
            "game_type": str(row.game_type),
            "gameday": str(row.gameday),
            "home_team": str(row.home_team),
            "away_team": str(row.away_team),
            "bin": f"w{lo}-{hi}",
        })
    return picks


def main() -> None:
    cfg = load_config()
    games = pd.read_csv(DRIVE / "data" / "games.csv",
                        usecols=["game_id", "season", "game_type", "week",
                                 "gameday", "home_team", "away_team"])

    # 2026 restriction: contract slice is weeks 1-7 only (as of freeze).
    g26 = games.loc[(games.season == 2026) & (games.week <= 7)].copy()
    g25 = games.loc[games.season == 2025].copy()
    n25 = len(g25)
    n26 = len(g26)
    if n25 != 285 or n26 != 107:
        print(f"WARNING: expected 285 (2025) and 107 (2026 w1-7) games, "
              f"found {n25} and {n26} — recorded in the manifest", file=sys.stderr)

    rng = np_rng(cfg["sample"]["seed_source"])
    picks = (stratified_pick(g25, cfg["sample"]["bins_2025"], rng, 2025)
             + stratified_pick(g26, cfg["sample"]["bins_2026_w1_7"], rng, 2026))

    manifest = {
        "trial_id": cfg["trial_id"],
        "selection_rule": (
            "seeded stratified sample: 4 games from 2025 (bins w1-6/w7-12/"
            "w13-18/w19-22) + 4 games from 2026 weeks 1-7 (bins w1-2/w3-4/"
            "w5-6/w7-7); seed = int(sha256('DECISION_2DV_TRIAL_SAMPLE_SEED_v1')"
            "[:16], 16); schedule metadata only; fixed BEFORE any quote request"
        ),
        "seed_source": cfg["sample"]["seed_source"],
        "seed": derive_seed(cfg["sample"]["seed_source"]),
        "source": "research/drive-rec-v2/data/games.csv (nflverse, CC BY 4.0)",
        "counts": {"season_2025_games_available": int(n25),
                   "season_2026_w1_7_games_available": int(n26)},
        "games": picks,
        "fixed_at_note": ("generated 2026-10-30, before any vendor request; "
                          "no credits consumed at selection time"),
    }

    out = HERE / "artifacts" / "sample_manifest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n")
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"wrote {out} ({len(picks)} games)")
    for g in picks:
        print(f"  {g['game_id']}  {g['season']} w{g['week']:<2} "
              f"{g['away_team']} @ {g['home_team']}  [{g['bin']}]")
    print(f"manifest sha256: {digest}")


def np_rng(seed_source: str):
    import numpy as np
    return np.random.default_rng(derive_seed(seed_source))


if __name__ == "__main__":
    main()
