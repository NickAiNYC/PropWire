# UFC module — implementation notes (2026-10-31)

**Honesty header:** UFC graded decisions N = 0 · beat-close — · CLV CI — · **NO EDGE**. Every UFC surface shows NO EDGE until the ledger below has N ≥ 300 with a CLV CI lower bound > 0.

## Sources (decisions)
- **Card, results, fighter bios:** ESPN public UFC scoreboard / athlete API (the same public feeds PropStein already uses for NFL/NBA schedules and photos). UFC-only by construction.
- **UFCStats is not used.** It publishes no API or data licence, so strike/takedown/control-time stats are not scraped. Those models stay out of scope until a licensed stats source exists.
- **Odds:** The Odds API `mma_mixed_martial_arts`, markets `h2h,totals`, region `us`, one request per pull (2 credits). Odds events that don't match a fighter pair on the ESPN UFC card (PFL, ONE, etc.) are dropped and counted in `odds_meter.non_ufc_dropped`. The budget guard aborts before a request if the estimate is over `--max-credits` (default 4). A missing `x-requests-last` header fails closed.

## Model (`src/ufc/ratings.py`)
- Elo from UFC results since 2020: K=40 for a fighter's first 5 fights, 28 after, ×1.15 for finishes.
- Pre-fight adjustments are **priors, not fitted**: reach +4/in, age −12/yr over 32, layoff >400 days −25, first fight after moving up a class −20.
- Round totals: P(under L) = p_finish × F(L). p_finish blends the weight-class finish rate with both fighters' shrunk finish rates (k=6), ×1.1 for 5-rounders. F is the empirical finish-time CDF.
- `backtest()` is walk-forward on results only (Brier and log-loss vs a coin flip). It is **not** a CLV test.

## Status layer (`src/ufc/status.py`, `viewer/ufc_status_<date>.json`)
- Auto-detected by diffing each new ESPN card against the last one written: a fight that disappears is `cancelled`; if one of its fighters is on a new bout, it is `scratched` and the new bout is `replacement` (`short_notice`).
- Manual entries go in `viewer/ufc_status_overrides.json` as `{ "<card date>": { "<fight_id>": {"status": "missed_weight", "detail": "..."} } }`.
- `cancelled`, `scratched`, `draw` and `no_contest` are void. Void fights are never snapshotted or graded.

## Snapshots and grading
- `freeze_ufc.yml` captures **pre** (Fri 13:00 UTC), **post** (Fri 22:00 UTC) and **lock** (≤60 min before each fight). A captured point is never overwritten; a missed point stays missing.
- Research decision: model − market no-vig ≥ 3 pts at the pre snapshot (falls back to post).
- CLV = lock no-vig − decision no-vig. No lock snapshot → CLV ungradable.
- **Draw / no contest / cancellation / scratch = void (push), excluded from N.** ESPN does not separate draws from NCs, and both are void.
- Totals are not graded yet (limited vendor coverage).
- `python3 grade_clv.py --sport ufc` writes `viewer/ufc_ledger.json`.

## Not built (blocked)
- Method-of-victory, round and fighter-stat props: no market exists at the primary vendor (README §A2).
- Style-matchup features need a licensed per-fight stats source.
