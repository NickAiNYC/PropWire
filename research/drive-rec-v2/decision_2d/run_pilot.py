"""run_pilot.py — orchestrator for the Decision 2D historical-quote pilot.

EXECUTION ORDER (fail-closed at every step):

  1. verify the frozen contract (refit lock: artifact hashes must match);
  2. refuse to run without a LICENSED quote store at data/quotes/quotes.parquet
     (synthetic quotes are refused by quotes.validate_quotes);
  3. build the causal-universe first-drive feature rows for the pilot seasons;
  4. select same-book quotes point-in-time (primary T-60m; closing for CLV);
  5. compute P(over) with the frozen 2023-only yards transformation;
  6. form alerts at the precommitted thresholds (primary EV >= 5%);
  7. settle against actual receiving yards (push/void handled);
  8. report the availability ledger and evaluate gates E1-E6;
  9. write artifacts/pilot_run_<stamp>.json (or refuse, with the reason).

Until licensed quotes exist, `--check` reports readiness and exits: the pilot
has NOT started. Nothing in this file fits, tunes, or selects anything.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DRIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DRIVE))
sys.path.insert(0, str(DRIVE / "decision_2d"))

from lib.common import ALL_FEATURES, ARTIFACTS, DATA, HOLDOUT_SEASON, UNSEEN_SEASON  # noqa: E402
import contract as d2c            # noqa: E402  (decision_2d.contract)
import quotes as d2q              # noqa: E402
import point_in_time as d2p       # noqa: E402
import settlement as d2s          # noqa: E402
import metrics as d2m             # noqa: E402
import ledger as d2l              # noqa: E402

QUOTE_STORE = DATA / "quotes" / "quotes.parquet"
PILOT_SEASONS = [HOLDOUT_SEASON, UNSEEN_SEASON]
ALERT_THRESHOLD_PRIMARY = 0.05
ALERT_THRESHOLDS_REPORT_ONLY = [0.03, 0.08]


def first_drive_rows(season: int) -> pd.DataFrame:
    """Per (game, player): the first corpus row = pregame feature state
    (in-game counters zero) with all frozen-model features."""
    pdf = pd.read_parquet(DATA / f"player_drives_{season}.parquet")
    idx = pdf.groupby(["game_id", "player_id"]).drive_idx_team.idxmin()
    rows = pdf.loc[idx, ["game_id", "player_id", "player_name", "position",
                         "posteam"] + ALL_FEATURES].copy()
    rows["season"] = season
    return rows


def build_alerts(sel: pd.DataFrame, p_over: pd.DataFrame,
                 closing: pd.DataFrame, threshold: float) -> pd.DataFrame:
    """Join entry quotes + P(over) + closing benchmark; filter EV >= threshold."""
    a = sel.merge(p_over[["game_id", "player_id", "line", "p_over", "mc_se"]],
                  on=["game_id", "player_id", "line"], how="inner")
    a = a.dropna(subset=["p_over"])
    a["ev_model"] = a.p_over * a.price_over_decimal - 1.0
    # closing benchmark per (game, book, player): no-vig over probability
    cl = closing.drop_duplicates(["game_id", "bookmaker", "player_id"]).copy()
    cl["p_close_novig"] = [d2q.novig_close_prob(o, u) for o, u in
                           zip(cl.price_over_decimal, cl.price_under_decimal)]
    a = a.merge(cl[["game_id", "bookmaker", "player_id", "p_close_novig"]],
                on=["game_id", "bookmaker", "player_id"], how="left")
    return a.loc[a.ev_model >= threshold].copy()


def run(seasons: list[int] = PILOT_SEASONS, n_sims: int = 4000,
        n_ctx: int = 2000, stamp: str | None = None) -> int:
    # ---- 1. contract / refit lock ------------------------------------
    contract = d2c.verify_contract()

    # ---- 2. licensed quotes required ---------------------------------
    if not QUOTE_STORE.exists():
        print("[refuse] no licensed quote store at data/quotes/quotes.parquet — "
              "the pilot has not started. Acquire quotes per "
              "docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md first.")
        return 1
    q = d2q.load_quote_store(QUOTE_STORE)

    # ---- 3. frozen transformation + corpus rows ----------------------
    import joblib
    model = joblib.load(ARTIFACTS / "incumbent_model.joblib")
    iso = joblib.load(ARTIFACTS / "isotonic_calibrator.joblib")
    from yards_projection import FrozenYardsProjection
    proj = FrozenYardsProjection.from_train_data(
        model, iso.predict, DATA, n_ctx=n_ctx, n_sims=n_sims)

    stamp = stamp or dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_artifact: dict = {
        "run_id": stamp, "contract_frozen_at": contract["frozen_at_utc"],
        "quote_store": str(QUOTE_STORE),
        "transformation_fingerprint": proj.param_fingerprint(),
        "seasons": [], "hypothetical": False,
        "note": "Decision 2D Phase A historical pilot; 2025 is a previously "
                "inspected holdout (labeled as such).",
    }

    for season in seasons:
        rows = first_drive_rows(season)
        pbp = pd.read_parquet(
            DATA / f"play_by_play_{season}.parquet",
            columns=["game_id", "complete_pass", "receiver_player_id", "yards",
                     "two_point_conversion"])
        yards = d2s.receiving_yards_by_game(pbp)
        sched = rows.game_id.unique()

        season_q = q.loc[q.game_id.str.startswith(str(season))]
        sel = d2p.select_quotes_at(season_q, d2p.DECISION_OFFSETS["T-60m"],
                                   label="T-60m primary")
        closing = d2p.select_quotes_at(season_q, d2p.DECISION_OFFSETS["closing"],
                                       label="closing",
                                       strictly_before_kickoff=False)
        cover = d2l.game_coverage(season_q, sel, sched)

        p_over = proj.p_over_frame(rows, sel[["game_id", "player_id", "line"]])
        alerts = build_alerts(sel, p_over, closing, ALERT_THRESHOLD_PRIMARY)
        settled = d2s.settle_frame(alerts, yards)
        gates = d2m.evaluate_gates(settled, contract, cover["coverage_at_decision"])
        rep = d2l.ledger_report(season_q, sel, sched,
                                rows[["game_id", "player_id"]])

        season_report = {
            "season": season,
            "label": "previously inspected holdout" if season == HOLDOUT_SEASON
                     else "genuinely unseen prospective slice (weeks 1-7)",
            "scheduled_games": cover["scheduled_games"],
            "coverage": cover, "ledger": rep,
            "alerts_primary_threshold_ev5": gates,
            "report_only_bands": {
                f"EV >= {t:.0%}": len(build_alerts(sel, p_over, closing, t))
                for t in ALERT_THRESHOLDS_REPORT_ONLY},
        }
        run_artifact["seasons"].append(season_report)
        g = gates["overall"]
        print(f"[{season}] alerts={len(settled)} gates={g} "
              f"coverage={cover['coverage_at_decision']:.1%}")

    out = ARTIFACTS / f"pilot_run_{stamp}.json"
    out.write_text(json.dumps(run_artifact, indent=2, default=str))
    print(f"[output] {out}")
    return 0


def check() -> int:
    """Readiness check without evaluating anything."""
    try:
        contract = d2c.verify_contract()
        print(f"[ready] contract verified (frozen {contract['frozen_at_utc']}, "
              f"{len(contract['gates'])} gates)")
    except d2c.ContractViolation as e:
        print(f"[BLOCKED] {e}")
        return 1
    if QUOTE_STORE.exists():
        try:
            d2q.load_quote_store(QUOTE_STORE)
            print("[ready] licensed quote store present and valid")
        except d2q.QuoteValidationError as e:
            print(f"[BLOCKED] quote store invalid: {e}")
            return 1
    else:
        print("[pending] no quote store yet — pilot NOT started "
              "(vendor evaluation: docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md)")
    for season in PILOT_SEASONS:
        ok = (DATA / f"player_drives_{season}.parquet").exists() and \
             (DATA / f"play_by_play_{season}.parquet").exists()
        print(f"[{'ready' if ok else 'MISSING'}] corpus+pbp for {season}")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check())
    sys.exit(run())
