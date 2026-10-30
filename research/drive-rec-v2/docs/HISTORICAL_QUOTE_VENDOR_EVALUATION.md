# HISTORICAL_QUOTE_VENDOR_EVALUATION.md — licensed, timestamped sportsbook prices

Decision 2D §3: the next priority is acquiring **real historical sportsbook
quotes**. This document evaluates candidate providers, defines the pre-purchase
verification checklist, and proposes the pilot purchase scope.

**Provenance note:** the vendor names in the authorizing message arrived
redacted (placeholder characters replaced the names/links). The two providers
below are identified by matching their published capabilities against the
descriptions that did arrive — *first choice for a limited historical-quote
pilot: paid historical API with five-minute snapshots for additional markets
including player props, dating back to May 2023; strong alternative for
commercial deployment: NFL betting feeds including player props, historical line
movement, and market results, with historical access and commercial licensing
requiring confirmation with the sales team.* **Confirm the intended vendors
before purchase.** No purchase has been made; nothing below is a commitment.

---

## 1. Vendor A — The Odds API (the-odds-api.com) — first choice for a limited pilot

Verified facts (from the provider's own pages, retrieved 2026-10-30):

| Item | Fact |
| --- | --- |
| Historical coverage — additional markets (incl. player props) | available from **May 3, 2023**, snapshots at **5-minute intervals** |
| Historical coverage — featured markets | from June 6, 2020; 10-minute intervals until Sep 2022, then 5-minute |
| Historical access | **paid usage plans only** |
| Historical endpoints | `/v4/historical/sports/{sport}/odds` (featured) and `/v4/historical/sports/{sport}/events/{eventId}/odds` — additional markets are queried **one event at a time** |
| Quota cost | historical event-odds: **10 credits per region per market per event**; historical odds: 10 per region per market |
| Snapshot semantics | returns the closest snapshot at or earlier than the requested `date`, with `previous_timestamp`/`next_timestamp` for navigation; each bookmaker entry carries its own `last_update` timestamp |
| US bookmakers listed | DraftKings, FanDuel, BetMGM, Caesars, Bovada, MyBookie.ag, others |
| Paid tiers advertising historical access | 100K credits $59/mo; 5M credits $119/mo; 15M credits $249/mo (list prices retrieved 2026-10-30; verify current pricing) |

Sources: `https://the-odds-api.com/historical-odds-data` (coverage dates, intervals, paid-only, per-event querying, quota costs); `https://the-odds-api.com` (tiers, bookmaker list); `https://the-odds-api.com/api-reference/v4` (endpoint semantics; confirms "Snapshots of historical odds for non-featured markets (player props, period markets, alternates, etc.) are available from May 2023 at 5 minute intervals").

Fit for the pilot:

- ✅ NFL player props (receiving yards) historical from May 2023 → covers the
  2023–2026 seasons, including both pilot slices (2025 full season, 2026 weeks
  1–7).
- ✅ Per-bookmaker `last_update` timestamps + snapshot timestamps → the quote-age
  and availability-ledger requirements of the contract are satisfiable.
- ⚠️ **Snapshot cadence vs. quote-age requirement (critical):** 5-minute
  snapshots cannot validate the contract's ≤60s primary live-analysis tier
  (best case is the 300s sensitivity tier, with realized quote age 0–300s).
  Pregame entries (T−180m/T−60m/T−15m) are unaffected. The 60s tier requires
  Phase B live capture — this limitation is recorded in the contract, not worked
  around.
- ⚠️ Additional-markets historical must be pulled per event → the pilot cost
  scales with games × markets × snapshots, not with bookmaker count (one call
  returns all books in the requested region).
- ❓ Exact market keys for NFL receiving-yards props, bookmaker-by-date coverage,
  rate limits, and storage/display terms → verification checklist below.

## 2. Vendor B — SportsDataIO (sportsdata.io) — strong alternative for commercial deployment

Verified facts (from the provider's own pages, retrieved 2026-10-30):

| Item | Fact |
| --- | --- |
| Product family | league-specific scores, statistics, **betting**, fantasy, and historical feeds |
| Betting feeds | "Aggregated Odds Feed is designed to aggregate and link up the odds from various sportsbooks from Money Lines and Point Spreads to **Player Props** and Futures" (their Betting Data Integration Guide) |
| Historical depth | marketed to prediction-market makers as "years of historical sports data, betting line history, and live event feeds"; line-movement charts named as a use case of the betting feeds |
| NFL props timing | "NFL player props are released early in the week" (their guide) |
| Licensing | commercial terms and historical access require confirmation with the sales team (consistent with the description that arrived with Decision 2D) |

Sources: `https://sportsdata.io/help/betting-data-integration-guide`; `https://sportsdata.io`.

Fit for the pilot:

- ✅ Aggregated multi-book props + historical line movement matches the
  commercial-deployment direction (consensus benchmarks, closing lines).
- ❓ Historical granularity for player props (per-quote timestamps? interval?),
  per-book coverage, price, and redistribution/storage terms are **not published
  in the pages retrieved** — all require the sales conversation the vendor's own
  site directs you to.
- Decision: pursue Vendor A first for the narrow pilot (published, per-event
  pricing makes a bounded pilot possible immediately); open the Vendor B sales
  conversation in parallel for the commercial phase, since its terms determine
  whether derived data may be stored and displayed commercially at all.

## 3. Pre-purchase verification checklist (both vendors; no purchase before these pass)

1. **Historical depth**: confirm, for the exact pilot dates, that NFL
   receiving-yards props exist with the claimed lookback (Vendor A: ≥ May 2023).
2. **Quote timestamps**: confirm each quote carries a bookmaker-level timestamp
   (Vendor A: `last_update`) in addition to the snapshot timestamp; confirm
   snapshot interval (5 min) and that the API returns the nearest-earlier
   snapshot deterministically.
3. **Actual bookmaker availability**: pull a sample of NFL game days across
   2025 and 2026 weeks 1–7 and record, per bookmaker, whether receiving-yards
   primary lines were quoted at T−180m / T−60m / T−15m / close. Coverage gaps
   are expected; they must be *measured*, not assumed.
4. **Exact market keys**: confirm the market key(s) for NFL player
   receiving-yards (the market catalogue is queryable; do not hardcode).
5. **API rate limits**: confirm requests/min and burst behavior for the
   historical endpoints on the intended tier, and the credit cost per call.
6. **License to store and display derived data commercially**: obtain written
   confirmation covering (a) storing raw quotes, (b) storing derived
   metrics/signals, (c) displaying them in a commercial product. This is gate
   E6 of the contract; absence of written permission blocks the pilot run.
7. **Settlement cross-check option**: ask whether official box-score props
   settlement data is licensable (preferred over pbp-derived settlement).

## 4. Proposed pilot scope and cost estimate (Vendor A basis; estimate only)

- **Seasons**: 2025 full season (272 regular + 13 postseason = 285 games) and
  2026 weeks 1–7 (107 games) — the same slices as criteria v3, so economic
  results align with the calibration evidence. **392 games total.**
- **Market**: one market family (player receiving yards O/U, primary lines).
- **Snapshots per game**: 4 (T−180m, T−60m primary, T−15m, closing) — enough
  for the precommitted decision timestamps and CLV, without trying to chart
  full line history in Phase A.
- **Credit arithmetic** (Vendor A published costs): 392 games × 4 snapshots ×
  10 credits/region/market/event = **15,680 credits**, single region (us),
  single market family; plus event-id discovery and a handful of verification
  pulls. Retries and coverage probes realistically double the figure. The 100K
  tier (~US$59 for one month at list) covers the pilot with margin; the 5M tier
  (~US$119/mo) is the fallback if verification pulls or added snapshots exceed
  the budget.
- **Books**: all books the region call returns at once (no extra credit cost);
  the primary evaluation uses books passing checklist item 3, recorded in the
  availability ledger.
- **What the pilot deliberately does NOT buy**: alternate lines, other prop
  markets, live in-game snapshots (cannot support the 60s tier anyway at
  5-min cadence), non-US regions.

## 5. Decision requested before purchase

1. Confirm Vendor A (The Odds API) and Vendor B (SportsDataIO) are the intended
   providers (names arrived redacted).
2. Approve the pilot scope (§4) and the written-permission requirement (§3.6).
3. After approval: run the trial verification (§3) → purchase → ingest into the
   canonical quote store → execute `decision_2d/run_pilot.py` under the frozen
   contract gates E1–E6.

---

## 6. Decision 2D review outcome (2026-10-30) — §5 requests answered

1. **Both vendors confirmed** (The Odds API primary; SportsDataIO secondary).
   The owner independently verified the capability table above against the
   vendors' official documentation, including the distinction that
   SportsDataIO's historical player props live in a separate data warehouse
   with sales-enabled access — ordinary trial credentials must NOT be assumed
   to include historical NFL coverage.
2. **Credit arithmetic reconciled by the owner**: 392 games x 4 snapshots x
   10 credits = 15,680 (four-snapshot configuration, one region, one market
   per snapshot); the three specified observation times T−180m/T−60m/T−15m
   instead cost ≈ 11,760. Additional markets, regions, or requests increase
   consumption. Vendor-confirmed rule: historical event-odds cost 10 credits
   per region, market, and event.
3. **Trial verification AUTHORIZED; purchase PENDING TRIAL.** The binding
   trial protocol is Decision 2D-V: checks V1–V10 (availability, timestamp
   integrity, market identification, sportsbook identity, price integrity,
   missingness, settlement vs independent statistics, written commercial
   rights [manual], cost reconciliation, reproducibility), with the
   acceptance rule that ANY critical failure blocks the full acquisition.
   Implemented in `vendor_trial_2dv/` (see its README and PRECOMMITMENT.md).
4. **Experimental safeguard (ordered by the owner)**: trial observations must
   not revise the frozen model or select a more favorable EV threshold;
   profitability uses of trial observations are exploratory with an untouched
   evaluation set reserved.
5. Next milestone: **Decision 2D-V — Vendor Trial Acceptance** (verified
   real-quote sample + coverage/missingness report + actual consumption +
   explicit pass/fail recommendation), then the full 392-game acquisition.
