# PropStein Live Sniper — Decision 2C: Tail Calibration & Economic Reliability

Generated (UTC): 2026-10-30T04:23:07.697143+00:00  
Criteria v3 content hash: `894926614908c9d2...`  
Candidate status: **RESEARCH_ONLY** — CALIBRATED production label **BLOCKED**; human sign-off **DEFERRED**; `HUMAN_REVIEW.md` is present but **unsigned**.

## 0. Rebuild disclosure (read first)

The engineering sandbox that produced the original DRIVE-REC-V1 artifacts was recycled before this session; the original working tree (including the six local commits referenced in Decision 2C) is not present in this environment, and the private GitHub repository is intentionally inaccessible from here (credentials excluded from this session per the agreed security rule).

This workspace therefore **rebuilds the corpus, the frozen logistic incumbent, and the full calibration harness from public nflverse data** (CC BY 4.0, attributed in `LICENSES.md`). Consequences:

- Every number below is freshly measured in this run and reproducible from `research/00`–`research/09`.
- The figures quoted in Decision 2C (40.0% predicted / 31.5% observed in the p ≥ 0.30 tail, 8.5pp gap) are treated as **reported findings from the prior environment, not as ground truth**. This rebuild measures a materially smaller aggregate tail gap (see §3) with the same qualitative structure — monotonic overprediction increasing with predicted probability — and the remediation logic of Decision 2C is applied to what is actually measured. No pipeline parameter was tuned to reproduce the prior figures.

## 1. Scope and ordering discipline

Authorized work executed, in order (Decision 2C items 1–6 plus the economic validation requirement):

1. Isotonic recalibration fitted on **2024 development data only**; the underlying logistic model stayed **frozen** (2023 training season, C=0.01, never refit or re-tuned).
2. Incumbent vs candidate compared **on development data before any holdout evaluation**, using a cross-fitted isotonic (weeks 1–9 ↔ weeks 10–18) so no dev row is scored by a calibrator that saw its own half-season.
3. **Criteria v3 defined and frozen before any candidate number existed** (top-decile threshold, minimum samples, uncertainty bounds, EV-band checks, the baseline quote scenario, and the fail-closed promotion rule).
4. Calibration evaluated in the alert-engine operating regions: p ≥ 0.30 and each positive simulated-EV band (within the conviction region p ≥ 0.25).
5. Tail improvement tested against global non-degradation (Brier, log loss, AUC, ECE, and prospective slices).
6. Original predictions and all calibration artifacts preserved (see §11; SHA-256 hashes recorded).
7. Economic (EV reliability) gate implemented with simulated quotes, game-clustered confidence intervals, and sensitivity to quote latency, stale prices, and execution assumptions. **All price-based results are labeled HYPOTHETICAL.**

The 2025 season is evaluated as a **previously inspected holdout** (it informed model-development decisions; it is not an untouched final test set). The 2026 season (weeks 1–7) serves as the **genuinely unseen** prospective slice.

## 2. Corpus and data provenance

