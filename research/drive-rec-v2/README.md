# PropStein Live Sniper — Research Workspace (Decisions 2C + 2D)

## Scope of this workspace

This workspace (the `research/drive-rec-v2/` drive) implements **Decision 2C:
Tail Calibration & Economic Reliability** and the **Decision 2D historical-quote
validation pilot preparation** for the PropStein Live Sniper research track.

Authorized work (per Decision 2C):

1. Fit **isotonic recalibration** using **2024 development data only**, with the underlying
   logistic model **frozen**.
2. Compare the recalibrated model against the incumbent **on development data** before any
   further holdout evaluation.
3. Define **criteria v3** (top-decile calibration threshold, minimum sample requirements,
   uncertainty bounds) **before** evaluating the candidate.
4. Evaluate calibration specifically in the regions where the alert engine would operate,
   including **p >= 0.30** and each **positive simulated-EV band**.
5. Test whether recalibration improves tail reliability **without materially degrading**
   global Brier score, log loss, or other prospective slices.
6. **Preserve original predictions and calibration artifacts** for comparison.

Additional requirement — **economic validation** (EV reliability gate):

* Per alert threshold: number of qualifying observations, mean predicted probability vs.
  realized frequency, predicted vs. realized return at the evaluated prices, game-clustered
  confidence intervals, and sensitivity to quote latency, stale prices, and execution
  assumptions.
* The historical corpus contains **no genuine contemporaneous market quotes**, so probability
  calibration is reported separately and **all simulated-price EV analysis is labeled
  HYPOTHETICAL**. It cannot establish executable betting profitability.

## Decision 2D additions (this cycle)

Per the Decision 2C review and Decision 2D authorization (see `DECISION_LOG.md`):

1. **C4 threshold unchanged at 3.0pp**; the 3.05pp failure is recorded with full
   statistics; the isotonic candidate is preserved as a research artifact.
2. **`10_selection_amplification.py`** — the ordered investigation of how much of
   the C4 deviation comes from the EV ≥ 5% selection mechanism (answer: essentially
   all of it; see DECISION_LOG.md for the decomposition and the regression-to-mean
   structure of claimed information gain).
3. **`11_freeze_decision_2d_contract.py`** — froze the precommitted execution
   contract (`artifacts/decision_2d_contract.json`) BEFORE any quote acquisition,
   with SHA-256 hashes of every frozen artifact (the refit lock).
4. **`decision_2d/`** — the pilot harness: canonical quote store, strictly
   point-in-time selection, settlement with push/void handling, economic metrics
   with game-clustered CIs, availability/missingness ledger, frozen 2023-only
   yards transformation, and the fail-closed gate evaluation (E1–E6). Tested
   against synthetic fixtures only (`tests/test_decision_2d.py`, 36 tests) — no
   results exist yet.
5. **`docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md`** — vendor evaluation
   (The Odds API / SportsDataIO, identified from redacted descriptions — confirm
   before purchase), pre-purchase verification checklist, pilot scope and cost
   estimate. **Critical limitation recorded:** 5-minute historical snapshots
   cannot validate the ≤60s live quote-age tier; that requires Phase B live
   capture.
6. **`verify_provenance.py`** — automated verification of the preservation
   manifest, corpus, split discipline, criteria ordering, and evaluation-script
   discipline (all pass; see `PROVENANCE.md`).

The model remains **research-only**. The pilot has **not started**: no licensed
quotes have been purchased, and the harness refuses to evaluate without them.

## Rebuild disclosure (important)

The engineering sandbox that produced the original DRIVE-REC-V1 artifacts was recycled
before this session. The original working tree (including the six local commits referenced
in Decision 2C) is **not present in this environment**, and the private GitHub repository is
not accessible from here (credentials are intentionally excluded from this session per the
agreed security rule).

This workspace therefore **rebuilds the corpus, the frozen logistic incumbent, and the full
calibration harness from public nflverse data**. Consequences:

* Every number in `artifacts/` and `docs/` is **freshly measured in this run** and is fully
  reproducible from the scripts in `research/`.
* The figures quoted in Decision 2C (40.0% predicted / 31.5% observed in the p >= 0.30 tail)
  were produced by the prior environment and are treated as **reported findings, not as
  ground truth**. Where this rebuild's measurements differ, the difference is disclosed in
  `docs/TAIL_RECALIBRATION_REPORT.md` rather than reconciled by tuning.
* No result from the prior environment is used as an input anywhere in this pipeline.

## Promotion status (unchanged by this workspace)

| Component | Decision |
| --- | --- |
| Offline logistic baseline | Retain |
| Mixture models M2/M3 | Do not promote |
| Criteria v2 research results | Accept as reported |
| Tail recalibration research | Approved (this workspace) |
| Human sign-off | Deferred |
| CALIBRATED label | Blocked |
| Real-book model coverage | NO_COVERAGE |
| Live sportsbook adapters | Disabled |

The model remains **research-only**. `HUMAN_REVIEW.md` is present but **unsigned**.

## Data licensing

See `LICENSES.md`. All inputs are nflverse releases (CC BY 4.0). Big Data Bowl data
(non-commercial license) is **excluded** and must never enter this pipeline.

## Layout

```
00–09_*.py           numbered, order-of-operations pipeline scripts
lib/                 shared loading / metrics / bootstrap helpers
artifacts/           every JSON/CSV produced by the pipeline (auditable outputs)
docs/                human-readable reports and criteria definitions
data/                downloaded raw data (gitignored; reproducible via 00_download_data.py)
```

Additionally (Decision 2D): `DECISION_LOG.md`, `PROVENANCE.md`,
`10_selection_amplification.py`, `11_freeze_decision_2d_contract.py`,
`verify_provenance.py`, `decision_2d/` (harness + README), `tests/`.

## How to run

```
python 00_download_data.py
python 01_build_corpus.py
python 02_fit_incumbent.py
python 03_evaluate_incumbent.py
python 04_define_criteria_v3.py           # MUST run before 07
python 05_fit_recalibration.py
python 06_compare_dev.py
python 07_evaluate_candidate.py
python 08_ev_reliability_gate.py
python 09_make_report.py
python 10_selection_amplification.py     # Decision 2D diagnostic
python 11_freeze_decision_2d_contract.py # re-freeze only PRE-purchase
python verify_provenance.py
python -m unittest discover -s tests     # decision_2d harness tests (36)
python decision_2d/run_pilot.py --check  # readiness, no evaluation
```

(Run from inside `research/drive-rec-v2/`.)

Requirements: see `requirements-research.txt`.
