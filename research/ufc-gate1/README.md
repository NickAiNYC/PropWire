# UFC Module — Gate 1 Readiness Checklist & Market-Key Registry

**PropStein · lead quant + systems architect, UFC module · 2026-10-31**
**First concrete deliverable per UFC charter standing orders** (checklist + registry, not a new UI or model claim).

## Honesty header (leads every UFC artifact, permanently)

| Metric | UFC | NFL (context) |
|---|---|---|
| Graded decisions (N) | **0** | ≈37 |
| Beat-close rate | **0/0 — does not exist** | 2/37 (5.4%) |
| Beat-close 95% CI (Wilson) | **— no data** | [1.5%, 17.7%] |
| Prospective CLV | **no evidence** | no evidence |
| Live edge claim | **NO EDGE** | NO EDGE |
| Paid tiers | **FROZEN** | FROZEN |

- Historical calibration skill ≠ live edge. Nothing here may contradict or outrun the public performance page.
- Gate 2 unlock requires N ≥ 300 graded decisions with CLV CI lower bound > 0. UFC N = 0.
- Every UFC surface defaults to NO EDGE / UNVERIFIED / STALE on failure. Never hidden.

**Gate status at issue:** UFC Gate 1 **OPEN** (this document is step 1 of it) · UFC Gate 2 **OPEN**. NFL: Gate 1 internally cleared (merged, main `50028c92`), externally blocked (V8 0/2, event-ID map 0/8); NFL Gate 2 open. NFL standby undisturbed.

---

## §0 The one-sentence finding

The primary vendor (The Odds API) currently offers exactly **one verified MMA market (`h2h`, fight winner) plus limited `totals` (round totals) from some bookmakers — and none of the charter's prop markets (method of victory, round props, significant strikes, takedowns, control time, fighter totals) exist anywhere in its betting-markets catalogue.** The registry below records that gap with evidence; no key is invented; the affected charter markets stay BLOCKED at the vendor layer until verified keys or a verified+permitted secondary vendor exist. This is the NFL `player_receiving_yards` lesson caught before a single credit is spent.

---

## §A Market-Key Registry (verified against vendor documentation, retrieved 2026-10-31)

### Table A1 — VERIFIED keys (safe to build against, pending runtime confirmation)

| # | Key (exact vendor string) | Market | Sport key | Endpoint family | Status | Evidence |
|---|---|---|---|---|---|---|
| R1 | `mma_mixed_martial_arts` | MMA/UFC sport key | — | `/v4/sports`, `/v4/sports/{sport_key}/odds`, `/v4/historical/...` | **VERIFIED** | MMA page example request (mma-odds.html); historical page lists MMA under this key |
| R2 | `h2h` | Fight winner (moneyline) | `mma_mixed_martial_arts` | featured markets: odds endpoint, `/events/{eventId}/odds`, historical event odds | **VERIFIED** | "Fight winner is covered for several bookmakers" (mma-ufc-odds.html); catalogue h2h definition |
| R3 | `totals` | Total rounds (over/under) | `mma_mixed_martial_arts` | same as R2 | **VERIFIED-KEY / LIMITED-COVERAGE** | "Limited coverage of total rounds odds are also available from some bookmakers" (mma-ufc-odds.html) |

