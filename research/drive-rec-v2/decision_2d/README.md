# decision_2d/ — precommitted pilot harness (Phase A, awaiting licensed quotes)

Implements the frozen `artifacts/decision_2d_contract.json` (see
`docs/DECISION_2D_CONTRACT.md`). **No results exist yet**: no licensed quote
feed has been purchased, so every number the harness would produce is pending.
Tests run against synthetic fixtures for code correctness only.

| Module | Role |
| --- | --- |
| `contract.py` | loads the frozen contract; recomputes frozen-artifact SHA-256s and aborts on mismatch (the refit lock) |
| `quotes.py` | vendor-agnostic canonical quote store; validates schema, timestamps, prices; refuses synthetic quotes |
| `point_in_time.py` | strictly point-in-time quote selection (T−180m / T−60m / T−15m / closing); quote-age recording; leakage assertions |
| `settlement.py` | receiving yards from nflverse pbp; push = stake returned; void = excluded but ledgered |
| `metrics.py` | realized/expected ROI, CLV, alert precision, selection-conditional calibration; game-clustered bootstrap CIs; gates E1–E6 (fail-closed) |
| `ledger.py` | availability & missingness ledger (coverage by game/book/player, quote-age distribution, void/push accounting) |
| `yards_projection.py` | frozen 2023-only Monte Carlo: P(total receiving yards > line) from the frozen per-drive model |
| `run_pilot.py` | orchestrator; `python run_pilot.py --check` reports readiness without evaluating anything |

Run the tests:

```
cd research/drive-rec-v2
python -m unittest discover -s tests -v
```

Execution protocol (after quote purchase per
`docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md`):

1. map vendor output into the canonical schema → `data/quotes/quotes.parquet`;
2. `python decision_2d/run_pilot.py --check` (contract + quotes + corpus);
3. `python decision_2d/run_pilot.py` → `artifacts/pilot_run_<stamp>.json`
   with per-gate verdicts; any FAIL or LOW_SAMPLE leaves RESEARCH_ONLY.

The 60s live quote-age tier cannot be validated from 5-minute historical
snapshots; that tier belongs to Phase B (prospective live capture), which is
required before any production alert.
