# vendor_trial_2dv/ — Decision 2D-V Vendor Trial (The Odds API)

**Status: HARNESS PATCHED 2026-10-30 (owner code inspection) — NOT YET
EXECUTED against the vendor.** Two material defects found by the project
owner were fixed and tested (see `PATCH_LOG_2026-10-30.md`): historical
event discovery now requires a verified event-ID mapping (source and
timestamp recorded per entry), and actual credit consumption is measured
from the vendor's usage headers on every request (baseline, discovery,
retries, quote pulls) with fail-closed aborts. Selftest: 14/14 PASS. Zero
vendor requests have been made; zero credits consumed; no API key exists
in this environment. **Paid acquisition remains BLOCKED until V8 written
commercial permission is attached.**

Decision 2D review (project owner, 2026-10-30):

| Decision | Status |
| --- | --- |
| Confirm The Odds API (primary) | YES |
| Confirm SportsDataIO (secondary) | YES |
| Begin trial verification | AUTHORIZED |
| Purchase full historical dataset | PENDING TRIAL |
| Change C4 threshold | NO |
| Refit incumbent or calibrator | NO |
| Enable production adapters | NO |
| Promote model | NO — RESEARCH_ONLY |

The trial's purpose is **data quality and infrastructure validation**, not
profitability: per the authorizing decision, trial observations must not be
used to revise the frozen model or select a more favorable EV threshold
(`PRECOMMITMENT.md` P3/P4; enforced by `quarantine_guard.py`).

## Components

