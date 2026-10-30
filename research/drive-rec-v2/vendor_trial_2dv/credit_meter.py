"""credit_meter.py — credit accounting for The Odds API trial requests.

The credit rule is VENDOR-DOCUMENTED and was reconciled by the project owner on
2026-10-30: a historical event-odds request costs **10 credits per region per
market per event**. One response returns ALL bookmakers in the requested
region, so cost scales with games x observation-times x regions x markets —
not with bookmaker count.

Full-acquisition projections (single region, single market family):

    392 games x 3 observation times (T-180m/T-60m/T-15m) x 10 = 11,760
    392 games x 4 snapshots (incl. closing)          x 10 = 15,680

Both reproduce the project owner's 2026-10-30 arithmetic exactly; the trial
budget is far smaller (see trial_config.json credit_budget_cap).

PATCH 2026-10-30 (owner code inspection, defect #2 — "the credit guard does
not reliably measure real spending"). This module now also provides `Meter`:
header-based ACTUAL-consumption tracking on EVERY response.

Vendor facts (docs retrieved 2026-10-30):
  - responses carry `x-requests-used` (cumulative credits used since the last
    quota reset), `x-requests-remaining` (credits left), and
    `x-requests-last` (credits charged for the last call);
  - GET /v4/sports does not count against usage (used for a zero-cost
    baseline);
  - completed games surface via /scores only within daysFrom=3 (hence the
    event-ID map — see discover_event_ids.py).

Meter rules (all fail-closed):
  R1 actual consumption per response = x-requests-used delta (cumulative
     counter — immune to whatever the key spent before this session);
  R2 cross-checked against x-requests-last and the x-requests-remaining
     delta; any disagreement raises ConsumptionUnestablished;
  R3 a response missing x-requests-used on a non-retryable status raises
     ConsumptionUnestablished;
  R4 pre-flight authorization: measured spend + documented-modeled cost of the
     NEXT request (every retry attempt and every discovery request counts)
     must stay within credit_budget_cap, else BudgetExceeded;
  R5 post-observation: measured cumulative spend re-checked against the cap;
  R6 every request kind is metered: baseline, discovery, retries, quotes.

The model never overrides the headers; a mismatch is evidence, not something
to smooth over (check V9 reconciles the ledger).
"""

from __future__ import annotations

import json
from pathlib import Path

CREDITS_PER_REGION_PER_MARKET_PER_EVENT = 10

RETRYABLE_STATUS_DEFAULT = (429, 500, 502, 503, 504)


class BudgetExceeded(RuntimeError):
    """Fail-closed spend control: abort PARTIAL before/after exceeding cap."""


class ConsumptionUnestablished(RuntimeError):
    """Fail-closed metering: actual consumption cannot be established."""


def _int_or_none(v) -> int | None:
    if v is None:
        return None
    try:
        return int(str(v).strip())
    except (ValueError, TypeError):
        return None


def load_config(path: str | Path | None = None) -> dict:
    here = Path(__file__).resolve().parent
    cfg = json.loads((here / "trial_config.json").read_text())
    if path is not None:
        user = json.loads(Path(path).read_text())
        cfg.update(user)
    return cfg


def request_cost(n_regions: int = 1, n_markets: int = 1) -> int:
    """Modeled credits for ONE historical event-odds request."""
    return CREDITS_PER_REGION_PER_MARKET_PER_EVENT * n_regions * n_markets


def documented_cost(kind: str, cfg: dict | None = None) -> int:
    """Modeled credits for one request of `kind` — PROJECTION ONLY, used for
    pre-flight authorization. Actual consumption is header-measured."""
    cfg = cfg or load_config()
    dc = cfg.get("documented_costs", {})
    if kind == "baseline_sports":
        return int(dc.get("sports_list", 0))
    if kind == "events_probe":
        return int(dc.get("events_list", 1))
    if kind == "event_detail":
        return int(dc.get("event_detail", 1))
    if kind == "historical_event_odds":
        return int(dc.get("historical_event_odds_per_region_per_market",
                          CREDITS_PER_REGION_PER_MARKET_PER_EVENT))
    return int(dc.get(kind, CREDITS_PER_REGION_PER_MARKET_PER_EVENT))


def trial_modeled_cost(config: dict) -> dict:
    """Modeled cost of the trial quote pulls (event discovery excluded)."""
    n_games = (config["sample"]["n_games_2025"]
               + config["sample"]["n_games_2026_w1_7"])
    n_times = len(config["observation_offsets_minutes"])
    n_regions = 1
    n_markets = len(config["market_candidates"])
    modeled = n_games * n_times * request_cost(n_regions, n_markets)
    return {
        "games": n_games,
        "observation_times": n_times,
        "regions": n_regions,
        "markets": n_markets,
        "modeled_quote_pull_credits": modeled,
        "budget_cap": config["credit_budget_cap"],
        "within_budget": modeled <= config["credit_budget_cap"],
    }


