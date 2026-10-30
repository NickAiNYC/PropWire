# PRECOMMITMENT.md — Decision 2D-V Trial, frozen before any vendor request

Recorded 2026-10-30, immediately after the project owner's Decision 2D review
authorized trial verification (vendors confirmed; purchase PENDING TRIAL).
Everything below was fixed BEFORE any vendor API request was made. Changing
any item after quote data has been observed voidates the trial.

## P1. Sample selection (frozen)

- Rule: seeded stratified sample — 4 games from the 2025 season (week bins
  1-6, 7-12, 13-18, 19-22 incl. postseason) + 4 games from 2026 weeks 1-7
  (bins 1-2, 3-4, 5-6, 7-7); one game per bin drawn by
  `numpy.random.default_rng(int(sha256("DECISION_2DV_TRIAL_SAMPLE_SEED_v1")[:16], 16))`.
- Selection input: schedule metadata ONLY (`data/games.csv`, nflverse,
  CC BY 4.0). No odds, quotes, lines, or outcomes consulted.
- Selected games (see `artifacts/sample_manifest.json`):
  2025_06_ARI_IND, 2025_08_NYJ_CIN, 2025_13_CIN_BAL, 2025_19_HOU_PIT,
  2026_01_WAS_PHI, 2026_03_LAC_BUF, 2026_05_PHI_JAX, 2026_07_DEN_ARI.
- Manifest integrity: `artifacts/sample_manifest.json`
  sha256 `c234b505491a49a265b82574616026e693821e33714a90f5e370e9e7f560f8e2`
  (verified by `quarantine_guard.py` guard G2).
- Representativeness requirements from the authorizing decision — both
  seasons, multiple sportsbooks, examples of missing/changing lines — are
  MET BY DESIGN (all books in the region response are captured; line changes
  and pulled lines are recorded by V6 across the three observation times),
  not by post-hoc selection.

## P2. Acquisition configuration (frozen)

- Vendor: The Odds API (primary). Sport/market keys resolved empirically at
  first request from the pre-declared candidate lists in `trial_config.json`
  (`playerprops_nfl` / `americanfootball_nfl`;
  `player_receiving_yards`); any change is recorded in the run manifest.
- Observation times: T−180m, T−60m (primary), T−15m before kickoff.
- Region: `us` (single region, single market family). Odds format: American.
- Credit budget cap: **600 credits** for the whole trial (modeled quote pulls:
  8 games × 3 times × 10 = 240; discovery and retries metered from vendor
  headers; fail-closed abort before exceeding the cap).
- Full-acquisition projections (owner-reconciled 2026-10-30): 392 games × 3
  observation times × 10 = **11,760**; 392 × 4 snapshots (incl. closing) × 10
  = **15,680**.

## P3. Model and threshold freeze (binding on the trial)

- The incumbent, the isotonic candidate, criteria v3, and the corpus are
  FROZEN per `artifacts/decision_2d_contract.json` (SHA-256 enforced by the
  refit lock; `quarantine_guard.py` G1 re-verifies).
- **No refit, re-tune, or re-freeze of any model, calibrator, transformation
  parameter, threshold, or quote-scenario constant during the trial.**
- **The trial must NOT be used to select a more favorable EV threshold.**
  The alert thresholds in the contract (EV ≥ 5% primary; 3%/8% report-only)
  are read-only during the trial.

## P4. Use of trial observations (the experimental safeguard)

- The trial validates DATA QUALITY AND INFRASTRUCTURE only.
- Any profitability assessment computed on the 8 trial games must carry the
  label **EXPLORATORY-TRIAL** and is not evidence for Decision 2D gates.
- The full-pilot evaluation set remains the 392-game acquisition; the primary
  analysis may include the 8 trial games (they are part of the 392), and a
  sensitivity analysis excluding them is reported so the evaluation cannot
  be dominated by twice-observed games. 2025 rows remain labeled
  "previously inspected holdout"; 2026 weeks 1-7 remain "unseen at model
  freeze" per the contract's interpretation notes.
- Trial raw data is quarantined under `vendor_trial_2dv/` (guard G3); nothing
  is written into `decision_2d/`, `artifacts/` (frozen set), or model paths.

## P5. Acceptance rule (from the authorizing decision)

- Checks V1–V10 as specified: V1 availability, V2 timestamp integrity,
  V3 market identification, V4 sportsbook identity, V5 price integrity,
  V6 missingness, V7 settlement, V8 commercial rights (MANUAL), V9 cost,
  V10 reproducibility.
- **Any critical failure blocks the full acquisition until resolved.**
- V8 (written permission for storage, analysis, and display) is manual
  evidence: until attached, the trial verdict is BLOCKED_PENDING_MANUAL,
  which also blocks acquisition. No automated substitute is accepted.

## P6. State at precommitment

- Zero vendor requests made; zero credits consumed; no API key exists in
  this development environment (keys are supplied only via the
  `ODDS_API_KEY` environment variable at execution time, never in chat,
  arguments, or committed files).
- The harness has been validated ONLY on synthetic fixtures
  (`make_fixtures.py`), which are labeled SYNTHETIC-HARNESS-TEST at every
  layer and refused by the canonical quote store (fail-closed).
