# PropWire Multi-Sport Architecture (Phase 2: NBA)

This document describes the sport-adapter architecture introduced in Phase 1
and completed for multi-sport operation in Phase 2, the NBA v1 data
contract (research fixtures + gated live ingest), and the exact checklist
for adding a sport or upgrading NBA to live data.

## 1. Sport adapter layer

Every sport is fully described by an adapter — viewer code never branches on
a hardcoded sport again.

```
viewer/js/sports/registry.js   registration + per-device boot sport
viewer/js/sports/nfl.js        NFL adapter (verbatim pre-adapter behavior,
                               proven byte-identical by test/nfl-parity.snapshot.mjs)
viewer/js/sports/nba.js        NBA adapter (v1: research fixtures)
viewer/app.js                  generic terminal; reads the active adapter
```

Load order (all `defer`, document order): registry → adapters → app.js.
All four HTML pages (`index`, `ledger`, `verify`, `audit`) load the same
chain before app.js.

### Adapter contract

Required by the registry: `id`, `label`, `periodNoun`, `markets`,
`defaultMarket`, `slates`. Consumers in app.js additionally use:

| Hook | Purpose |
|---|---|
| `model` | Distribution constants (NFL NegBin/Gamma). Adapters without a distribution model ship `null`; the only consumers guard on NFL-only row fields. |
| `markets.<id>` | `chipLabel`, `unit` family, `isYards`, `strongCeiling`, `breaker`, value hooks (`fair`, `projection`, `actual`, `settled*`), range hooks (`dist`, `prediction`, `mu`, `sd`), `fairProbText` |
| `marketOrder`, `positions` | Chip population |
| `intents` | Filter-sheet labels (ids `surge`/`volume`/`deep` are load-bearing) |
| `roleLabel`, `driverTag` | Role copy + driver badges |
| `intentFilters` | Surge/volume/deep row predicates |
| `topPlays` | `{ source: 'picks_file' \| 'ev_ranked' }`; `ev_ranked` also uses `hasCompleteInputs` |
| `sortDefault` | Non-EV default ordering (NFL: verbatim `proj_yards`) |
| `labels` | Ticker, bye/availability copy |
| `logo` | CDN base + per-team slug/tints |
| `storageKeys`, `legacyKeys` | Per-sport namespaces (ledger key is shared; entries carry `sport`) |
| `breakerFallback` | Config-fetch-failure resilience (must mirror the config block) |
| `correlationKey` | Must keep the `${team}::${market}` shape (dismissal lookups) |
| `detail` | Detail-modal copy + `scenarioCapable: false` to hide the NFL target-share simulator |
| `fixturesOnly`, `fixtureNotice`, `pageTitle` | v1 fixture sports |
| `defaultSlateKey` | Boot slate when the stored key is unknown to the sport |
| `etDateKey` | Eastern-calendar slate keying (NBA; DST-safe) |

### Sport switching

- The switcher is a segmented control directly below the header
  (`#sportSwitcher`, radiogroup semantics). It is deliberately NOT a
  bottom-sheet or swipe surface — swipe-to-log owns horizontal card swipes.
- Switching writes `propwire_active_sport` and reloads the page. Every page
  load is single-sport: no mid-session adapter swap, no cross-sport state
  bleed. Boot resolution validates the stored id against registered
  adapters and falls back to `nfl` on garbage/tamper/storage failure.
- Per-sport chrome (market chips, position chips, signal-sheet labels,
  slate selectors, page title) is populated by `renderSportChrome()` via
  `elById()`. Since the Phase 2 audit (item B2), the parity sandbox
  implements `getElementById` against the shipped page's ids, records every
  call, and CAPTURES chrome content in the goldens — the NFL parity
  statement is therefore:

  > **NFL parity, stated precisely (audit M12):** the NFL JS data path
  > (evaluations, projections, ledger entry shape, breaker values, detail
  > modal) is byte-identical to the pre-adapter build across 10 goldens;
  > the NFL user experience deliberately changes by the addition of the
  > sport switcher, market/position chrome, and the feed-health banner
  > (spec'd UX, captured in the goldens as an earned whitelist delta, and
  > pinned by the `dom_access_log` snapshot + allowlist assertion so no
  > unexpected element can be populated silently).

## 2. NBA v1 data contract (research fixtures)

Per the Phase 0.5 data-source gate, the only documented ToS-clean NBA
source is balldontlie; its box scores are paid-tier. v1 therefore ships
**research fixtures**: hand-authored synthetic feeds used to validate the
multi-sport UI, breaker plumbing, ledger provenance and Top-Play ranking.

