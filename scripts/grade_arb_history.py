#!/usr/bin/env python3
"""
PropWire Auto-Grader Cron Worker (`scripts/grade_arb_history.py`)
=================================================================

Runs every 15-30 minutes via Railway Cron outside the FastAPI web server
so grading never blocks request threads.

Workflow:
  1. Inspects `PENDING` alerts in `arb_history`.
  2. Checks which NBA/NFL games are marked `FINAL` (or settled in `last_known_odds`).
  3. Pulls closing lines & closing odds from `last_known_odds`, computes CLV:
       `clv_ratio = (Entry_Odds - Closing_Odds) / Closing_Odds`
       `clv_pct = clv_ratio * 100.0`
  4. Marks each settled alert as `GRADED` and locks the SHA-256 `receipt_hash`.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.agents.persistence import TruthStore
from src.services.arb_ledger import ArbLedgerService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("propwire.grade_arb_history")


def fetch_final_game_ids(truth_store: TruthStore) -> set[str] | None:
    """
    Resolve game IDs that have reached FINAL status. If live scoreboard polling
    is unavailable in offline/cron mode, returns `None` so all pending alerts
    with closing odds in `last_known_odds` are graded.
    """
    try:
        from nba_api.live.nba.endpoints import scoreboard  # type: ignore

        board = scoreboard.ScoreBoard()
        data = board.get_dict()
        games = data.get("scoreboard", {}).get("games", [])
        final_ids = {
            str(g.get("gameId"))
            for g in games
            if int(g.get("gameStatus", 0)) == 3 or "FINAL" in str(g.get("gameStatusText", "")).upper()
        }
        return final_ids if final_ids else None
    except Exception:
        return None


def run_auto_grader(
    *,
    db_path: Path | None = None,
    settled_game_ids: set[str] | None = None,
    closing_overrides: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    truth = TruthStore(sqlite_path=db_path) if db_path else TruthStore()
    ledger = ArbLedgerService(truth_store=truth)

    effective_final_ids = settled_game_ids if settled_game_ids is not None else fetch_final_game_ids(truth)
    graded = ledger.grade_pending_alerts(
        settled_game_ids=effective_final_ids,
        closing_overrides=closing_overrides,
    )
    summary = ledger.get_public_ledger(limit=50)
    logger.info(
        "Auto-grader finished: graded=%d total_graded=%d avg_clv_beat_pct=%.2f%%",
        len(graded),
        summary["total_graded_alerts"],
        summary["average_clv_beat_pct"],
    )
    return {
        "graded_count": len(graded),
        "graded_alert_ids": [g["alert_id"] for g in graded],
        "summary": summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Grade pending PropWire Arb History alerts.")
    parser.add_argument("--db-path", type=str, default=None, help="Optional SQLite DB path")
    parser.add_argument("--json", action="store_true", help="Print JSON summary to stdout")
    args = parser.parse_args()

    result = run_auto_grader(db_path=Path(args.db_path) if args.db_path else None)
    if args.json:
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

