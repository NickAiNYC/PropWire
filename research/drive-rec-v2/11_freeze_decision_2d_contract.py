"""11_freeze_decision_2d_contract.py — freeze the Decision 2D execution contract.

This script writes artifacts/decision_2d_contract.json, the PRECOMMITTED
execution contract for the historical-quote validation pilot authorized by
Decision 2D. It must run BEFORE any licensed quote data is acquired; running it
now, with no quote store present, is the precommitment act. The contract embeds
SHA-256 hashes of every frozen artifact it depends on, and the pilot harness
(`decision_2d/contract.py`) refuses to evaluate anything unless those hashes
still match (refit lock).

Rule of interpretation: any change to a threshold in this contract AFTER quote
acquisition is a protocol violation and voidates the pilot. If the owner amends
the contract, the amendment must happen before purchase and be recorded as a new
contract version with a new freeze run.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

DRIVE = Path(__file__).resolve().parent
sys.path.insert(0, str(DRIVE))
from lib.common import ARTIFACTS  # noqa: E402


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


CONTRACT_SPEC = {
    "contract_id": "DECISION_2D_EXECUTION_CONTRACT",
    "version": 1,
    "authority": (
        "Decision 2D, from the project owner's review of Decision 2C (sections "
        "'C4 decision', 'Next priority', 'Decision 2D - Proposed execution "
        "contract', 'Rebuild and provenance control', and the final directive)."),
    "objective": (
        "Measure REALIZABLE return at prices a customer could actually obtain. "
        "The study does not optimize another calibration score. The question is "
        "whether the calibrated probabilities identify positive expected value "
        "at executable prices."),
    "study_market": {
        "league": "NFL",
        "market": "player receiving yards, over/under on the PRIMARY (main) line "
                  "initially — alternates and other prop markets excluded from "
                  "the pilot",
        "rationale": "deepest player-prop liquidity; primary lines only to avoid "
                     "line-shopping artifacts across alternate prices",
    },
    "models": {
        "primary_arm": "CANDIDATE = frozen logistic incumbent + isotonic "
                       "recalibration (2024 dev only) — the calibrated model",
        "secondary_arm": "INCUMBENT = frozen logistic (2023 train only) — "
                         "economic comparison arm, not eligible for promotion",
        "refit_lock": (
            "PROHIBITED during the pilot: refitting, re-tuning, or re-freezing "
            "any model, calibrator, transformation parameter, threshold, or "
            "quote-scenario constant. The pilot harness verifies the frozen "
            "hashes below before any evaluation and aborts on mismatch."),
        "frozen_artifacts_sha256": {},   # filled by main()
        "frozen_prediction_path": (
            "Pregame P(over line) is produced ONLY by the frozen transformation "
            "in decision_2d/yards_projection.py: Monte Carlo over the frozen "
            "per-drive model with (a) drive contexts sampled from the 2023 "
            "TRAIN corpus context distribution, (b) team drive counts sampled "
            "from the 2023 TRAIN empirical distribution, (c) yards-per-reception "
            "distributions from the 2023 TRAIN play-by-play with position-group "
            "fallback, (d) first-drive feature rows (in-game counters zero). "
            "No parameter of the transformation may be estimated from data "
            "after 2023; 2024 may be used for machinery diagnostics only, never "
            "for tuning; 2025/2026 are untouched until the pilot run."),
    },
    "quote_source": {
        "requirement": "licensed, timestamped sportsbook prices with per-quote "
                       "bookmaker timestamps (not only snapshot timestamps)",
        "vendor": "PENDING_PURCHASE — candidates evaluated in "
                  "docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md",
        "storage_display_permission": "MUST be confirmed in writing with the "
                                      "vendor before the pilot run (covers "
                                      "derived-data storage and commercial "
                                      "display)",
        "synthetic_quotes": "forbidden in the pilot; any synthetic price makes "
                            "the run HYPOTHETICAL and non-promotable",
    },
    "selection": {
        "point_in_time": "strictly point-in-time; the prediction is frozen "
                         "pregame (no in-game information of any kind enters "
                         "P(over))",
        "decision_timestamps_before_kickoff": {
            "primary": "T-60m (NFL inactives typically published; roster state "
                       "at decision time is a legal input to the universe filter)",
            "sensitivity": ["T-180m", "T-15m"],
            "closing_benchmark": "last available snapshot at or before kickoff",
        },
        "universe": "causal player universe (prior-game usage rule) intersected "
                    "with players priced by the given bookmaker at the decision "
                    "snapshot; universe membership never uses post-decision "
                    "roster information",
    },
    "quote_age": {
        "primary_live_analysis_max_seconds": 60,
        "sensitivity_seconds": [120, 300],
        "historical_cadence_caveat": (
            "5-minute historical snapshots (the finest generally available for "
            "player props) support only the 300s tier for historical backtests; "
            "the 60s/120s tiers require finer-granularity data or the Phase B "
            "live capture. A historical pilot on 5-minute snapshots therefore "
            "reports quote age honestly as 0-300s and CANNOT claim 60s "
            "executability — this is recorded, not worked around."),
    },
    "entry_prices": {
        "rule": "actual available odds at the decision snapshot for the SAME "
                "bookmaker whose quote is being evaluated — never synthetic, "
                "never cross-book best-price unless separately reported",
        "odds_formats": "store both decimal and American; compute in decimal",
    },
    "benchmarks": {
        "primary": "same-book contemporaneous quote at the decision timestamp",
        "reported_separately": [
            "cross-book consensus (median price across books quoting the market "
            "at the same snapshot)",
            "same-book closing line (for CLV)",
        ],
    },
    "settlement": {
        "outcome": "actual player receiving yards in the game, computed from the "
                   "nflverse play-by-play (CC BY 4.0): sum of play yards on "
                   "completed passes to the player",
        "known_caveats": "rare lateral-after-catch plays can differ from official "
                         "box-score receiving yards; any discrepancy above 5 "
                         "yards for any player-game must be logged, and the "
                         "official box score (if licensed) prevails when "
                         "available",
        "pushes": "line exactly equal to settled yards (integer lines only): "
                  "stake returned, realized return 0, excluded from alert "
                  "precision, INCLUDED in ROI at 0",
        "voids": "market voided (e.g., player inactive, market pulled): excluded "
                 "from ROI and precision, ALWAYS recorded in the availability "
                 "ledger",
    },
    "metrics": {
        "realized_roi": "mean over settled alerts of (D_entry - 1) if over wins, "
                        "-1 if under wins, 0 if push",
        "expected_roi": "mean over alerts of P_hat(over) * D_entry - 1",
        "clv": "mean over alerts of p_close_novig * D_entry - 1 where "
               "p_close_novig is the same-book closing implied probability with "
               "the two-sided vig removed by normalization",
        "alert_precision": "share of settled (non-push, non-void) alerts where "
                           "the over won",
        "calibration": "per alert threshold: mean P_hat(over) vs realized "
                       "over-rate inside the SELECTED subset (selection-"
                       "conditional, per the Decision 2C review finding)",
        "coverage": "(a) share of pilot games with at least one usable same-book "
                    "quote at the primary decision timestamp; (b) share of "
                    "causal-universe players priced per book; (c) full "
                    "distribution of quote age at decision",
    },
    "uncertainty": {
        "method": "game-clustered bootstrap (resample games with replacement)",
        "replicates": 1000,
        "seeds": "fixed and recorded in the run artifact",
        "reporting": "every headline number reported with its 95% clustered CI",
    },
    "leakage_protection": {
        "features": "no feature, line, or roster information from after the "
                    "decision timestamp may enter predictions, the universe, or "
                    "the transformation; enforced by assertion in "
                    "decision_2d/point_in_time.py",
        "lines": "the posted line is an input to WHICH prediction is evaluated, "
                 "never a feature of the frozen model",
        "roster": "universe filtering at T-60m may use inactives published "
                  "before the decision timestamp only",
    },
    "availability_and_missingness": {
        "requirement": (
            "Preserve quote availability and missingness. A backtest must NOT "
            "treat the existence of a historical quote as proof it was "
            "executable for the user at that moment."),
        "ledger_fields": [
            "per (game, book, market, snapshot): quote presence, bookmaker "
            "last_update timestamp, line, price, American/decimal pair",
            "per (game, player): priced by which books; line value(s); voided?",
            "per decision timestamp: number of books quoting, quote age "
            "distribution, gaps between snapshots",
        ],
        "reporting": "coverage and missingness are reported alongside every "
                     "economic number; alert counts are reported per book and "
                     "in aggregate",
    },
    "alert_thresholds": {
        "primary": "model EV >= 5% (EV = P_hat(over) * D_entry - 1)",
        "secondary_report_only": ["EV >= 3%", "EV >= 8%"],
        "note": "the 5% band is where criteria v3 C4 failed; the pilot tests it "
                "with real prices",
    },
    "gates": {
        "E1_sample_adequacy": (
            "Every primary evaluation cell (model x alert threshold) requires "
            ">= 100 settled (non-void) alerts from >= 25 distinct games; "
            "otherwise LOW_SAMPLE, which cannot support promotion (fail-closed)."),
        "E2_selection_conditional_calibration": (
            "Within each primary alert threshold: |mean P_hat(over) - realized "
            "over-rate| <= 3.0pp (the unchanged C4 threshold) AND the 95% "
            "game-clustered CI of the gap contained within +/- 5.0pp."),
        "E3_realized_roi": (
            "Mean realized ROI > 0 AND the 95% game-clustered CI lower bound "
            ">= -1.0%."),
        "E4_clv": "Mean CLV >= 0 (entries not systematically worse than the "
                  "same-book close).",
        "E5_expected_vs_realized": (
            "The 95% game-clustered CI of (mean realized ROI - mean expected "
            "ROI) lies within +/- 3.0pp (detects systematic EV overstatement, "
            "the Decision 2C finding)."),
        "E6_data_integrity_coverage": (
            "License terms confirmed in writing (storage + commercial display "
            "of derived data); snapshot timestamps verified monotonic with "
            "bookmaker last_update <= snapshot time; game coverage >= 70% at "
            "the primary decision timestamp; complete void/push accounting."),
        "promotion_rule": (
            "FAIL-CLOSED. Any gate FAIL or LOW_SAMPLE leaves status "
            "RESEARCH_ONLY. Promotion to any production-eligible status "
            "requires ALL gates PASS on the primary arm AND human approval via "
            "a signed HUMAN_REVIEW.md. Adapters remain disabled either way "
            "until Phase B passes."),
    },
    "pilot_scope": {
        "seasons": ["2025 (previously inspected holdout — labeled as such)",
                    "2026 weeks 1-7 (as of freeze; genuinely unseen)"],
        "games_estimate": "285 + 107 = 392 games (regular + postseason 2025; "
                          "weeks 1-7 2026)",
        "books": "PENDING_VENDOR_CONFIRMATION (trial verifies actual NFL "
                 "receiving-props coverage by bookmaker and date BEFORE "
                 "purchase)",
        "cost_estimate_basis": "see docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md "
                               "(estimate only; not a commitment)",
    },
    "phase_b_prospective": {
        "requirement": (
            "Before enabling ANY production alert: a prospective, precommitted "
            "economic validation on genuinely forward data with live quote "
            "capture (observability-only, read-only adapters) at the 60s "
            "quote-age tier. Phase A (this pilot) cannot substitute for it."),
        "gate_structure": "precommitted before Phase B starts; same fail-closed "
                          "promotion rule with human approval",
    },
    "interpretation_notes": [
        "All Phase A numbers on 2025 are on a previously inspected holdout and "
        "are labeled as such; only Phase B is genuinely prospective.",
        "Gate thresholds E1-E6 are precommitted in this freeze. Changing any of "
        "them after quote acquisition voidates the pilot.",
        "The zero-fresh-quote-alert ambiguity of Decision 2C remains open; the "
        "pilot is designed to distinguish its three candidate explanations.",
    ],
}


def main() -> int:
    contract = dict(CONTRACT_SPEC)
    contract["frozen_at_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
    contract["status"] = "PRECOMMITTED_BEFORE_QUOTE_ACQUISITION"
    contract["quote_store_present_at_freeze"] = False
    contract["models"]["frozen_artifacts_sha256"] = {
        name: sha256_file(ARTIFACTS / name)
        for name in ("incumbent_model.json", "isotonic_calibrator.json",
                     "criteria_v3.json", "corpus_stats.json",
                     "incumbent_model.joblib", "isotonic_calibrator.joblib")
    }
    contract["criteria_v3_content_sha256"] = json.loads(
        (ARTIFACTS / "criteria_v3.json").read_text())["content_sha256"]

    out = ARTIFACTS / "decision_2d_contract.json"
    out.write_text(json.dumps(contract, indent=2))
    print(f"[contract] frozen at {contract['frozen_at_utc']}")
    for k, v in contract["models"]["frozen_artifacts_sha256"].items():
        print(f"  frozen {k}: {v[:16]}...")
    print(f"[contract] {len(contract['gates'])} gates precommitted "
          f"(E1-E6, fail-closed); C4 threshold unchanged at 3.0pp")
    print(f"[output] {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
