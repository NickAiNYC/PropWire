"""credit_meter.py — modeled credit accounting for The Odds API historical pulls.

The credit rule is VENDOR-DOCUMENTED and was reconciled by the project owner on
2026-10-30: a historical event-odds request costs **10 credits per region per
market per event**. One response returns ALL bookmakers in the requested
region, so cost scales with games x observation-times x regions x markets —
not with bookmaker count.

This module computes MODELED cost only. Actual consumption is metered from the
vendor's `x-requests-remaining` response headers in fetch_trial_quotes.py and
reconciled against this model by check V9. The model never overrides the
headers; a mismatch is evidence, not something to smooth over.

Full-acquisition projections (single region, single market family):

    392 games x 3 observation times (T-180m/T-60m/T-15m) x 10 = 11,760
    392 games x 4 snapshots (incl. closing)          x 10 = 15,680

Both reproduce the project owner's 2026-10-30 arithmetic exactly; the trial
budget is far smaller (see trial_config.json credit_budget_cap).
"""

from __future__ import annotations

import json
from pathlib import Path

CREDITS_PER_REGION_PER_MARKET_PER_EVENT = 10


def load_config(path: str | Path | None = None) -> dict:
    here = Path(__file__).resolve().parent
    cfg = json.loads((here / "trial_config.json").read_text())
    if path is not None:
        user = json.loads(Path(path).read_text())
        cfg.update(user)
    return cfg


def request_cost(n_regions: int = 1, n_markets: int = 1) -> int:
    """Modeled credits for ONE historical event-odds request."""
    return CREDITS_PER_REGION_PER_MARKET_PER_EVENT * n_regions * n_markets


def trial_modeled_cost(config: dict) -> dict:
    """Modeled cost of the trial quote pulls (event discovery excluded)."""
    n_games = (config["sample"]["n_games_2025"]
               + config["sample"]["n_games_2026_w1_7"])
    n_times = len(config["observation_offsets_minutes"])
    n_regions = 1
    n_markets = len(config["market_candidates"])
    modeled = n_games * n_times * request_cost(n_regions, n_markets)
    return {
        "games": n_games,
        "observation_times": n_times,
        "regions": n_regions,
        "markets": n_markets,
        "modeled_quote_pull_credits": modeled,
        "budget_cap": config["credit_budget_cap"],
        "within_budget": modeled <= config["credit_budget_cap"],
    }


def full_acquisition_projection(config: dict) -> dict:
    """Modeled cost of the full 392-game acquisition (pre-purchase estimate)."""
    games = config["full_acquisition_projections"]["games"]
    return {
        "games": games,
        "three_observation_times": games * 3 * CREDITS_PER_REGION_PER_MARKET_PER_EVENT,
        "four_snapshots_incl_closing": games * 4 * CREDITS_PER_REGION_PER_MARKET_PER_EVENT,
        "regions": 1,
        "markets": 1,
        "note": config["full_acquisition_projections"]["note"],
    }


def ledger_summary(ledger_path: str | Path) -> dict:
    """Summarize an actual credit ledger written by fetch_trial_quotes.py.

    Reconciliation logic (evidence for V9):
      actual per request = x_requests_remaining_before - x_requests_remaining_after
      A request FAILS reconciliation when actual != modeled.
    """
    rows = [json.loads(line) for line in Path(ledger_path).read_text().splitlines()
            if line.strip()]
    mismatches = [r for r in rows if r.get("actual_credits") != r.get("modeled_credits")]
    return {
        "n_requests": len(rows),
        "modeled_total": sum(r.get("modeled_credits", 0) for r in rows),
        "actual_total": sum(r.get("actual_credits", 0) for r in rows),
        "n_mismatched_requests": len(mismatches),
        "mismatched": [
            {
                "game_id": r.get("game_id"),
                "offset_label": r.get("offset_label"),
                "modeled_credits": r.get("modeled_credits"),
                "actual_credits": r.get("actual_credits"),
            }
            for r in mismatches
        ],
    }


if __name__ == "__main__":
    cfg = load_config()
    t = trial_modeled_cost(cfg)
    f = full_acquisition_projection(cfg)
    print(json.dumps({"trial": t, "full_acquisition": f}, indent=2))