Source: nflverse releases only (play-by-play 2022–2026, player registry, game schedule) — CC BY 4.0, attribution in `LICENSES.md`. Big Data Bowl / NGS tracking data is **excluded**; player participation (who is on the field) remains unknown and is never imputed. The per-game player universe is a documented causal proxy (usage in the team's previous game; season openers: ≥4 prior-season games-with-usage).

| Season | Games | Team-drives | Player-drive rows | P(reception) | Reception coverage |
| --- | --- | --- | --- | --- | --- |
| 2023 | 272 | 6,141 | 54,680 | 0.155 | 71.7% |
| 2024 | 272 | 5,944 | 51,814 | 0.160 | 71.4% |
| 2025 | 272 | 5,829 | 51,114 | 0.158 | 72.4% |
| 2026 | 107 | 2,336 | 21,357 | 0.149 | 69.7% |

Coverage caveat: ~28–30% of actual skill-player receptions come from players outside the causal universe (bench players with no prior-game usage); the corpus measures the market-relevant universe, not all receptions.

## 3. The frozen incumbent and its tail problem (before recalibration)

| Season | Role | Brier | Log loss | AUC | Decile-ECE |
| --- | --- | --- | --- | --- | --- |
| 2023 | training (in-sample reference) | 0.1194 | 0.3869 | 0.7302 | 0.0148 |
| 2024 | development | 0.1226 | 0.3945 | 0.7329 | 0.0173 |
| 2025 | previously inspected holdout | 0.1218 | 0.3928 | 0.7287 | 0.0168 |
| 2026 | genuinely unseen prospective (weeks 1-7) | 0.1154 | 0.3760 | 0.7388 | 0.0175 |

Baselines on 2025 (Brier): empirical drive rate 0.1269, target-share 0.1335, possession-survival 0.1332 — the incumbent beats all three (criteria v2 baseline requirement).

Tail slices of the incumbent (gap = observed − predicted; negative = overprediction; 95% game-clustered bootstrap CI):

| Season | Slice | n | Mean predicted | Observed | Gap | 95% CI |
| --- | --- | --- | --- | --- | --- | --- |
| 2024 | p ≥ 0.25 | 8,266 | 0.344 | 0.354 | +1.0pp | [-0.2pp, +2.1pp] |
| 2024 | p ≥ 0.30 | 5,155 | 0.387 | 0.383 | -0.4pp | [-1.9pp, +1.0pp] |
| 2024 | p ≥ 0.35 | 3,087 | 0.430 | 0.413 | -1.7pp | [-3.3pp, -0.0pp] |
| 2024 | p ≥ 0.40 | 1,771 | 0.472 | 0.431 | -4.1pp | [-6.2pp, -1.9pp] |
| 2025 | p ≥ 0.25 | 8,358 | 0.350 | 0.346 | -0.4pp | [-1.5pp, +0.7pp] |
| 2025 | p ≥ 0.30 | 5,258 | 0.396 | 0.370 | -2.6pp | [-3.9pp, -1.2pp] |
| 2025 | p ≥ 0.35 | 3,219 | 0.442 | 0.405 | -3.6pp | [-5.2pp, -2.0pp] |
| 2025 | p ≥ 0.40 | 1,979 | 0.485 | 0.434 | -5.1pp | [-7.1pp, -3.1pp] |
| 2026 | p ≥ 0.25 | 2,918 | 0.351 | 0.359 | +0.8pp | [-1.1pp, +2.7pp] |
| 2026 | p ≥ 0.30 | 1,808 | 0.399 | 0.385 | -1.4pp | [-3.8pp, +1.0pp] |
| 2026 | p ≥ 0.35 | 1,117 | 0.445 | 0.424 | -2.1pp | [-4.9pp, +0.8pp] |
| 2026 | p ≥ 0.40 | 689 | 0.490 | 0.424 | -6.6pp | [-10.2pp, -3.2pp] |

Structure of the problem: overprediction grows monotonically with predicted probability. On the 2025 previously-inspected holdout the incumbent overpredicts by 2.6pp at p ≥ 0.30, 3.7pp at p ≥ 0.35 and 5.1pp at p ≥ 0.40 (CIs exclude zero); reliability bins above 0.50 overpredict by 6–12pp. This is the same phenomenon Decision 2C ordered remediated, measured at a smaller aggregate magnitude than the prior environment reported (disclosed in §0).

## 4. Criteria v3 (frozen before candidate evaluation)

Full definition: `artifacts/criteria_v3.json` (content hash above) and `docs/CRITERIA_V3.md`. Key thresholds: top-decile and alert-region point gap ≤ 3.0pp absolute and ≤ 10% relative, with the 95% game-clustered CI contained within ±5.0pp; minimum 300 rows from ≥ 25 games per evaluable slice; EV-band probability gap ≤ 3.0pp for bands with ≥ 100 rows; global non-degradation tolerances (Brier +0.002, log loss +0.010, AUC −0.002); fail-closed promotion requiring all primary criteria to pass on BOTH evaluation seasons; CALIBRATED label blocked pending human sign-off in all cases.

## 5. Isotonic recalibration (2024 development data only)

Fitted on 51,814 development rows (positive rate 0.1601); 122 knots; output range [0.0, 0.5]. The mapping compresses the tail: 0.40 → 0.425, 0.50 → 0.443, 0.60 → 0.465, 0.70+ → 0.500.

Development-season comparison (cross-fitted candidate; evaluated before any holdout evaluation):

| Model | Brier | Log loss | AUC | Decile-ECE |
| --- | --- | --- | --- | --- |
| Incumbent | 0.1226 | 0.3945 | 0.7329 | 0.0173 |
| Candidate (cross-fitted) | 0.1222 | 0.3951 | 0.7320 | 0.0032 |

Clustered Brier difference (candidate − incumbent): -0.00035 (95% CI [-0.00056, -0.00014]) — a small, significant improvement; log loss and AUC move well within the C5 tolerances. Dev tail gaps: p_cal ≥ 0.25 -0.3pp, p_cal ≥ 0.30 -0.2pp vs incumbent p ≥ 0.40 -4.1pp. Residual note: the extreme top of the calibrated range (p_cal ≥ 0.40) still overpredicts on dev (-3.3pp).

## 6. Candidate evaluation (criteria v3)

### 2025 — PREVIOUSLY INSPECTED HOLDOUT — informed model-development decisions; not an untouched final test set (Decision 2C).

| Model | Brier | Log loss | AUC | Decile-ECE |
| --- | --- | --- | --- | --- |
| Incumbent | 0.1218 | 0.3928 | 0.7287 | 0.0168 |
| Candidate | 0.1215 | 0.3915 | 0.7282 | 0.0054 |

| Check | Slice | n | Mean predicted | Observed | Gap | 95% CI | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C2 top decile | — | 5,161 | 0.389 | 0.372 | -1.7pp | [-3.0pp, -0.2pp] | **PASS** |
| C3 p_cal >= 0.25 | — | 11,513 | 0.334 | 0.323 | -1.1pp | [-2.0pp, -0.2pp] | **PASS** |
| C3 p_cal >= 0.30 | — | 6,905 | 0.371 | 0.354 | -1.7pp | [-2.9pp, -0.4pp] | **PASS** |
| C3 p_cal >= 0.35 (secondary) | — | 3,158 | 0.420 | 0.405 | -1.5pp | [-3.2pp, +0.0pp] | **PASS** |
| C3 p_cal >= 0.40 (secondary) | — | 2,325 | 0.439 | 0.422 | -1.7pp | [-3.8pp, +0.3pp] | **PASS** |
| anchor: p_inc >= 0.30 rows, candidate p_cal vs obs | — | 5,258 | 0.387 | 0.370 | -1.8pp | [-3.0pp, -0.3pp] | **PASS** |
| anchor: p_inc >= 0.30 rows, incumbent p vs obs (reference) | — | 5,258 | 0.396 | 0.370 | -2.6pp | [-3.9pp, -1.2pp] | **PASS** |
| anchor: p_inc >= 0.40 rows, candidate p_cal vs obs | — | 1,979 | 0.441 | 0.434 | -0.7pp | [-2.9pp, +1.3pp] | **PASS** |

C5 (non-degradation): **PASS**. 
Prospective slices (position / game state / two-minute / half): the largest candidate gap magnitude is 1.3pp; the largest increase in absolute gap versus the incumbent is 1.1pp (slice `game_state/tied`).

### 2026 — GENUINELY UNSEEN — no development decision in this rebuild has used 2026 data; weeks 1-7.

| Model | Brier | Log loss | AUC | Decile-ECE |
| --- | --- | --- | --- | --- |
| Incumbent | 0.1154 | 0.3760 | 0.7388 | 0.0175 |
| Candidate | 0.1150 | 0.3739 | 0.7383 | 0.0044 |

| Check | Slice | n | Mean predicted | Observed | Gap | 95% CI | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C2 top decile | — | 2,382 | 0.372 | 0.369 | -0.2pp | [-2.4pp, +1.7pp] | **PASS** |
| C3 p_cal >= 0.25 | — | 4,064 | 0.333 | 0.333 | +0.0pp | [-1.5pp, +1.5pp] | **PASS** |
| C3 p_cal >= 0.30 | — | 2,382 | 0.372 | 0.369 | -0.2pp | [-2.4pp, +1.7pp] | **PASS** |
| C3 p_cal >= 0.35 (secondary) | — | 1,101 | 0.421 | 0.423 | +0.2pp | [-2.4pp, +3.1pp] | **PASS** |
| C3 p_cal >= 0.40 (secondary) | — | 809 | 0.440 | 0.426 | -1.3pp | [-4.6pp, +2.1pp] | **PASS** |
| anchor: p_inc >= 0.30 rows, candidate p_cal vs obs | — | 1,808 | 0.388 | 0.385 | -0.3pp | [-2.7pp, +2.0pp] | **PASS** |
| anchor: p_inc >= 0.30 rows, incumbent p vs obs (reference) | — | 1,808 | 0.399 | 0.385 | -1.4pp | [-3.8pp, +1.0pp] | **PASS** |
| anchor: p_inc >= 0.40 rows, candidate p_cal vs obs | — | 689 | 0.443 | 0.424 | -1.9pp | [-5.5pp, +1.6pp] | **FAIL** |

C5 (non-degradation): **PASS**. 
Prospective slices (position / game state / two-minute / half): the largest candidate gap magnitude is 1.1pp; the largest increase in absolute gap versus the incumbent is 1.0pp (slice `game_state/tied`).

Reported against the results: on 2026, the extra reporting anchor "p_inc ≥ 0.40 rows, candidate p_cal vs obs" misses the ±5pp CI-containment rule (point gap −1.9pp; CI [−5.5pp, +1.6pp]) — an uncertainty-width miss at the extreme top on a 689-row subset, not a bias miss. It is not a frozen primary criterion but is disclosed here because it sits exactly where the engine's highest-confidence alerts would live.

## 7. EV reliability gate — HYPOTHETICAL (simulated prices)

**The historical corpus contains no genuine contemporaneous market quotes.** Quotes are synthetic, constructed exactly as frozen in criteria v3 (C8) before candidate evaluation: reference = calibrated probability of the same player computed from the previous team drive's feature row (lag-1); quote implied probability = reference × (1 + vig); executed odds additionally degraded by slippage. Baseline: vig 6%, latency 1 drive, slippage 2%. EV bands are evaluated within the alert region (model probability ≥ 0.25). **Nothing here can establish executable betting profitability**, and no live adapter is enabled.

### 2025 — previously inspected holdout (baseline scenario)

| Model | Band | n | Mean pred P | Realized freq | Mean pred EV | Median pred EV | Mean realized return | 95% CI (return) | Median odds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| incumbent | EV >= 0% | 2,322 | 0.426 | 0.384 | +1.419 | +0.117 | +1.138 | [+0.700, +1.608] | 2.7 |
| incumbent | EV >= 3% | 1,956 | 0.432 | 0.390 | +1.682 | +0.142 | +1.363 | [+0.884, +1.889] | 2.8 |
| incumbent | EV >= 5% | 1,736 | 0.435 | 0.393 | +1.890 | +0.156 | +1.545 | [+1.023, +2.135] | 2.8 |
| incumbent | EV >= 8% | 1,462 | 0.440 | 0.399 | +2.233 | +0.185 | +1.848 | [+1.207, +2.553] | 2.8 |
| candidate | EV >= 0% | 3,393 | 0.329 | 0.309 | +1.452 | +0.092 | +1.208 | [+0.852, +1.595] | 3.4 |
| candidate | EV >= 3% | 2,291 | 0.341 | 0.313 | +2.145 | +0.183 | +1.787 | [+1.281, +2.369] | 3.4 |
| candidate | EV >= 5% | 2,191 | 0.340 | 0.310 | +2.241 | +0.187 | +1.862 | [+1.331, +2.456] | 3.4 |
| candidate | EV >= 8% | 1,990 | 0.335 | 0.308 | +2.460 | +0.191 | +2.058 | [+1.481, +2.712] | 3.8 |

C4 (candidate, probability component): EV >= 0% **PASS**, EV >= 3% **PASS**, EV >= 5% **FAIL**, EV >= 8% **PASS**

### 2026 — genuinely unseen prospective (weeks 1-7) (baseline scenario)

| Model | Band | n | Mean pred P | Realized freq | Mean pred EV | Median pred EV | Mean realized return | 95% CI (return) | Median odds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| incumbent | EV >= 0% | 826 | 0.427 | 0.400 | +1.318 | +0.118 | +0.995 | [+0.446, +1.681] | 2.7 |
| incumbent | EV >= 3% | 666 | 0.436 | 0.405 | +1.631 | +0.155 | +1.236 | [+0.523, +2.043] | 2.8 |
| incumbent | EV >= 5% | 592 | 0.441 | 0.410 | +1.830 | +0.175 | +1.394 | [+0.579, +2.331] | 2.8 |
| incumbent | EV >= 8% | 502 | 0.445 | 0.408 | +2.146 | +0.197 | +1.626 | [+0.661, +2.697] | 2.8 |
| candidate | EV >= 0% | 1,301 | 0.325 | 0.313 | +1.188 | +0.088 | +0.947 | [+0.491, +1.465] | 3.4 |
| candidate | EV >= 3% | 836 | 0.337 | 0.330 | +1.842 | +0.178 | +1.507 | [+0.798, +2.307] | 3.4 |
| candidate | EV >= 5% | 803 | 0.337 | 0.335 | +1.916 | +0.183 | +1.584 | [+0.844, +2.411] | 3.7 |
| candidate | EV >= 8% | 716 | 0.330 | 0.325 | +2.141 | +0.188 | +1.760 | [+0.927, +2.698] | 3.8 |

C4 (candidate, probability component): EV >= 0% **PASS**, EV >= 3% **PASS**, EV >= 5% **PASS**, EV >= 8% **PASS**

### Sensitivity (full grid in `artifacts/ev_gate_sensitivity_<season>.csv`)

Three findings drive the economic verdict:

1. **Fresh quotes (latency 0): the calibrated model finds zero positive-EV alerts** in every vig/slippage configuration — as it should against an equally-calibrated, fresh market. The incumbent still generates 193–778 alerts per season (vig 3–10%) claiming +12%–+17% EV, but realized returns are approximately zero on 2025 (+2.5% at vig 0.03, +0.4% at vig 0.06, -1.8% at vig 0.1) and **negative on 2026** (-3.8% at vig 0.03, -4.4% at vig 0.06, -5.1% at vig 0.1). These are the false edges manufactured by tail miscalibration, measured directly.
2. **Stale quotes (latency ≥ 1 drive): large positive realized returns exist for both models** — but by construction of the simulation (the reference is deliberately less informed). Even there, claimed EV overstates realized return by roughly 15–25% in mean terms, and the candidate's probability gap inside the EV ≥ 5% band on 2025 is 3.05pp (the C4 failure).
3. **Frozen pre-game quotes produce almost no qualifying alerts** (n ≤ 37 in every configuration): under fully stale pricing the engine's universe collapses; slippage and vig shrink alert volume but do not change the qualitative picture.

## 8. Verdict (criteria v3, rule C9 — fail-closed)

| Component | Decision |
| --- | --- |
| Offline logistic baseline | Retain (frozen; 2023 training season) |
| Isotonic tail recalibration (2024 dev only) | Retain as RESEARCH candidate |
| Mixture models M2/M3 | Not promoted (unchanged) |
| Criteria v2 research results | Accept as reported (incumbent beats all three baselines out-of-sample) |
| Criteria v3 outcome | 2025: C1_sample_adequacy=PASS, C2_top_decile=PASS, C3_alert_regions=PASS, C3_incumbent_operating_point=PASS, C4_ev_band_probability=FAIL, C5_global_non_degradation=PASS; 2026: C1_sample_adequacy=PASS, C2_top_decile=PASS, C3_alert_regions=PASS, C3_incumbent_operating_point=PASS, C4_ev_band_probability=PASS, C5_global_non_degradation=PASS |
| Candidate status | **RESEARCH_ONLY** (C4 fails on the EV ≥ 5% band of the 2025 previously-inspected holdout: probability gap 3.05pp vs the 3.0pp threshold) |
| CALIBRATED production label | **BLOCKED** (human sign-off deferred) |
| Real-book model coverage | NO_COVERAGE |
| Live sportsbook adapters | Disabled |
| HUMAN_REVIEW.md | Present, UNSIGNED, status DEFERRED |

## 9. Answer to the key acceptance question

> When PropStein identifies a high-confidence opportunity, is the estimated advantage still credible after calibration uncertainty, market-price quality, and latency are accounted for?

**Not yet — the model remains research-only.** What is now supported:

- **Probability calibration: credible.** After isotonic recalibration, alert-region probability gaps are ≤ 1.7pp with clustered CIs inside ±5pp on both the previously-inspected holdout and the genuinely-unseen 2026 slice.
- **Economics: not established.** Against fresh, efficient quotes the calibrated model correctly finds no edge; the incumbent's remaining edges do not realize (≈ 0% on 2025, negative on 2026). Against stale quotes, apparent edges exist but overstate realized returns, and one EV-band probability check fails on the holdout. Genuine contemporaneous quote data is required before any executable-advantage claim; simulated-price analysis is inherently hypothetical.

Consequences: NO_COVERAGE stands for real books, adapters stay disabled, and the next evidentiary step is a licensed historical quote feed (or an observability-only live quote capture, strictly read-only) to replace the synthetic reference.

## 10. Limitations

- Rebuild, not continuation: see §0. All numbers are fresh; prior-environment figures were not used as inputs.
- Universe coverage: ~28–30% of receptions fall outside the causal player universe (bench players without prior-game usage).
- Participation is unobservable in play-by-play and was not imputed; features use recorded usage only.
- 2026 is weeks 1–7 (107 games): the unseen slice is smaller and its CIs are correspondingly wider.
- Isotonic output is capped near 0.50 by dev-season data; probabilities above 0.50 are structurally unreachable until more extreme dev data exists.
- The EV gate's quote model is synthetic; its parameters were frozen before evaluation but remain assumptions, not measurements of any real book.
- Baselines B1–B3 are simple by design; stronger baselines (e.g., gradient boosted trees) were out of scope for Decision 2C.

## 11. Artifact preservation manifest

| File | SHA-256 (first 16) |
| --- | --- |
| `artifacts/candidate_evaluation.json` | `66df18ada277ae3f` |
| `artifacts/candidate_predictions_2023.csv.gz` | `3cfe497d3382efe1` |
| `artifacts/candidate_predictions_2024.csv.gz` | `814a29250133e644` |
| `artifacts/candidate_predictions_2025.csv.gz` | `6b92edf602be8baa` |
| `artifacts/candidate_predictions_2026.csv.gz` | `182cb9ff9dbfb377` |
| `artifacts/corpus_stats.json` | `e01f1f2b35f82da9` |
| `artifacts/criteria_v3.json` | `27f5513b7bb53f78` |
| `artifacts/dev_comparison.json` | `c06a62800cf537e9` |
| `artifacts/ev_gate_2025.json` | `98352936ff2e5e0e` |
| `artifacts/ev_gate_2026.json` | `efe7a8edcb012534` |
| `artifacts/ev_gate_sensitivity_2025.csv` | `86cf846058c67fb5` |
| `artifacts/ev_gate_sensitivity_2026.csv` | `00ae1ebbca6067eb` |
| `artifacts/incumbent_evaluation.json` | `d25925f91c093b61` |
| `artifacts/incumbent_model.json` | `9bf7f7a767d78a5d` |
| `artifacts/incumbent_predictions_2023.csv.gz` | `b1577544e89aca3b` |
| `artifacts/incumbent_predictions_2024.csv.gz` | `71e8725e1d44843d` |
| `artifacts/incumbent_predictions_2025.csv.gz` | `d72d8122c43582ce` |
| `artifacts/incumbent_predictions_2026.csv.gz` | `0d5751a96bd20501` |
| `artifacts/incumbent_reliability_2023.csv` | `36c5212178ea0d2c` |
| `artifacts/incumbent_reliability_2024.csv` | `eca6998e200fe391` |
| `artifacts/incumbent_reliability_2025.csv` | `f306f021094db594` |
| `artifacts/incumbent_reliability_2026.csv` | `3ea6e92eda3bb8d8` |
| `artifacts/isotonic_calibrator.json` | `6e6174616d3fd11a` |
| `artifacts/provenance_manifest.json` | `72c965e782fa55d1` |
| `artifacts/tail_recalibration_report.json` | `9edf733f51d8435c` |

Original incumbent predictions and candidate predictions are preserved row-level in `artifacts/incumbent_predictions_<season>.csv.gz` and `artifacts/candidate_predictions_<season>.csv.gz`; the isotonic mapping (knots) is fully specified in `artifacts/isotonic_calibrator.json`; the frozen model's coefficients and scaler statistics are in `artifacts/incumbent_model.json`. Raw data is reproducible via `research/00_download_data.py` (provenance manifest with per-file hashes).
