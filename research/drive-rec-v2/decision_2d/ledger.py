"""ledger.py — quote availability and missingness ledger.

Contract §6: preserve quote availability and missingness; a backtest must NOT
treat the existence of a historical quote as proof it was executable for the
user at that moment. The ledger is reported alongside every economic number.
"""

from __future__ import annotations

import pandas as pd


def game_coverage(quotes: pd.DataFrame, selected: pd.DataFrame,
                  scheduled_games: pd.Series) -> dict:
    """Game-level coverage at the decision timestamp.

    scheduled_games: iterable of game_ids in the pilot scope (from the corpus
    schedule), so games with NO quotes at all still appear in the denominator.
    """
    sched = pd.Series(sorted(set(scheduled_games)), name="game_id")
    have = set(selected.game_id.unique())
    any_book = set(quotes.game_id.unique())
    n = len(sched)
    return {
        "scheduled_games": n,
        "games_with_any_quote_ever": int(sched.isin(any_book).sum()),
        "games_with_quote_at_decision": int(sched.isin(have).sum()),
        "coverage_at_decision": float(sched.isin(have).mean()) if n else 0.0,
        "games_with_no_quote_ever": sched[~sched.isin(any_book)].tolist(),
    }


def book_availability(selected: pd.DataFrame) -> pd.DataFrame:
    """Per bookmaker: games quoted, players priced, median line, age stats."""
    if selected.empty:
        return pd.DataFrame()
    return (selected.groupby("bookmaker")
            .agg(games=("game_id", "nunique"),
                 players_priced=("player_id", "nunique"),
                 quotes=("game_id", "size"),
                 median_quote_age_s=("quote_age_seconds", "median"),
                 p90_quote_age_s=("quote_age_seconds", lambda s: float(s.quantile(0.9))),
                 voided_quotes=("voided", "sum"))
            .reset_index())


def player_universe_coverage(selected: pd.DataFrame,
                             universe: pd.DataFrame) -> pd.DataFrame:
    """Share of the causal universe priced per game (per book).

    universe columns: game_id, player_id (causal universe membership).
    Denominator per (game, book) = ALL universe players in that game — not
    merely those the book priced (that would overstate coverage).
    """
    if universe.empty or selected.empty:
        return pd.DataFrame()
    u = universe.drop_duplicates(["game_id", "player_id"])
    priced = (selected.drop_duplicates(["game_id", "bookmaker", "player_id"])
              .groupby(["game_id", "bookmaker"]).player_id.nunique()
              .rename("priced").reset_index())
    denom = (u.groupby("game_id").player_id.nunique()
             .rename("universe_players").reset_index())
    out = priced.merge(denom, on="game_id", how="left")
    out["coverage"] = out.priced / out.universe_players
    return out


def void_and_push_accounting(settled: pd.DataFrame) -> dict:
    """Complete void/push accounting (gate E6 sub-check)."""
    return {
        "total_alerts": int(len(settled)),
        "voided": int((settled.outcome == "void").sum()) if "outcome" in settled else 0,
        "pushed": int((settled.outcome == "push").sum()) if "outcome" in settled else 0,
        "settled_excluding_void": int(len(settled) - (settled.get("outcome") == "void").sum())
        if "outcome" in settled else 0,
    }


def ledger_report(quotes: pd.DataFrame, selected: pd.DataFrame,
                  scheduled_games: pd.Series, universe: pd.DataFrame) -> dict:
    from point_in_time import quote_age_report
    return {
        "game_coverage": game_coverage(quotes, selected, scheduled_games),
        "quote_age": quote_age_report(selected),
        "book_availability": book_availability(selected).to_dict("records"),
        "universe_coverage_summary": (
            player_universe_coverage(selected, universe)
            .groupby("bookmaker").coverage.mean().round(4).to_dict()
            if not universe.empty else {}),
    }
