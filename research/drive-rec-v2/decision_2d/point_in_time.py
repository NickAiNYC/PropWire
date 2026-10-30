"""point_in_time.py — strictly point-in-time quote selection with leakage guards.

For each (game, bookmaker, player) and a decision offset (e.g. T-60m before
kickoff) we select the quote row from the LATEST snapshot at or before the
decision timestamp, and record:

  quote_age_seconds  = decision_ts - book_last_update_utc
  snapshot_age       = decision_ts - snapshot_ts_utc
  decision_ts        = kickoff + offset

Leakage guards (asserted, not assumed):
  * decision timestamp must precede kickoff;
  * the selected quote's timestamps must not exceed the decision timestamp;
  * inputs to the universe filter may not carry post-decision information
    (checked by the caller via `assert_point_in_time`).

The contract's quote-age tiers: <=60s primary (Phase B live capture only),
<=120s / <=300s sensitivity; on 5-minute historical snapshots the honest
reportable tier is <=300s, and quote ages are REPORTED, never assumed.
"""

from __future__ import annotations

import pandas as pd

from quotes import as_bool

QUOTE_AGE_TIERS = {"primary_live": 60, "sensitivity": [120, 300]}

DECISION_OFFSETS = {"T-180m": -180, "T-60m": -60, "T-15m": -15,
                    "closing": 0}   # minutes relative to kickoff


class LeakageError(RuntimeError):
    pass


def assert_point_in_time(decision_ts: pd.Timestamp, kickoff: pd.Timestamp,
                         what: str = "decision") -> None:
    if decision_ts >= kickoff:
        raise LeakageError(
            f"{what} timestamp {decision_ts} is not strictly pre-kickoff "
            f"({kickoff}); point-in-time selection violated")


def select_quotes_at(q: pd.DataFrame, offset_minutes: int,
                     label: str = "decision",
                     strictly_before_kickoff: bool = True) -> pd.DataFrame:
    """Latest snapshot at or before kickoff+offset for each
    (game, bookmaker, player); skips voided markets; records ages.

    Semantics: quotes whose snapshots postdate the decision timestamp are
    simply NOT selected (that is the point-in-time filter). The leakage guard
    raised here is on the DECISION timestamp itself: pregame decisions must be
    strictly before kickoff; `closing` (offset 0) passes
    strictly_before_kickoff=False and selects the last snapshot at or before
    kickoff.

    Returns one row per (game_id, bookmaker, player_id) with columns
    [decision_ts, quote_age_seconds, snapshot_age_seconds] appended.
    Games/books with no quote at or before the decision timestamp are simply
    absent — absence is ledger data, never imputed.
    """
    q = q.loc[~as_bool(q.voided)].copy()
    q["decision_ts"] = q.kickoff_utc + pd.Timedelta(minutes=offset_minutes)
    bad = (q.decision_ts >= q.kickoff_utc) if strictly_before_kickoff else \
          (q.decision_ts > q.kickoff_utc)
    if bad.any():
        raise LeakageError(
            f"{int(bad.sum())} rows have a {label} decision timestamp at/after "
            "kickoff — point-in-time selection is misconfigured")
    q = q.loc[(q.snapshot_ts_utc <= q.decision_ts)
              & (q.book_last_update_utc <= q.decision_ts)]
    if q.empty:
        return q
    idx = q.groupby(["game_id", "bookmaker", "player_id"]).snapshot_ts_utc.idxmax()
    sel = q.loc[idx].copy()
    sel["quote_age_seconds"] = (
        (sel.decision_ts - sel.book_last_update_utc).dt.total_seconds())
    sel["snapshot_age_seconds"] = (
        (sel.decision_ts - sel.snapshot_ts_utc).dt.total_seconds())
    return sel


def quote_age_report(sel: pd.DataFrame) -> dict:
    """Distribution of quote ages at decision (reported, not assumed)."""
    if sel.empty:
        return {"n": 0}
    a = sel.quote_age_seconds
    return {
        "n": int(len(sel)),
        "within_60s": float((a <= 60).mean()),
        "within_120s": float((a <= 120).mean()),
        "within_300s": float((a <= 300).mean()),
        "median_seconds": float(a.median()),
        "p90_seconds": float(a.quantile(0.9)),
        "max_seconds": float(a.max()),
    }
