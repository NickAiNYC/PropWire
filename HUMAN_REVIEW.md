# HUMAN_REVIEW.md — PropStein Live Sniper model promotion

**Status: DEFERRED — UNSIGNED.** Per Decision 2C, human sign-off is deferred and this file is intentionally not signed. No model is promoted to CALIBRATED status.

## What a human reviewer should verify before any future signature

1. Rebuild disclosure (README §Rebuild disclosure; report §0): this workspace re-derives all artifacts from public nflverse data; the prior environment's artifacts were not available.
2. Reproduce the pipeline end-to-end: `python research/00..09` in order; confirm `artifacts/provenance_manifest.json` hashes match downloads.
3. Confirm ordering discipline: `artifacts/criteria_v3.json` (content hash above) was committed before scripts 05–08 ran (git history).
4. Spot-check leakage assertions in `research/01_build_corpus.py` output (all assertions passed in this run) and the causal player-universe rule.
5. Review the criteria v3 verdict and the single C4 failure (EV ≥ 5% band, 2025 previously-inspected holdout, probability gap 3.05pp vs 3.0pp threshold) and decide whether to accept or tighten the threshold.
6. Review the EV reliability gate limitations (hypothetical simulated prices) and the fresh-quote finding before authorizing any observability-only quote capture.
7. Confirm no sportsbook adapter was enabled and no order-placement code exists in this workspace.

## Promotion status (mirror of Decision 2C)

| Component | Decision |
| --- | --- |
| Offline logistic baseline | Retain |
| Mixture models M2/M3 | Do not promote |
| Criteria v2 research results | Accept as reported |
| Tail recalibration research | Approved (executed in this workspace) |
| Human sign-off | **Deferred** |
| CALIBRATED label | **Blocked** |
| Real-book model coverage | NO_COVERAGE |
| Live sportsbook adapters | Disabled |

## Signature

- Reviewer: ______________________
- Date: ______________________
- Decision: ______________________

*(Left blank intentionally.)*
