"""quotes.py — vendor-agnostic canonical quote store for licensed, timestamped prices.

The canonical schema below is what the pilot evaluates. Vendor adapters (none
purchased yet) must map INTO this schema; the evaluation code never sees vendor
formats. The store must contain LICENSED quotes only: any row flagged `synthetic`
makes the whole run HYPOTHETICAL and non-promotable (run_pilot refuses).

Schema (one row = one bookmaker's price for one player's receiving-yards O/U
market at one snapshot):

  game_id               e.g. "2025_01_ARI_NO"
  kickoff_utc           ISO-8601 kickoff timestamp
  bookmaker             vendor bookmaker key (e.g. "draftkings")
  player_id             nflverse gsis-format id ("00-0033357") — join key
  player_name           display name (audit only)
  line                  the O/U line (e.g. 57.5)
  price_over_decimal    decimal odds for the over, > 1.0
  price_under_decimal   decimal odds for the under, > 1.0
  snapshot_ts_utc       when the snapshot was taken (vendor cadence ~5 min)
  book_last_update_utc  bookmaker-level timestamp of the price itself
  voided                bool — market later voided (settlement-excluded, ledgered)
  synthetic             bool — must be False for a promotable run
  source                vendor / license identifier (audit)

Contract requirements implemented here:
  * per-quote bookmaker timestamps (not only snapshot timestamps);
  * BOTH sides of the two-sided market priced (needed for no-vig CLV);
  * availability/missingness preserved: absence of rows is data, never imputed.
"""

from __future__ import annotations

import pandas as pd

COLUMNS = [
    "game_id", "kickoff_utc", "bookmaker", "player_id", "player_name",
    "line", "price_over_decimal", "price_under_decimal",
    "snapshot_ts_utc", "book_last_update_utc", "voided", "synthetic", "source",
]
TS_COLUMNS = ["kickoff_utc", "snapshot_ts_utc", "book_last_update_utc"]


class QuoteValidationError(ValueError):
    pass


def as_bool(s: pd.Series) -> pd.Series:
    """Coerce bool-ish values robustly (CSV round-trips make 'False' truthy)."""
    if s.dtype == bool:
        return s
    return s.astype(str).str.strip().str.lower().isin(
        ["true", "1", "1.0", "yes"])


def validate_quotes(df: pd.DataFrame, strict: bool = True) -> pd.DataFrame:
    """Validate the canonical schema and invariants; return a typed copy."""
    missing = [c for c in COLUMNS if c not in df.columns]
    if missing:
        raise QuoteValidationError(f"quote store missing columns: {missing}")
    q = df.copy()
    for c in TS_COLUMNS:
        q[c] = pd.to_datetime(q[c], utc=True, errors="coerce")
    if q[TS_COLUMNS].isna().any().any():
        bad = q.loc[q[TS_COLUMNS].isna().any(axis=1), "game_id"].head().tolist()
        raise QuoteValidationError(f"unparseable timestamps in rows: {bad}")
    for c in ("price_over_decimal", "price_under_decimal"):
        q[c] = pd.to_numeric(q[c], errors="coerce")
    q["line"] = pd.to_numeric(q["line"], errors="coerce")
    if q[["line", "price_over_decimal", "price_under_decimal"]].isna().any().any():
        raise QuoteValidationError("non-numeric line/price values present")
    if (q.price_over_decimal <= 1.0).any() or (q.price_under_decimal <= 1.0).any():
        raise QuoteValidationError("decimal odds must exceed 1.0 on both sides")
    if (q.line <= 0).any():
        raise QuoteValidationError("lines must be positive")
    # bookmaker timestamp may not postdate its own snapshot (clock sanity)
    late = q.book_last_update_utc > q.snapshot_ts_utc + pd.Timedelta(seconds=60)
    if late.any() and strict:
        raise QuoteValidationError(
            f"{int(late.sum())} quotes have book_last_update later than their "
            "snapshot (+60s tolerance) — timestamps are untrustworthy (gate E6)")
    # a snapshot per (game, book, player, line) must be unique
    dup = q.duplicated(subset=["game_id", "bookmaker", "player_id", "line",
                               "snapshot_ts_utc"])
    if dup.any():
        raise QuoteValidationError(f"{int(dup.sum())} duplicate quote rows")
    if bool(as_bool(q.synthetic).any()):
        raise QuoteValidationError(
            "SYNTHETIC quotes present: the run is HYPOTHETICAL and cannot "
            "support promotion (contract quote_source.synthetic_quotes)")
    q["voided"] = as_bool(q.voided)
    q["synthetic"] = as_bool(q.synthetic)
    return q


def load_quote_store(path, strict: bool = True) -> pd.DataFrame:
    """Load a canonical quote store from parquet or CSV."""
    path = str(path)
    df = pd.read_parquet(path) if path.endswith(".parquet") else pd.read_csv(path)
    return validate_quotes(df, strict=strict)


def books_by_game(q: pd.DataFrame) -> pd.DataFrame:
    """Availability ledger input: books quoting per game (any player, any time)."""
    return (q.groupby("game_id").bookmaker.nunique()
             .rename("n_books").reset_index())


def implied_probs(price_over: float, price_under: float) -> tuple[float, float]:
    """Two-sided raw implied probabilities (each 1/D; sum > 1 = vig)."""
    return 1.0 / price_over, 1.0 / price_under


def novig_close_prob(price_over: float, price_under: float) -> float:
    """Vig-free over probability by symmetric normalization (CLV benchmark)."""
    po, pu = implied_probs(price_over, price_under)
    return po / (po + pu)