**R3 hard rule:** per-bookmaker availability MUST be confirmed at runtime via the `/v4/markets` endpoint before any quote is relied on (the catalogue's own instruction: "For the most up-to-date list of available markets by each bookmaker, query the markets endpoint"). A bookmaker without MMA `totals` is recorded STALE/UNVERIFIED — never assumed present. `/v4/markets` cost is recorded from response headers at runtime (measured, never modeled).

**R2 settlement note (verify from first real receipts):** whether MMA `h2h` ever carries a draw outcome (3-way shape) and how settlement treats draws/no-contests. Synthetic fixtures must model both 2-way and 3-way shapes so the settlement check (V7-equivalent) catches either. Not verifiable from documentation alone.

### Table A2 — Charter markets with NO primary-vendor key (the honest gap)

| # | Charter market | Vendor key | Status | Evidence |
|---|---|---|---|---|
| R4 | Method of victory (KO/TKO / Submission / Decision) | **none exists** | **UNAVAILABLE_FROM_PRIMARY** | No MMA section in the player-props catalogue (sections cover NFL/NCAAF/CFL, NBA/NCAAB/WNBA, MLB, NHL, AFL, NRL, Soccer only); "Additional markets are currently limited to US sports"; MMA page: "currently covers MMA fight winner odds, with more markets on the way" |
| R5 | Round props (fight ends in round X / goes the distance) | **none exists** | **UNAVAILABLE_FROM_PRIMARY** | No per-round MMA markets; no MMA game-period markets; closest available is R3 (`totals` = round-count over/under only) |
| R6 | Significant strikes (fighter totals) | **none exists** | **UNAVAILABLE_FROM_PRIMARY** | as R4 |
| R7 | Takedowns (fighter totals) | **none exists** | **UNAVAILABLE_FROM_PRIMARY** | as R4 |
| R8 | Control time | **none exists** | **UNAVAILABLE_FROM_PRIMARY** | as R4 |
| R9 | Decision/KO/Sub fighter totals (component props) | **none exists** | **UNAVAILABLE_FROM_PRIMARY** | as R4; R4's absence implies component props also absent |

**Consequences, stated plainly:**
1. No code, config, fixture, UI surface, or model output may reference any A2 market as a priced market. They may appear only as UNAVAILABLE status.
2. The charter's distributional core (multinomial method-of-victory, round survival/hazard, NegBin/Poisson-Gamma strike/takedown counts) has **no priced market to grade against at the primary vendor** — those models cannot produce graded CLV decisions until A2 markets exist at a verified, permitted source. Models without priced markets are research-only and must be labeled non-prospective.
3. The vendor invites market suggestions and states more MMA markets are "on the way" — the registry gets re-verified against the catalogue + `/v4/markets` on a standing schedule; a newly appeared key is still UNVERIFIED until confirmed in both.

### Table A3 — Secondary-vendor candidates (nothing claimed, nothing trusted)

| Candidate | What they advertise | Status |
|---|---|---|
| TheRundown.io | UFC moneylines, totals, method of victory, round props, in-play odds (DraftKings, FanDuel, Pinnacle, …) | **CANDIDATE-UNVERIFIED** — no ToS review, no V8-equivalent written permission, no receipt/header verification performed |
| Various (Valor Odds, OddsBlaze, BettorServe, OddsPapi, consensus-line APIs) | MMA odds, props, historical | **CANDIDATE-UNVERIFIED** — same |

A candidate becomes VERIFIED in this registry only after: (1) market keys verified against their live documentation, (2) written commercial permission on file (V8-equivalent), (3) receipt/header semantics verified with a metered sample, (4) a fail-closed data-quality trial passing all checks. Until then they are names, not sources.

---

## §B Event-ID / fight-ID map — readiness

- **Vendor event = one fight.** The vendor's MMA "event" is a single bout (`home_team`/`away_team` = the two fighters, e.g. Parkin vs Pogues). A UFC card is therefore **many events**; the map is **per-fight**, not per-card.
- Required map fields: vendor `event_id`, both fighter names, card/date, `commence_time`, weigh-in time, discovery endpoint + `discovery_timestamp_utc`, `status` (UNVERIFIED → VERIFIED only with receipt evidence).
- **Current state: 0 fights mapped. No UFC harness exists yet.** A map file does not exist until the harness skeleton lands (owner order).
- Discovery path (same Stage-A pattern as NFL): `GET /v4/historical/sports/mma_mixed_martial_arts/events?date={date}` on a **paid plan**; historical MMA data exists from 2020-06-06; 100% verified before any live pull.
- Scale note: a card ≈ 10–15 fights. Historical event-odds pulls cost **10 credits per region per market per event** (verified). A trial of 8 fights × 3 timestamps × 1 market × 1 region ≈ 240 quote credits + discovery requests — budget-guarded, pre-committed, owner-approved before any spend.

## §C Receipt & meter layer — port spec from NFL 2D-V

Port unchanged (these survived the honesty constraints):
- Header-measured credit meter (`x-requests-used` / `x-requests-last`); measured never overridden by modeled.
- Pre-request budget guard: measured + modeled > cap → abort PARTIAL, unestablished rows recorded honestly.
- Fail-closed on missing/invalid usage headers: abort, never estimate.
- SHA-256 receipt digest per stored response; tamper detection over stored evidence.
- Quarantine directory + confinement guard (all ledgers/evidence inside; nothing escapes).
- No key from chat, files, or arguments — env-var on the licensed machine only (T8/T12 equivalents must self-test PASS).
- **Synthetic-only mode** until V8-UFC CONFIRMED **and** fight-ID map 100% verified. Zero vendor requests, zero credits before both.

## §D Closing-snapshot schedule (charter-mandated, fail-closed)

Three fixed points per fight: **T_pre** (pre-weigh-in) · **T_post** (post-weigh-in) · **T_lock** (final lock before that fight's first bell).
- Snapshot = capture receipt + bookmaker `last_update`; a missed point is recorded **STALE/UNVERIFIED and never backfilled** from later data.
- Freshness clocks tighter than NFL around weigh-ins (charter); per-fight lock times, not per-card — prelims lock before the main event.
- Closing-line grading uses the T_lock snapshot only; absent T_lock = ungradable decision, logged as such.

## §E Fighter-status event layer

Scratch/late replacement, weight miss, doctor stoppage, no-contest = **first-class events** with timestamps in the same quarantine-guarded store. Status events must suppress related props instantly and automatically at harness/UI time; manual-only suppression is disallowed. (Implementation lands with the harness — listed here because the evidence store schema must reserve these fields from day one.)

## §F Commercial permission — V8-UFC (required before any paid acquisition)

- **Scope defect caught now:** the two NFL V8 drafts describe "a commercial **NFL** player-prop analytics product" and list **NFL** endpoints. They do not request MMA coverage. MMA pulls need their own written permission (or an amendment) — assuming the NFL letter covers MMA would be papering over a gap.
- V8-UFC stays PENDING_MANUAL until the vendor's **verbatim written reply** is on file; leftover placeholders keep it pending by design. No synthetic substitutes, ever.
- **Appendix A** is the ready-to-send draft. Secondary vendors (if pursued) each need their own.

## §G Governance port (PRECOMMITMENT-style)

- Once the UFC harness contract freezes, governing files change **only on explicit owner order**; PATCH_LOG is append-only; red evidence never committed; acceptance gate = full selftest green before any commit.
- Guards ported as UFC equivalents: G1 refit lock (frozen model/artifacts), G2 sample freeze, G3 quarantine, G4 code baseline; selftest with injected faults; deterministic fixtures (double regeneration = zero drift).
- **NFL lesson encoded as a standing rule:** every market string is verified against the vendor catalogue AND the runtime `/v4/markets` response *before* config/fixtures freeze; verifier matchers must match the verified key family exactly (the `player_reception_yds` substring lesson) — no matcher that could silently miss a corrected key.

## §H Gate 1 green definition (UFC) — explicit, all required

1. Market-key registry: every market **in use** is VERIFIED (docs + runtime `/v4/markets`); zero invented keys; A2 markets remain listed UNAVAILABLE (green requires honesty, not their existence).
2. Fight-ID map: **100% verified** with discovery receipts (0 today).
3. Receipt layer ported; selftest fault-injection catches all injected faults; G1–G4 equivalents PASS.
4. Closing snapshots: 3-point schedule demonstrated live on a verified sample with fail-closed semantics (missed point → STALE, no backfill).
5. V8-UFC written permission on file, CONFIRMED.
6. Zero vendor requests / zero credits consumed before 4 ∧ 5.

Minimum viable verified market set at the primary vendor: `h2h` + `totals` (per-bookmaker). The full charter market list stays BLOCKED at the vendor layer (§A Table A2) until keys exist or a verified+permitted secondary vendor supplies them — Gate 1 green does not and must not pretend otherwise.

## §I Explicitly NOT started (blocked behind both gates, per charter)

Distributional core models (multinomial MoV, round survival/hazard, NegBin/Poisson-Gamma counts), Live Sniper UFC mode, correlation-aware SGP, mobile polish, market expansion, any paid UFC tier, any model-weight/CLV/skill claim. Smallest-change rule: the only work advancing a gate is this checklist/registry, then the harness skeleton (synthetic-only), then the gated externals.

## §J Public honesty surface requirements

UFC section of the performance page shows: N=0 · beat-close — · CLV CI — · NO EDGE, with UNVERIFIED/STALE surfacing on any data failure. Every UFC research artifact (this one included) leads with N, beat-close rate, CI. Backtests labeled non-prospective, never used to unlock paid features.

---

## Evidence log (all pages retrieved 2026-10-31; zero vendor API requests, zero credits)

| Fact | Source |
|---|---|
| Sport key `mma_mixed_martial_arts`; h2h example; "currently covers MMA fight winner odds, with more markets on the way" | https://the-odds-api.com/sports-odds-data/mma-odds.html |
| "Fight winner is covered for several bookmakers… Limited coverage of total rounds odds are also available from some bookmakers"; historical from June 2020, paid plans | https://the-odds-api.com/sports/mma-ufc-odds.html |
| Full market catalogue; no MMA player-props section; player props "mainly limited to US sports"; "query the markets endpoint" instruction; h2h/totals definitions | https://the-odds-api.com/sports-odds-data/betting-markets.html |
| Historical MMA from 2020-06-06; 10 credits per region per market (historical event odds); paid plans only; historical events endpoint finds event IDs | https://the-odds-api.com/historical-odds-data and https://the-odds-api.com/liveapi/guides/v4 |
| Secondary-vendor candidates (advertising only, unverified) | https://therundown.io/ufc-odds-api and search results, retrieved 2026-10-31 |

---

## Appendix A — V8-UFC written-permission request (ready to send; owner fills `[BRACKETED]` fields)

**To:** The Odds API — support / sales contact
**From:** [YOUR NAME], PropStein
**Subject:** Written commercial-use confirmation — MMA/UFC odds: storage and derived analytics display (paid plan)

Hello,

PropStein is a commercial sports-analytics product (currently NFL) that is scoping an MMA/UFC module. Before any paid acquisition, I'd like your written confirmation of what our intended uses are permitted under your terms of service, and which plan is required.

**What we intend to do with your MMA data:**

1. **Store raw API responses** from the MMA endpoints (`/v4/sports/mma_mixed_martial_arts/odds`, `/v4/historical/sports/mma_mixed_martial_arts/events`, and `/v4/historical/sports/mma_mixed_martial_arts/events/{eventId}/odds`) in our internal research repository, for audit and reproducibility.
2. **Store derived metrics and backtest results** computed from those responses (calibration statistics, closing-line comparisons, market-quality reports).
3. **Display derived analytics in a commercial product** — aggregations and historical model performance derived from your odds. We do **not** intend to redistribute or re-display raw odds responses themselves.

**Scope:** initially a small historical data-quality trial on `mma_mixed_martial_arts` (a handful of fights, pre-weigh-in / post-weigh-in / final-lock snapshots, `h2h` and `totals` where offered). If it passes our acceptance checks, we would expand to regular historical and prospective pulls under an appropriate plan.

**Questions:**

1. Which paid plan(s) are required for the MMA historical endpoints, and does plan choice affect the permissions below?
2. Are uses (1), (2), and (3) each permitted under your terms of service? A pointer to the specific clause would be perfect — we'll keep your reply on file.
3. Are there attribution or branding requirements when derived analytics (not raw odds) are displayed commercially?
4. Are there retention limits on stored raw responses kept for audit?
5. Market coverage: we understand MMA is currently `h2h` plus limited `totals` from some bookmakers. Are method-of-victory, round, or fighter-prop markets for MMA planned? We don't want to design around markets that won't exist.

We'd appreciate a reply in writing (email is fine). We will not begin MMA acquisition until it is on file.

Thank you,
[YOUR NAME]
PropStein — [YOUR CONTACT / WEBSITE]

**Reminder (after the reply arrives):** paste the vendor's **verbatim** reply into the UFC V8 attachment when the harness exists (`research/ufc-gate1/ATTACHMENT_V8_UFC.md`), permission text only — never keys, account numbers, or credentials. Leftover placeholders keep V8-UFC PENDING_MANUAL by design.

## Appendix B — Next smallest actions, in order

1. **Owner-side (now):** send the two NFL V8 emails (still 0/2 — NFL standby unchanged) **and** Appendix A (V8-UFC). No key/pull needed to send these.
2. **Owner-side (when paid plan + real key active on the licensed machine):** MMA Stage-A discovery trial per §B (date-parameterized historical-events requests → per-fight event IDs → receipts).
3. **Mine, on owner order:** land this checklist + registry in the repo as the root of the UFC research lineage (`research/ufc-gate1/`), frozen as the registry baseline under the §G governance rules; then build the harness skeleton (config + fixtures + verifier + selftest, synthetic-only) with the registry's verified keys and no A2 markets anywhere in code.

*End of deliverable. Prepared under the UFC charter; contradicts nothing on the public performance page, which continues to lead.*
