# HUMAN_REVIEW.md — PropStein Live Sniper model promotion

**Status: DEFERRED — UNSIGNED.** Per Decision 2C (and reaffirmed by the Decision
2C review / Decision 2D authorization), human sign-off is deferred and this file
is intentionally not signed. No model is promoted to CALIBRATED status; no
production betting alert is enabled.

## What a human reviewer should verify before any future signature

1. Rebuild disclosure (README §Rebuild disclosure; report §0; PROVENANCE.md):
   this workspace re-derives all artifacts from public nflverse data; the prior
   environment's artifacts were not available. The six original DRIVE-REC-V1
   commits remain documented as **unrecovered**, not restored.
2. Reproduce the pipeline end-to-end: `python research/00..09` in order;
   confirm `artifacts/provenance_manifest.json` hashes match downloads, then run
   `verify_provenance.py` and review `artifacts/provenance_verification.json`
   (24/25 §11 hashes; the one miss is the disclosed self-hash erratum with a
   git immutability proof).
3. Confirm ordering discipline: `artifacts/criteria_v3.json` (content hash
   above) was committed before scripts 05–08 ran (git history), and
   `artifacts/decision_2d_contract.json` was frozen **before any quote
   acquisition** (still pending — no licensed quotes purchased).
4. Spot-check leakage assertions in `research/01_build_corpus.py` output and the
   causal player-universe rule; confirm the Decision 2D transformation
   parameters derive from the 2023 training season only
   (`decision_2d/yards_projection.py` asserts this).
5. Review the criteria v3 verdict and the single C4 failure (EV ≥ 5% band,
   2025 previously-inspected holdout, probability gap 3.05pp vs the unchanged
   3.0pp threshold; n=2,191 across 272 games) and the Decision 2C review's
   decision to keep C4 at 3.0pp (recorded in DECISION_LOG.md).
6. Review the selection-amplification diagnostic
   (`artifacts/selection_amplification_*.json`): the EV ≥ 5% selection
   mechanism, not probability composition, produces essentially the entire
   conditional miss; decile-ECE does not establish selection-conditional
   calibration.
7. Review the EV reliability gate limitations (hypothetical simulated prices)
   and the zero-fresh-quote-alert ambiguity (three unresolved explanations)
   before authorizing any observability-only quote capture.
8. Decision 2D pilot readiness: review
   `docs/DECISION_2D_CONTRACT.md` (precommitted gates E1–E6, fail-closed) and
   `docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md` (vendor verification checklist;
   the 60s live quote-age tier is not backtestable from 5-minute historical
   snapshots — Phase B required). Confirm the pilot has NOT started and that
   model refitting remains prohibited during it.
9. Confirm no sportsbook adapter was enabled and no order-placement code exists
   in this workspace.
10. Review the disclosed artifacts-deletion incident and its recovery evidence
    (PROVENANCE.md §3) before incorporating anything into the main repository.

## Promotion status (mirror of Decision 2C + Decision 2D authorization)

| Component | Decision |
| --- | --- |
| Offline logistic baseline | Retain |
| Mixture models M2/M3 | Do not promote |
| Criteria v2 research results | Accept as reported |
| Tail recalibration research | Accepted as research evidence, **not promotion** (Decision 2C review) |
| C4_MAX_GAP_PP | Kept at 3.0 (unchanged; 3.05pp recorded as FAIL) |
| Historical-quote validation pilot | Authorized, precommitted, **not started** (no licensed quotes) |
| Vendor trial (Decision 2D-V) | Harness built + self-tested 9/9 on synthetic fixtures; precommitted 8-game sample frozen; **zero vendor requests, zero credits**; awaits owner-side execution with ODDS_API_KEY env var and V8 written permission |
| Human sign-off | **Deferred** |
| CALIBRATED label | **Blocked** |
| Real-book model coverage | NO_COVERAGE |
| Live sportsbook adapters | Disabled |
| Production betting alerts | Not enabled (require Phase B prospective validation + human approval) |

## Signature

- Reviewer: ______________________
- Date: ______________________
- Decision: ______________________

*(Left blank intentionally.)*
