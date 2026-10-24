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
  `elById()` — a `getElementById` wrapper that degrades to a no-op in the
  parity sandbox, which is how Phase 2 UI provably sits outside the NFL
  golden snapshots.

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
- Ledger entries logged against fixture quotes are stamped
  `data_provenance: "fixture"` (both entry-creation sites) so per-sport CLV
  stats can never blend synthetic data with live-book fills. NFL live
  entries carry NO such field — the ledger schema is byte-identical.
- The RESEARCH FIXTURES banner (`dataQualityBanner`) is always visible on a
  fixture slate.

### Breaker status

`circuit_breaker_config.json → sports.nba` carries `calibrated: false` and
`calibration: "uncalibrated_tuning_parameters"`. Drift bounds are
order-of-magnitude placeholders scaled to NBA stat variance and must never
copy NFL values (test-enforced). The uncalibrated flag is what the UI uses
to keep the research framing honest.

### Markets

`points`, `rebounds`, `assists`, `threes` (3PM), `pra` — normal-approximation
ranges (`mu`/`sd` per row, documented uncalibrated fallback `sd = max(1, 0.35·mu)`).
Slate keys are **US Eastern calendar dates** (`etDateKey` handles DST via the
IANA tz database; mirrored in Python by `scripts/fetch_nba.py`).

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
  probability edge desc → receipt-verified first → player name asc.

## 6. Adding a sport (checklist)

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
8. NFL parity must stay byte-identical (8 goldens, zero new whitelist).