| File | Role |
| --- | --- |
| `PRECOMMITMENT.md` | frozen sample rule, config, safeguards, acceptance rule |
| `PATCH_LOG_2026-10-30.md` | owner-ordered patch record: the two defects, root causes, fixes, test evidence |
| `trial_config.json` | single source of trial parameters (incl. credit cap 600, discovery policy, documented costs, retry policy) |
| `select_sample.py` | deterministic stratified sample → `artifacts/sample_manifest.json` (REAL schedule; done) |
| `discover_event_ids.py` | Stage A: build the VERIFIED event-ID mapping (candidates verified against the schedule, or owner attestation); records discovery source + timestamp per entry |
| `artifacts/event_id_map.json` | REQUIRED acquisition input: verified historical event IDs with provenance (ships as UNVERIFIED template until Stage A runs) |
| `credit_meter.py` | documented 10-credit rule (owner's 240 / 11,760 / 15,680 arithmetic) + `Meter`: header-based actual-consumption tracking (x-requests-used/-remaining/-last), fail-closed |
| `fetch_trial_quotes.py` | Stage B acquisition: event-ID-map gated, metered end-to-end, budget-guarded; REAL mode (env key only) + `--dry-run` harness mode; SHA-256 manifest; redacted URLs |
| `verify_v1_v10.py` | checks V1–V10 → `evidence/` JSONs + `TRIAL_REPORT.md` (V3 verifies event-map provenance; V9 reconciles header-measured consumption) |
| `quarantine_guard.py` | G1 refit lock, G2 sample freeze, G3 confinement, G4 code baseline |
| `make_fixtures.py` | synthetic fixtures (clean + 9 injected faults F1–F9) |
| `selftest.py` | end-to-end harness proof, 14 tests (no network, no credits) |
| `ATTACHMENT_V8_COMMERCIAL_RIGHTS.md` | MANUAL evidence slot for written permission |
| `code_baseline.json` | committed hash baseline of governing code |

## Execution protocol (real trial)

```bash
# 0) prerequisites — on the project owner's machine
#    - The Odds API paid account (historical access) with credits available
#    - confirm the exact market key for NFL receiving-yards props against the
#      vendor's market catalogue; edit trial_config.json market_candidates if
#      it differs (do this BEFORE the run; it is a config fix, not a protocol
#      change)
export ODDS_API_KEY=...        # env var ONLY — never in chat, args, or files

cd research/drive-rec-v2/vendor_trial_2dv
python3 quarantine_guard.py            # must print guards_hold: true
python3 selftest.py                    # re-prove the harness locally (14 tests)

# 1) STAGE A — discovery: build the verified event-ID mapping (REQUIRED
#    before acquisition; the current-events endpoint does not serve
#    completed games). Supply candidate event IDs from owner records /
#    captured snapshots / vendor support:
python3 discover_event_ids.py --candidates candidates.json --out raw_discovery
#    ...or attest them (owner authority, recorded as such):
python3 discover_event_ids.py --candidates candidates.json \
    --attest --attest-note "source: <where the IDs came from>"
#    Review raw_discovery/candidates_map.json, promote verified/attested
#    entries into artifacts/event_id_map.json, commit the map.

# 2) STAGE B — acquisition (refuses to run without the verified map):
python3 fetch_trial_quotes.py          # REAL pull: 8 games x 3 obs = 240 credits
                                       # (+ baseline/discovery/retries, all
                                       # metered from usage headers; cap 600)
python3 verify_v1_v10.py --data-dir raw --stats auto \
    --sample-manifest artifacts/sample_manifest.json --out evidence

# 3) fill ATTACHMENT_V8_COMMERCIAL_RIGHTS.md with the vendor's WRITTEN
#    permission (storage + analysis + display), then re-run:
python3 verify_v1_v10.py --data-dir raw --stats auto \
    --sample-manifest artifacts/sample_manifest.json --out evidence
python3 quarantine_guard.py            # post-run safeguards
```

Deliverable for **Decision 2D-V — Vendor Trial Acceptance**: the generated
`evidence/TRIAL_REPORT.md` (verified sample, coverage & missingness report,
actual API consumption, explicit pass/fail recommendation) plus the attached
V8 permission. Only after PASS does the full 392-game acquisition proceed
(separate purchase authorization; projected 11,760 credits at three
observation times, 15,680 at four snapshots).

## Acceptance rule

Any critical failure (V1–V7, V9, V10 = FAIL) blocks the full acquisition
until resolved. V8 is manual: until written permission is attached, the
verdict is BLOCKED_PENDING_MANUAL — which also blocks acquisition.

## Safety properties (tested)

- **Credential safety:** the key is read only from `ODDS_API_KEY`; URLs are
  redacted before storage; REAL mode refuses to run without the env var
  (selftest T8). Raw acquisition output is git-ignored
  (`proposed_gitignore_addition.txt`) so vendor responses are never
  redistributed through the repository.
- **Spend safety:** MEASURED consumption (vendor usage headers:
  `x-requests-used` cumulative delta, cross-checked against
  `x-requests-last` and the remaining delta) plus the modeled cost of the
  NEXT request — baseline, discovery, and every retry attempt included — is
  checked against the 600-credit cap before every request and again after
  every response; the run aborts PARTIAL rather than exceeding it, and
  fails closed whenever consumption cannot be established (selftest T9,
  T10).
- **Discovery integrity:** acquisition requires a verified event-ID map
  whose entries record their discovery source and timestamp; the map used
  is hash-preserved in the run directory and audited by V3; acquisition
  refuses to run without it (selftest T11).
- **Fail-closed ingestion:** dry-run/synthetic output carries
  `synthetic=true` into the canonical preview, which
  `decision_2d.quotes.validate_quotes` REFUSES (selftest T6) — harness
  fixtures can never masquerade as licensed quotes in the pilot.
- **Sensitivity:** nine injected fixture faults (F1–F9) are each caught by
  their target check (selftest T3/T3b/T3c/T3d); a flipped byte in a raw
  response fails V10 (T4); re-running the verifier is byte-identical (T5).

## Open items before the real run (honest list)

0. **Event IDs for the 2025-season sample** (defect-1 follow-through): the
   vendor serves completed games' event IDs only within 3 days of
   completion (`/scores daysFrom`), so the eight precommitted games' IDs
   must come from owner records, a vendor export, vendor support, or owner
   attestation — `discover_event_ids.py` records whichever source is used.
   For future acquisitions, capture IDs while games are upcoming.
1. **Exact market key** for NFL player receiving yards must be confirmed
   against the vendor's market catalogue (config `market_candidates`).
2. **Team-name mapping** (`fetch_trial_quotes.py TEAM_NAMES`) is written from
   nflverse abbreviations to full team names; if the vendor returns different
   strings, discovery misses are LEDGERED and reported by V1/V3 — they are
   measured, not silently dropped.
3. **kickoff_utc precision**: the trial uses the vendor's `commence_time`
   (UTC) for observation times and V3 cross-checks it against the schedule
   gameday; for the full pilot, minute-precision kickoff (stadium timezone
   mapping) should be validated — the T−15m sensitivity tier is the one
   affected by imprecision.
4. **V8 written permission** must be obtained from the vendor before the
   trial can reach PASS.