| File | Shape | Provenance |
|---|---|---|
| `viewer/nba_slate_2026-10-22.json` | bare array, 25 rows (incl. one deliberate incomplete-input probe) | `_fixture: true` per row |
| `viewer/nba_games_2026-10-22.json` | bare array, 2 games, `tipoff_utc` + `gametime_et` | `_fixture: true` per game |
| `viewer/nba_odds_2026-10-22.json` | envelope, `feed_status: "fixture"`, 16 quotes with EV ranking + deterministic tie pairs | `_fixture: true` per quote + fixture notice |

Provenance rules (enforced by tests):

- Every fixture row/quote carries `_fixture: true`; quote sources say
  "not a sportsbook quote"; `verified` is always `false` — fixtures never
  claim verification, therefore never render as actionable.
- **Fixture naming policy (audit B1):** fixture players are anonymized
  (`Player A` … `Player X`, stable ids `fx-nba-player-a`…). Real athlete
  names are never combined with synthetic statistics in fixture data —
  that combination is a right-of-publicity liability in a commercial
  product and a scrape-adjacency trap where an LLM or scraper quoting the
  JSON could mistake fabricated numbers for real research. Teams and
  positions are kept (league context is needed to exercise the UI); the
  anonymous incomplete-input probe row keeps its descriptive name.
- Ledger entries logged against fixture quotes are stamped
  `data_provenance: "fixture"` (both entry-creation sites) so per-sport CLV
  stats can never blend synthetic data with live-book fills. NFL live
  entries carry NO such field — the ledger schema is byte-identical.
- The RESEARCH FIXTURES banner (`dataQualityBanner`) is always visible on a
  fixture slate and states what it means: "Sample data for demonstration —
  not actionable, not a research record. Synthetic values; not sportsbook
  quotes." (audit M15).
- Distinct from fixtures: the NFL feeds (`slate_2026_w*.json` etc.) carry
  REAL historical model data for real players — that is the product's
  research dataset, not synthetic fixtures, and is out of scope for the
  naming policy above.

### Breaker status

`circuit_breaker_config.json → sports.nba` carries `calibrated: false` and
`calibration: "uncalibrated_tuning_parameters"`. Drift bounds are
order-of-magnitude placeholders scaled to NBA stat variance and must never
copy NFL values (test-enforced). The uncalibrated flag is what the UI uses
to keep the research framing honest — concretely, every rendered NBA row
carries a visible `UNCALIBRATED` badge (table and cards), driven from the
same config flag (audit H9: a config flag without a visible badge is
cosmetic).

### Markets and the distribution choice (audit H8)

`points`, `rebounds`, `assists`, `threes` (3PM), `pra` — normal-approximation
ranges (`mu`/`sd` per row, documented uncalibrated fallback `sd = max(1, 0.35·mu)`).
Slate keys are **US Eastern calendar dates** (`etDateKey` handles DST via the
IANA tz database and cross-midnight PT tips via explicit test vectors;
mirrored in Python by `scripts/fetch_nba.py`).

The normal approximation is an inherited v1 scaffolding choice, not a
claim: it is defensible for points, wrong for 3PM (low mean, discrete,
right-skewed — a normal puts mass on negative counts), and ignores the
correlated-sum structure of PRA. **Known follow-up: 3PM and PRA require
discrete (negative-binomial / correlated-component) treatment in the Phase
4 calibration pass.** Recorded here so a future reviewer sees this was
inherited, not chosen silently.

## 3. Upgrading NBA to live data

```
BALLDONTLIE_API_KEY=... python3 scripts/fetch_nba.py --date 2026-10-22
```

- No key → exit 2, nothing fetched, nothing written; the viewer keeps the
  committed fixtures. The gate is fail-closed by design.
- Free tier (5 req/min, hard-capped by the script at 13s spacing) covers
  teams/players/games; box scores (`/v1/stats`) need ALL-STAR ($9.99/mo) or
  GOAT ($39.99/mo with odds/props). On a blocked tier the script writes the
  games feed (`_fixture: false`) and exits 3 with the tier requirement.
- Output: `nba_games_<date>.json` (bare array, viewer schema) +
  `nba_boxscore_<date>.json` (raw evidence), both stamped `_fixture: false`,
  `source: "balldontlie"`, `generated_at`.
- Scope: the script proves the pipeline and lands evidence; turning box
  scores into projections is a modeling pass. The fixture slate stays the
  viewer's NBA slate until that pass retires it.

Retirement checklist for fixtures: (1) real feeds committed for the slate
date; (2) modeling pass produces projections + fair lines; (3) adapter
`slates` entry points at real files; (4) `fixturesOnly: false` +
`pageTitle` updated; (5) fixture banner disappears automatically
(`feed_status` no longer `"fixture"`); (6) parity suite stays green.

## 4. Failure-mode UI (feed health)

