"""
Week runner. Produces projections, and picks if odds are available.

    python week1.py --season 2026 --week 1                 # projections only
    python week1.py --season 2026 --week 1 --odds          # + live odds, picks

Without an ODDS_API_KEY this still runs and emits fair lines and fair prices
per player. You can compare those to a book by hand. That is the honest
fallback: the model's job is to produce a probability, and a probability is
useful even when you have to do the comparison yourself.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from features import build_panel
from model import ReceivingModel, prob_to_american, ev_per_unit, kelly_fraction
from slate import (build_slate, load_injuries, injury_exclusions,
                   questionable_flags, week1_eligible,
                   W1_BIAS_REC, W1_BIAS_YDS, W1_MIN_EDGE, W1_KELLY_CAP)
from agent import MIN_EDGE, KELLY_CAP, MIN_BOOKS, Pick, log_picks


def project(season: int, week: int) -> tuple[pd.DataFrame, ReceivingModel]:
    panel = build_panel()
    panel = panel[(panel.season < season) |
                  ((panel.season == season) & (panel.week < week))]
    model = ReceivingModel.fit(panel)

    slate = build_slate(season, week)
    inj = load_injuries(season, week)
    out = injury_exclusions(inj)
    quest = questionable_flags(inj)

    slate = week1_eligible(slate, out) if week == 1 else slate.assign(excl_reason="")
    slate["questionable"] = slate.player_id.isin(quest).astype(int)

    p = model.predict_params(slate)
    slate["mu_rec"] = p.mu_rec.values
    slate["mu_ypr"] = p.mu_ypr.values
    slate["proj_rec"] = slate.mu_rec
    slate["proj_yards"] = slate.mu_rec * slate.mu_ypr

    # Fair lines = median of the predictive distribution.
    r = 1.0 / model.alpha
    pp = r / (r + slate.mu_rec.values)
    from scipy import stats as st
    med = st.nbinom.ppf(0.5, r, pp)
    slate["fair_line_rec"] = np.where(st.nbinom.cdf(med, r, pp) >= 0.5,
                                      med + 0.5, med - 0.5)
    slate["fair_line_yards"] = np.round(
        model.yards_quantile_vec(slate.mu_rec.values, slate.mu_ypr.values, 0.5) * 2) / 2
    return slate, model


def prob_for(model, row, market, line, week):
    """Probability of the OVER, with the Week-1 bias correction applied."""
    if market == "receptions":
        p = model.p_rec_over(row.mu_rec, line)
        if week == 1:
            p -= W1_BIAS_REC
    else:
        p = model.p_yards_over(row.mu_rec, row.mu_ypr, line)
        if week == 1:
            p -= W1_BIAS_YDS
    return float(np.clip(p, 0.01, 0.99))


def make_picks(slate, model, consensus, week) -> list[Pick]:
    min_edge = W1_MIN_EDGE if week == 1 else MIN_EDGE
    cap = W1_KELLY_CAP if week == 1 else KELLY_CAP
    by_player = {r.player_display_name: r for r in slate.itertuples()
                 if r.excl_reason == ""}
    picks = []
    for (player, mkey, line), c in consensus.items():
        market = {"player_receptions": "receptions",
                  "player_reception_yds": "receiving_yards"}.get(mkey)
        if market is None or player not in by_player or c["n_books"] < MIN_BOOKS:
            continue
        row = by_player[player]
        p_over = prob_for(model, row, market, line, week)
        for side, pm, odds, book in (
                ("over", p_over, c["best_over_odds"], c["best_over_book"]),
                ("under", 1 - p_over, c["best_under_odds"], c["best_under_book"])):
            if odds is None:
                continue
            p_mkt = c["p_over"] if side == "over" else 1 - c["p_over"]
            edge = pm - p_mkt
            ev = ev_per_unit(pm, odds)
            if edge < min_edge or ev <= 0:
                continue
            picks.append(Pick(
                player=player, market=market, side=side, line=line, book=book,
                odds=odds, model_prob=round(pm, 4), market_prob=round(p_mkt, 4),
                edge=round(edge, 4), ev_per_unit=round(ev, 4),
                kelly_stake=round(kelly_fraction(pm, odds, cap=cap), 5),
                projection=round(float(row.proj_rec if market == "receptions"
                                       else row.proj_yards), 1)))
    picks.sort(key=lambda p: p.ev_per_unit, reverse=True)
    return picks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--week", type=int, default=1)
    ap.add_argument("--odds", action="store_true", help="pull live odds (needs key)")
    ap.add_argument("--out", default="slate_projections.csv")
    ap.add_argument("--top", type=int, default=25)
    a = ap.parse_args()

    slate, model = project(a.season, a.week)
    ok = slate[slate.excl_reason == ""]

    print(f"\n{'=' * 78}")
    print(f"  {a.season} WEEK {a.week}  |  {len(slate)} rostered receivers, "
          f"{len(ok)} projectable")
    print(f"{'=' * 78}")
    if a.week == 1:
        print("  WEEK 1 CAVEAT: measured calibration error 3-5% after correction,")
        print("  vs 0.4-0.8% late season. Edge threshold raised to "
              f"{W1_MIN_EDGE:.0%}, stake cap {W1_KELLY_CAP:.1%}.")
        print("  See docs/WEEK1.md before betting any of this.")
    if len(slate) > len(ok):
        print("\n  Excluded:")
        for reason, n in slate[slate.excl_reason != ""].excl_reason.value_counts().items():
            print(f"    {n:>4}  {reason}")

    cols = ["player_display_name", "position", "team", "opponent_team",
            "proj_rec", "fair_line_rec", "proj_yards", "fair_line_yards",
            "questionable"]
    top = ok.sort_values("proj_yards", ascending=False).head(a.top)
    print(f"\n  TOP {a.top} BY PROJECTED YARDS (fair lines = model median)\n")
    print(top[cols].to_string(index=False,
                              float_format=lambda x: f"{x:.1f}"))

    ok.sort_values("proj_yards", ascending=False).to_csv(a.out, index=False)
    print(f"\n  full slate -> {a.out}")

    if not a.odds:
        print("\n  No odds pulled. Compare the fair lines above to your book:")
        print("  a book line BELOW the fair line favours the over, and vice versa.")
        print("  Run with --odds and ODDS_API_KEY set for scored picks.\n")
        return

    if not os.environ.get("ODDS_API_KEY"):
        print("\n  ODDS_API_KEY not set - cannot pull odds. "
              "Player props are a paid tier.\n")
        return

    from odds import OddsClient, no_vig_consensus
    client = OddsClient()
    quotes = client.slate()
    cons = no_vig_consensus(quotes)
    print(f"\n  {len(quotes)} quotes, {len(cons)} distinct player/market/line "
          f"({client.credits_remaining} credits left)")

    picks = make_picks(ok, model, cons, a.week)
    print(f"\n  {len(picks)} picks clear the {(W1_MIN_EDGE if a.week==1 else MIN_EDGE):.0%} "
          f"edge gate\n")
    for p in picks:
        print(f"  {p.player:<24} {p.side.upper():<5} {p.line:>5.1f} "
              f"{p.market:<16} {p.odds:>+5.0f} @{p.book:<12} "
              f"model {p.model_prob:.1%} vs mkt {p.market_prob:.1%}  "
              f"EV {p.ev_per_unit:+.1%}  stake {p.kelly_stake:.2%}")
    if picks:
        log_picks(picks, "picks_log.jsonl")
        print("\n  logged to picks_log.jsonl - record closing lines after kickoff")


if __name__ == "__main__":
    main()