def full_acquisition_projection(config: dict) -> dict:
    """Modeled cost of the full 392-game acquisition (pre-purchase estimate)."""
    games = config["full_acquisition_projections"]["games"]
    return {
        "games": games,
        "three_observation_times": games * 3 * CREDITS_PER_REGION_PER_MARKET_PER_EVENT,
        "four_snapshots_incl_closing": games * 4 * CREDITS_PER_REGION_PER_MARKET_PER_EVENT,
        "regions": 1,
        "markets": 1,
        "note": config["full_acquisition_projections"]["note"],
    }


class Meter:
    """Actual-consumption meter over the vendor's usage headers.

    One `observe()` per HTTP response (every attempt of every request kind).
    Appends one JSONL row per response to the run's credit ledger.
    """

    def __init__(self, cfg: dict, ledger_path: str | Path, mode: str):
        self.cap = int(cfg["credit_budget_cap"])
        retry_cfg = cfg.get("retry", {})
        self.retryable = set(retry_cfg.get("retryable_status",
                                           list(RETRYABLE_STATUS_DEFAULT)))
        self.ledger_path = Path(ledger_path)
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        self.ledger_path.write_text("")
        self.mode = mode
        self.spent = 0                       # cumulative MEASURED credits
        self.used_established: int | None = None   # last cumulative reading
        self.rem_established: int | None = None
        self._open_attempts = 0              # retries inside an open segment

    # ---------------- ledger ----------------
    def _append(self, row: dict) -> None:
        with self.ledger_path.open("a") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")

    # ---------------- authorization (R4) ----------------
    def authorize(self, modeled_credits: int, context: str = "") -> None:
        """Pre-flight: measured spend + modeled cost of the NEXT request
        (each retry attempt, each discovery request) must stay within cap."""
        modeled = int(modeled_credits)
        if self.spent + modeled > self.cap:
            raise BudgetExceeded(
                f"budget guard (pre-request): measured spend {self.spent} + "
                f"modeled {modeled} > credit_budget_cap {self.cap} "
                f"[{context or 'n/a'}]; aborting PARTIAL (fail-closed)")

    # ---------------- observation (R1-R3, R5) ----------------
    def observe(self, kind: str, purpose: str, status: int | None,
                headers: dict, fields: dict | None = None) -> dict:
        """Record one response. Returns the ledger row, or raises
        ConsumptionUnestablished / BudgetExceeded (row is appended first,
        so the evidence survives the abort)."""
        fields = dict(fields or {})
        used = _int_or_none(headers.get("x-requests-used"))
        rem = _int_or_none(headers.get("x-requests-remaining"))
        last = _int_or_none(headers.get("x-requests-last"))
        row: dict = {
            "request_kind": kind,
            "purpose": purpose,
            "http_status": status,
            "x_requests_used_before": self.used_established,
            "x_requests_used_after": used,
            "x_requests_remaining_before": self.rem_established,
            "x_requests_remaining_after": rem,
            "x_requests_last": last,
            "actual_credits": None,
            "cumulative_actual_after": self.spent,
            "consumption_unestablished": False,
        }
        row.update(fields)

        def _fail(note: str) -> ConsumptionUnestablished:
            row["row_type"] = "unestablished"
            row["consumption_unestablished"] = True
            row["note"] = note
            self._append(row)
            return ConsumptionUnestablished(f"{kind}/{purpose}: {note}")

        if used is None:
            if status is None or status in self.retryable:
                # no response, or retryable status, without usage headers:
                # the segment stays open; consumption is attributed to the
                # next response that carries x-requests-used.
                self._open_attempts += 1
                row["row_type"] = "open_segment"
                row["open_segment_attempts"] = self._open_attempts
                row["note"] = (f"no usage headers (status {status}); segment "
                               "stays open — consumption attributed to the "
                               "next metered response")
                self._append(row)
                return row
            raise _fail(f"x-requests-used missing on non-retryable response "
                        f"(status {status}) — consumption cannot be "
                        "established")

        if self.used_established is None:
            if last is not None:
                actual = last
                row["note"] = ("baseline establishment: actual taken from "
                               "x-requests-last (no prior cumulative reading)")
            elif kind == "baseline_sports":
                actual = None
                row["row_type"] = "baseline_open"
                row["note"] = ("baseline establishment call: cumulative delta "
                               "unavailable until the next metered response")
            else:
                raise _fail("first metered response is not the baseline call "
                            "and x-requests-last is absent")
        else:
            actual = used - self.used_established

        if actual is not None:
            if actual < 0:
                raise _fail(f"x-requests-used decreased "
                            f"({self.used_established} -> {used})")
            if last is not None and last != actual:
                raise _fail(f"x-requests-last {last} != cumulative delta "
                            f"{actual} (usage headers disagree)")
            if (self.rem_established is not None and rem is not None
                    and self.rem_established - rem != actual):
                raise _fail(f"x-requests-remaining delta "
                            f"{self.rem_established - rem} != cumulative "
                            f"delta {actual} (usage headers disagree)")
            row["actual_credits"] = actual
            self.spent += actual
            row["cumulative_actual_after"] = self.spent
            if self._open_attempts:
                row["segment_attempts_closed"] = self._open_attempts + 1
                self._open_attempts = 0
        row.setdefault("row_type", "measured")

        self.used_established = used
        if rem is not None:
            self.rem_established = rem
        self._append(row)

        if self.spent > self.cap:  # R5
            raise BudgetExceeded(
                f"budget guard (post-observation): measured cumulative spend "
                f"{self.spent} exceeded credit_budget_cap {self.cap}; "
                "aborting PARTIAL (fail-closed)")
        return row


