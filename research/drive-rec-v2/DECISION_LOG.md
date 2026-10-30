# DECISION_LOG.md — PropStein Live Sniper research drive (drive-rec-v2)

Chronological record of governance decisions binding this research drive. This file
records decisions and their evidentiary basis; it does not grant promotion. All
model status remains **RESEARCH_ONLY**.

---

## Decision 2C review outcome (recorded 2026-10-30, from the project owner's review)

**Verdict: Decision 2C accepted as research evidence, NOT accepted for promotion.
Maintain RESEARCH_ONLY. Do not promote the calibrated model, do not relax C4, do
not enable production betting alerts.**

The controlling distinction: *the probability model appears better calibrated, but
there is still no demonstrated executable betting edge.* That distinction governs
this development cycle.

### C4 threshold decision

- `C4_MAX_GAP_PP` **stays 3.0**. The threshold is not widened to 3.1pp to
  accommodate the observed result.
- Exact recorded result (2025 previously-inspected holdout, candidate, simulated
  EV ≥ 5% band): **n = 2,191 rows across 272 games; mean predicted 0.3404;
  realized 0.3099; gap = observed − predicted = −3.0499pp** against the 3.0pp
  threshold (margin of failure: 0.0499pp). Realized-frequency 95% CI:
  [0.2903, 0.3301]. Source: `artifacts/ev_gate_2025.json`
  (`baseline.candidate.ev_bands["EV >= 5%"]`).
- Changing a precommitted threshold after observing the candidate would
  compromise the evaluation protocol; the miss is recorded as a FAIL, not rounded
  into a pass.
- The candidate (frozen logistic incumbent + isotonic recalibration on 2024 dev)
  is **preserved as a research artifact**: model SHA-256
  `9bf7f7a767d78a5d…` (incumbent_model.json), calibrator SHA-256
  `6e6174616d3fd11a…` (isotonic_calibrator.json), full row-level predictions in
  `artifacts/candidate_predictions_<season>.csv.gz`.
- The **next** candidate must pass the unchanged criterion on genuinely
  prospective observations.

### EV ≥ 5% selection-mechanism investigation (ordered by the review; executed in `10_selection_amplification.py`)

The review ordered: *"Investigate how much of the deviation comes from the EV ≥ 5%
selection mechanism, which may amplify calibration and pricing errors,"* and
*"distinguish unconditional calibration from calibration conditional on a
model-derived betting opportunity. Passing decile-ECE does not establish
calibration within the subset selected by an EV threshold."*

Findings (HYPOTHETICAL — simulated quotes per frozen criteria v3 C8; quote
construction imported from script 08 so the C4 figure reproduces exactly):

| Season | Model | Unconditional gap (alert region p ≥ 0.25) | Gap conditional on EV ≥ 5% | Composition part | Selection-mechanism part |
| --- | --- | --- | --- | --- | --- |
| 2024 dev | candidate | +0.00pp | −0.71pp (n=2,229) | +0.00pp | −0.71pp |
| 2024 dev | incumbent | +1.00pp | −4.02pp (n=1,543) | −1.00pp | −4.01pp |
| 2025 holdout | candidate | −1.13pp | **−3.05pp (n=2,191)** | +1.12pp | **−3.04pp** |
| 2025 holdout | incumbent | −0.44pp | −4.14pp (n=1,736) | +0.39pp | −4.09pp |
| 2026 unseen | candidate | +0.03pp | −0.16pp (n=803) | −0.03pp | −0.16pp |
| 2026 unseen | incumbent | +0.81pp | −3.01pp (n=592) | −0.89pp | −2.93pp |

Interpretation (mechanism, not composition):

1. **The selection mechanism, not probability composition, produces essentially
   the entire conditional miss.** Re-weighting non-selected alert-region rows to
   the selected set's probability distribution (matched-probability control)
   accounts for ~0pp; the residual attributable to selection itself is
   −3.04pp on 2025 (candidate) and −4.09pp (incumbent).
2. **The EV filter selects claimed information gain, and claimed gains
   overstate realized gains precisely in their upper tail.** Within EV ≥ 5% on
   2025: the candidate exceeds its stale self-reference by +9.7pp on average
   (mean p − ref), but reality exceeds that reference by only +6.6pp (mean y −
   ref); the incumbent claims +11.2pp vs +7.1pp realized. The gap between
   claimed and realized information gain *is* the C4 failure.
3. The row-level correlation between (p − ref) and (y − p) is ≈ 0
   (−0.05…+0.01), so this is not simple error-chasing; it is regression to the
   mean of the model's incremental information. Selection on the upper tail of a
   noisy gain estimator concentrates rows where the gain was overstated.
4. The isotonic recalibration **shrinks but does not eliminate** the
   amplification (2025: −3.04pp vs incumbent's −4.09pp); on the 2026 unseen
   slice the candidate's amplification collapses to −0.16pp (hence the C4 pass
   there) while the incumbent's persists at −2.93pp.