`loadSlate` records transport status per critical feed into
`state.feedHealth`; `updateFeedHealthUI()` renders the
`dataQualityBanner`:

- `SLATE FEED OFFLINE` / `ODDS FEED OFFLINE` / `GAMES FEED OFFLINE` — a
  fetch failure is always visible, with copy explaining the board is empty
  because data is missing, not because the market is efficient.
- `ODDS STALE` — live feed older than the per-sport
  `odds_stale_max_age_seconds` (21600s default).
- `NEWS FEED STALE` — news watcher older than the dead-man threshold
  (`deadman_switch_max_age_seconds`, 300s), mirroring the sniper's
  dispatch-suppression semantics.
- Staleness is suppressed for fixture datasets (static by design);
  transport errors always surface.

## 5. Top Plays contract

Adapter-driven via `topPlays.source`:

- `picks_file` (NFL): verbatim `picks.top_projections` membership.
- `ev_ranked` (NBA): rows require a bookable quote in the active market AND
  complete projection inputs; order is EV per unit staked desc →
  probability edge desc → **model confidence** (narrower adapter
distribution interval first) → **sample size** (`games_prior` desc,
neutral when the feed omits it) → player name asc.

  The audit-revised chain (H5) removes the earlier "receipt-verified
  first" tie-break: receipt coverage is a data-availability signal, not a
  quality signal, and ranking one play above an equally good one because a
  covered book supplied a receipt is selection bias. `verified` still
  gates actionable classification and still renders honestly in the book
  cell — it just never ranks plays.

## 6. Mobile fit (audit B3)

At 375px the NFL page measured `documentElement.scrollWidth` 463 vs a 375
viewport — real overflow that `body{overflow-x: hidden}` merely clipped
(clipping is not fitting). Empirical element-level measurement with
ancestor-clip detection located the leak: `.pw-topbar-right` was
`flex-shrink: 0 !important` with all-nowrap children (slate select, injury
pill, upgrade button, menu button); its right edge equalled the document
scrollWidth exactly. The horizontally scrolling chip strip is an internal
scroller and was never the problem.

Fix: the topbar-right cluster may shrink; the injury pill truncates to dot
+ ellipsis; buttons keep size. Re-measured after the fix: NFL and NBA both
fit at 375px and 390px (`scrollWidth == clientWidth`), pill still visible
and tappable. Regressions of this kind are caught by the E2E screenshots
(`test/screenshots/phase2_*.png`), refreshed with the fix.

## 7. Branch topology (audit H7)

Phase 2 was developed stacked on `phase/1-adapter` before Phase 1 was
reviewed. Actual state, verified by remote refs on 2026-10-24:

```
main 1ea8990 = "Merge pull request #1 from NickAiNYC/phase/1-adapter"
             (parents: bdc229f + 5cc0196; diff vs 5cc0196 is empty)
phase/2-nba: 7 Phase 2 commits on top of 5cc0196
             → merging into main is a clean merge (no rebase needed)
```

CI evidence: `phase/1-adapter @ 5cc0196` success (run 40063252959) and
`main @ 1ea8990` success (run 40063281580). A stale pre-Phase-1 branch
`propwire-ui-redesign` (Oct 20, −243k lines) exists on the remote and is
not part of this stack; recommend deleting it after review.

The Phase 1-merged-with-known-bug case (audit H6): the
`riskPolicy.edgeGate` crash fix landed on `phase/2-nba` (commit 83714bd)
after the Phase 1 merge, so `main` carries the live crash until the Phase
2 PR merges. Decision recorded here: the fix rides the Phase 2 PR (it is
backport-equivalent — one commit, `phase/2-nba` contains it); do not merge
Phase 2 into a release context without that commit.

## 8. Adding a sport (checklist)

1. `viewer/js/sports/<sport>.js` — full adapter (contract above).
2. Fixture feeds (or a gated ingest script like `fetch_nba.py`) with
   provenance flags; bare-array slate/games if they mirror the viewer
   schema.
3. `circuit_breaker_config.json` block: `calibrated: false` +
   `uncalibrated_tuning_parameters` until backtest evidence exists; bounds
   scaled to the sport, never copied.
4. `<script src="/js/sports/<sport>.js">` on all four HTML pages.
5. `test/helpers/sandbox.mjs` `loadApp` sources: add the adapter.
6. Tests: adapter contract, feed schema/provenance, breaker isolation,
   copy-compliance lint, boot integration.
7. `sw.js` precache entry + cache-name bump; asset `?v=` bump on the pages.
8. NFL parity must stay byte-identical (10 goldens incl. detail modal +
   dom access log; the earned chrome whitelist + allowlist assertion are
   part of the contract — see test/nfl-parity.snapshot.mjs).
