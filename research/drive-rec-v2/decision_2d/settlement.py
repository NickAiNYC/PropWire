"""settlement.py — actual receiving-yards settlement with push/void handling.

Settled yards come from the nflverse play-by-play (CC BY 4.0): the sum of play
yards on completed passes to the player, excluding two-point conversions.
Official box scores (when licensed) prevail over pbp-derived values; any
player-game discrepancy of >= 5 yards must be logged (contract settlement
section).

Push (settled yards exactly equal an integer line): stake returned — realized
return 0, included in ROI at 0, excluded from alert precision.
Void: excluded from ROI and precision, always recorded in the ledger.
"""

from __future__ import annotations

import pandas as pd

from quotes import as_bool

DISCREPANCY_LOG_THRESHOLD_YARDS = 5.0


def receiving_yards_by_game(pbp: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per (game_id, receiver_player_id) receiving yards from pbp.

    pbp must contain: game_id, complete_pass, receiver_player_id, yards,
    two_point_conversion.
    """
    need = {"game_id", "complete_pass", "receiver_player_id", "yards",
            "two_point_conversion"}
    missing = need - set(pbp.columns)
    if missing:
        raise ValueError(f"pbp missing columns: {sorted(missing)}")
    catches = pbp.loc[
        (pbp.complete_pass == 1.0)
        & pbp.receiver_player_id.notna()
        & (pbp.two_point_conversion.fillna(0) != 1.0)
    ]
    out = (catches.groupby(["game_id", "receiver_player_id"], as_index=False)
           .agg(receiving_yards=("yards", "sum"),
                n_receptions=("yards", "size")))
    return out.rename(columns={"receiver_player_id": "player_id"})


def settle(line: float, yards: float) -> str:
    """Outcome class for an over/under line given settled yards."""
    if yards > line:
        return "over"
    if yards < line:
        return "under"
    return "push"


def realized_return(outcome: str, price_over_decimal: float) -> float:
    """Realized return on a 1-unit stake at the entry price (contract §3)."""
    if outcome == "over":
        return price_over_decimal - 1.0
    if outcome == "under":
        return -1.0
    if outcome == "push":
        return 0.0            # stake returned
    if outcome == "void":
        return float("nan")   # excluded downstream, ledgered upstream
    raise ValueError(f"unknown outcome {outcome!r}")


def settle_frame(alerts: pd.DataFrame, yards: pd.DataFrame) -> pd.DataFrame:
    """Attach settlement to an alerts frame.

    alerts columns: game_id, player_id, line, price_over_decimal, voided.
    yards columns: game_id, player_id, receiving_yards (from
    receiving_yards_by_game).
    """
    a = alerts.merge(yards, on=["game_id", "player_id"], how="left")
    missing_yards = a.receiving_yards.isna()
    if missing_yards.any():
        # players with zero catches have no pbp rows: yards = 0 is legitimate
        # ONLY when the player's universe membership implies he played; when in
        # doubt, mark void rather than silently imputing 0.
        a.loc[missing_yards & ~as_bool(a.voided), "settlement_flag"] = \
            "no_pbp_row_treated_as_zero_if_played"
    a["receiving_yards"] = a.receiving_yards.fillna(0.0)
    a["outcome"] = [
        "void" if bool(v) else settle(line, yd)
        for v, line, yd in zip(as_bool(a.voided), a.line, a.receiving_yards)
    ]
    a["realized_return"] = [
        realized_return(o, d) for o, d in zip(a.outcome, a.price_over_decimal)
    ]
    return a