def ledger_summary(ledger_path: str | Path) -> dict:
    """Reconcile a credit ledger written by Meter (evidence for V9).

    Recomputes every row from the recorded header readings; a row FAILS
    reconciliation when the recomputed value disagrees with the recorded
    actual_credits, when the three headers disagree with each other, when a
    null actual_credits is not an tolerated open/baseline row, or when the
    row is flagged consumption_unestablished.
    """
    rows = [json.loads(line) for line in Path(ledger_path).read_text()
            .splitlines() if line.strip()]
    unestablished, inconsistencies, null_anomalies = [], [], []
    by_kind: dict[str, int] = {}
    quote_mismatches = []
    running = 0
    for i, r in enumerate(rows):
        kind = r.get("request_kind", "unknown")
        actual = r.get("actual_credits")
        ub, ua = (r.get("x_requests_used_before"),
                  r.get("x_requests_used_after"))
        rb, ra = (r.get("x_requests_remaining_before"),
                  r.get("x_requests_remaining_after"))
        last = r.get("x_requests_last")
        ref = f"row {i} ({kind}/{r.get('purpose', '?')})"
        if r.get("consumption_unestablished"):
            unestablished.append({"ref": ref, "note": r.get("note")})
        if ua is not None and ub is not None:
            recomputed = ua - ub
            if recomputed < 0:
                inconsistencies.append(f"{ref}: cumulative usage decreased")
            elif actual is not None and recomputed != actual:
                inconsistencies.append(
                    f"{ref}: recorded actual {actual} != recomputed "
                    f"used-delta {recomputed}")
        elif actual is not None and not (kind == "baseline_sports"
                                         and last == actual):
            # tolerated: the first baseline call legitimately takes its
            # actual from x-requests-last when no prior cumulative reading
            # exists (baseline establishment, R1)
            inconsistencies.append(
                f"{ref}: actual {actual} recorded without used before/after")
        if None not in (rb, ra, actual) and rb - ra != actual:
            inconsistencies.append(
                f"{ref}: remaining delta {rb - ra} != actual {actual}")
        if None not in (last, actual) and last != actual:
            inconsistencies.append(
                f"{ref}: x-requests-last {last} != actual {actual}")
        if actual is None and r.get("row_type") not in ("baseline_open",
                                                        "open_segment"):
            null_anomalies.append(
                f"{ref}: actual_credits null (row_type="
                f"{r.get('row_type')!r})")
        if actual is not None:
            running += actual
            by_kind[kind] = by_kind.get(kind, 0) + int(actual)
            if running != r.get("cumulative_actual_after"):
                inconsistencies.append(
                    f"{ref}: cumulative_actual_after "
                    f"{r.get('cumulative_actual_after')} != running {running}")
            if (kind == "historical_event_odds"
                    and r.get("modeled_credits") is not None
                    and actual != r.get("modeled_credits")):
                quote_mismatches.append({
                    "game_id": r.get("game_id"),
                    "offset": r.get("offset_label"),
                    "modeled": r.get("modeled_credits"),
                    "actual": actual})
    return {
        "n_rows": len(rows),
        "actual_total": running,
        "by_kind": by_kind,
        "n_unestablished": len(unestablished),
        "unestablished": unestablished,
        "n_inconsistencies": len(inconsistencies),
        "inconsistencies": inconsistencies,
        "n_null_anomalies": len(null_anomalies),
        "null_anomalies": null_anomalies,
        "n_quote_mismatches": len(quote_mismatches),
        "quote_mismatches": quote_mismatches,
    }


if __name__ == "__main__":
    cfg = load_config()
    t = trial_modeled_cost(cfg)
    f = full_acquisition_projection(cfg)
    print(json.dumps({"trial": t, "full_acquisition": f,
                      "documented_costs": cfg.get("documented_costs")},
                     indent=2))