5. Confirmation of the review's methodological point: the candidate's 2025
   decile-ECE of 0.0054 coexists with a −3.05pp gap inside the EV ≥ 5% selected
   subset. **Decile-ECE (unconditional) does not establish calibration
   conditional on selection.** Any future criterion must include
   selection-conditional checks — carried into the Decision 2D contract as gate
   E2.

Consequence for Decision 2D: the economic pilot's precommitted gates evaluate
calibration **inside the selected (alert) subset**, not merely globally.

### Zero-fresh-quote-alerts ambiguity (recorded, unresolved)

The calibrated model producing **zero** positive-EV alerts against fresh
simulated quotes must not be read as proof of optimal behavior. Three
explanations remain live and only genuine, timestamped market quotes and
prospective outcomes can distinguish them:

1. correct rejection of false positives (the desired reading);
2. an overly conservative model (missed true edges);
3. insufficient signal sensitivity (edges exist but the alert rule cannot see
   them).

### Incumbent EV-vs-realized discrepancy (recorded as the commercially significant finding)

The incumbent generated hundreds of supposed opportunities with 12–17% estimated
EV (fresh-quote scenarios: 193–778 alerts per season depending on vig), yet
realized returns were ≈ 0% on 2025 (+2.5% at vig 3%, +0.4% at vig 6%, −1.8% at
vig 10%) and **negative on 2026** (−3.8%, −4.4%, −5.1%). Apparent EV of this
kind can make a betting analytics product look impressive before it has
demonstrated economic value.

---

## Decision 2D authorization (recorded 2026-10-30, from the project owner's review)

**Authorized: a narrow historical-quote validation pilot, executed under a
precommitted contract. Model refitting is prohibited during the pilot. The 3.0pp
C4 threshold is unchanged. A prospective, precommitted economic validation is
required before enabling any production alert.**

The objective is **not** to generate more impressive EV estimates. It is to
establish whether the calibrated probabilities identify positive expected value
**at prices a customer could actually obtain**.

Binding artifacts produced under this authorization:

| Artifact | Role |
| --- | --- |
| `artifacts/decision_2d_contract.json` | precommitted execution contract (frozen hashes, gates E1–E6, fail-closed promotion rule) |
| `docs/DECISION_2D_CONTRACT.md` | human-readable contract (mirrors the JSON) |
| `docs/HISTORICAL_QUOTE_VENDOR_EVALUATION.md` | vendor evaluation + pre-purchase verification checklist + pilot scope/cost estimate |
| `decision_2d/` (package) | pilot harness: quote store, point-in-time join, settlement, metrics, availability ledger, leakage guards, run_pilot orchestrator |
| `tests/test_decision_2d.py` | synthetic-fixture tests (code correctness only; no results claims) |
| `11_freeze_decision_2d_contract.py` | script that froze the contract with computed hashes BEFORE any quote acquisition |

### Status after this cycle

| Component | Status |
| --- | --- |
| Calibrated (isotonic) candidate | RESEARCH_ONLY (preserved research artifact) |
| C4_MAX_GAP_PP | 3.0 (unchanged) |
| C4 result, 2025 EV ≥ 5% band | FAIL (−3.0499pp vs 3.0pp; recorded above) |
| Historical-quote pilot | AUTHORIZED, precommitted; **not started** (no licensed quotes purchased) |
| Live sportsbook adapters | Disabled (unchanged) |
| Real-book model coverage | NO_COVERAGE (unchanged) |
| CALIBRATED production label | Blocked (unchanged) |
| HUMAN_REVIEW.md | Present, UNSIGNED, DEFERRED (updated with Decision 2D review items) |
| Production betting alerts | Not enabled; require Phase B prospective validation + human approval |

---

## Rebuild and provenance control (recorded 2026-10-30)

Per the review's §5: the sandbox loss changes the evidentiary status of the
research; the new lineage is explicitly independent.

- The **six original DRIVE-REC-V1 local commits are UNRECOVERED** (never pushed;
  hashes unavailable in this environment) and are documented as unrecovered —
  never represented as restored.
- The rebuild lineage is the three patch commits (scaffold → corpus/incumbent/
  criteria → candidate evaluation) plus subsequent commits on this branch; see
  `artifacts/provenance_verification.json` and `PROVENANCE.md`.
- The rebuilt work is placed under `research/drive-rec-v2/` (this directory) so
  incorporation into the main repository cannot replace the main repo's root
  README or .gitignore.
- The delivered report is sufficient for strategic decisions but is **not** an
  independent code or artifact audit; the project owner has not inspected the
  ZIP, patches, row-level predictions, or Git history. `verify_provenance.py`
  exists so that audit can be executed mechanically.
