# PropStein Live Sniper — Research Workspace (Decision 2C)

## Scope of this workspace

This workspace implements **Decision 2C: Tail Calibration & Economic Reliability** for the
PropStein Live Sniper research track.

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
research/            numbered, order-of-operations pipeline scripts
  lib/               shared loading / metrics / bootstrap helpers
artifacts/           every JSON/CSV produced by the pipeline (auditable outputs)
docs/                human-readable reports and criteria definitions
data/                downloaded raw data (gitignored; reproducible via 00_download_data.py)
```

## How to run

```
python research/00_download_data.py
python research/01_build_corpus.py
python research/02_fit_incumbent.py
python research/03_evaluate_incumbent.py
python research/04_define_criteria_v3.py      # MUST run before 07
python research/05_fit_recalibration.py
python research/06_compare_dev.py
python research/07_evaluate_candidate.py
python research/08_ev_reliability_gate.py
python research/09_make_report.py
```

Requirements: see `requirements-research.txt`.
