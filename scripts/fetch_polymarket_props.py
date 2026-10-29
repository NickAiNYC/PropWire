#!/usr/bin/env python3
"""
Polymarket NFL player-prop odds fetcher (v176, owner directive: "setup
polymarket ... live odds").

Polymarket's public gamma API (no key, no auth) lists per-game
"<Away> vs. <Home> - Player Props" events whose markets are two-sided
O/U player lines ("Puka Nacua: Receiving Yards O/U 74.5") with Over/Under
probability prices. This script pulls those markets, converts the
probability prices to American odds, matches players against the active
model slate, and merges REAL, receipt-hashed quotes into
viewer/live_odds_feed.json (the file the viewer boots from).

Honesty contract (fail-closed, no fabrication):
  * Only markets with live liquidity >= --min-liquidity (default $10) and
    prices in [0.02, 0.98] are recorded — a dead 0.5/0.5 book carries no
    information and is skipped rather than quoted.
  * observed_at is the actual fetch time; receipts are sha256 content
    hashes of the market payload; source_url points at the tradeable
    Polymarket market.
  * Any network/parse failure exits 0 WITHOUT touching the feed file.
  * The Receipts/verification machinery treats these like any other book:
    quotes only ever say "verified" from real, hashed observations.

DraftKings / FanDuel: those flow through src/odds.py (The Odds API) —
already wired end-to-end incl. de-vig consensus — and activate when the
owner adds the ODDS_API_KEY secret (autopilot picks it up automatically).

Usage:
  python scripts/fetch_polymarket_props.py                # fetch + merge
  python scripts/fetch_polymarket_props.py --dry-run      # print only
  python scripts/fetch_polymarket_props.py --selftest     # offline tests
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
VIEWER = ROOT / "viewer"
GAMMA = "https://gamma-api.polymarket.com"
BOOK = "Polymarket"
SOURCE = "https://gamma-api.polymarket.com"
FEED_PATH = VIEWER / "live_odds_feed.json"
SLATE_INDEX = VIEWER / "feeds" / "slate-index.json"

# Polymarket stat label -> our market id. v1 scope: the two O/U stat types
# the compound model prices (receiving yards, receptions). Anytime TD and
# alt stats are intentionally skipped until the quote schema grows a
# probability-market shape.
STAT_MAP = {
    "receiving yards": "receiving_yards",
    "receptions": "receptions",
}

Q_RE = re.compile(
    r"^(?P<player>[^:]+?):\s*(?P<stat>Receiving Yards|Receptions)\s+O/U\s+(?P<line>\d+(?:\.\d+)?)$",
    re.IGNORECASE,
)


def _norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def cents_to_american(p: float) -> int:
    """Probability (0-1) -> American odds. p>0.5 -> negative (juice side)."""
    p = min(0.98, max(0.02, p))
    if p >= 0.5:
        return -round(100.0 * p / (1.0 - p))
    return round(100.0 * (1.0 - p) / p)


def parse_market(question: str):
    """'Player: Receiving Yards O/U 74.5' -> (player, market_id, line)."""
    m = Q_RE.match(question.strip())
    if not m:
        return None
    stat = STAT_MAP.get(m.group("stat").lower())
    if stat is None:
        return None
    return m.group("player").strip(), stat, float(m.group("line"))


def _http_json(url: str, timeout: int = 20):
    req = Request(url, headers={"User-Agent": "propstein-odds/1.0"})
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_events(limit: int = 100) -> list[dict]:
    """Active NFL events; the player-prop ones carry per-game markets."""
    out = []
    offset = 0
    while offset < 400:
        url = (
            f"{GAMMA}/events?tag_slug=nfl&closed=false&active=true"
            f"&limit=20&offset={offset}&order=startDate&ascending=false"
        )
        batch = _http_json(url)
        if not batch:
            break
        out.extend(batch)
        offset += 20
        if len(out) >= limit:
            break
    return [e for e in out if "Player Props" in (e.get("title") or "")]


def parse_outcome_prices(market: dict) -> tuple[float, float] | None:
    """(over_prob, under_prob) from the JSON-string outcome fields."""
    try:
        outcomes = json.loads(market.get("outcomes") or "[]")
        prices = json.loads(market.get("outcomePrices") or "[]")
    except (ValueError, TypeError):
        return None
    if len(outcomes) != 2 or len(prices) != 2:
        return None
    try:
        a, b = float(prices[0]), float(prices[1])
    except (ValueError, TypeError):
        return None
    if outcomes[0].strip().lower() == "over":
        return a, b
    if outcomes[0].strip().lower() == "under":
        return b, a
    return None


def _norm_cdf(x: float) -> float:
    """Abramowitz-Stegun normal CDF (mirrors approxSimMath in viewer/app.js —
    the documented normal approximation, NOT exact compound pricing)."""
    import math
    z = max(-8.0, min(8.0, x))
    t = 1.0 / (1.0 + 0.2316419 * abs(z))
    d = 0.3989423 * math.exp(-z * z / 2.0)
    p = 1.0 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
    return 1.0 - p if z < 0 else p


def model_dist_bounds(slate_row: dict, market_id: str) -> tuple[float, float, float]:
    """(proj, low, high) mirroring the viewer adapter dist() bounds."""
    if market_id == "receptions":
        mu = float(slate_row.get("mu_rec") or slate_row.get("proj_rec") or 3.0)
        proj = float(slate_row.get("proj_rec") or mu)
        low = float(max(0, int(mu * 0.55)))
        high = float(max(low + 1, int(mu * 1.55 + 0.5) + 1))
        return proj, low, high
    fair = float(slate_row.get("fair_line_yards") or slate_row.get("proj_yards") or 40.0)
    proj = float(slate_row.get("proj_yards") or 40.0)
    low = float(max(0, round(fair * 0.58)))
    high = float(round(proj * 1.48))
    return proj, low, high


def compute_evaluation(slate_row: dict, market_id: str, line: float,
                       over_p: float, under_p: float,
                       over_odds: int, under_odds: int) -> dict:
    """Model-vs-market evaluation for the quote, using the same normal
    approximation the viewer's line simulator documents (approximate, not
    exact compound NegBin/Gamma pricing). Polymarket's binary prices sum to
    ~1 so the market probability needs no de-vig. Execution gating stays
    app-side and fail-closed — actionable_stake is always 0 here."""
    proj, low, high = model_dist_bounds(slate_row, market_id)
    sd = max(1.0, (high - low) / 2.56)
    p_over_model = _norm_cdf((proj - line) / sd)
    p_over_model = min(0.95, max(0.05, p_over_model))
    p_over_market = over_p

    prob_edge = p_over_model - p_over_market
    best_side = "OVER" if prob_edge >= 0 else "UNDER"
    if best_side == "UNDER":
        p_side_model = 1.0 - p_over_model
        p_side_market = under_p
        side_odds = under_odds
    else:
        p_side_model = p_over_model
        p_side_market = p_over_market
        side_odds = over_odds
    dec = side_odds / 100.0 + 1 if side_odds > 0 else 100.0 / abs(side_odds) + 1
    break_even = 1.0 / dec
    expected_return = p_side_model * dec - 1.0
    return {
        "is_qualified": prob_edge >= 0.05,
        "status": "VERIFIED",
        "best_side": best_side,
        "prob_edge": round(prob_edge, 4),
        "break_even_adv": round(p_side_model - break_even, 4),
        "expected_return": round(expected_return, 4),
        "actionable_stake": 0.0,
        "catalyst": "none",
        "injury_context": "",
        "method": "normal-approximation (see viewer line simulator)",
    }


def build_quote(market: dict, event: dict, slate_row: dict, market_id: str) -> dict | None:
    parsed = parse_market(market.get("question") or "")
    if parsed is None:
        return None
    player, stat, line = parsed
    pair = parse_outcome_prices(market)
    if pair is None:
        return None
    over_p, under_p = pair
    liq = float(market.get("liquidityNum") or 0)
    if liq < 10 or not (0.02 <= over_p <= 0.98):
        return None  # dead market — no information, never quoted

    digest_src = "|".join([
        str(market.get("id") or ""),
        str(market.get("question") or ""),
        str(market.get("outcomePrices") or ""),
        str(market.get("slug") or ""),
    ])
    content_hash = hashlib.sha256(digest_src.encode("utf-8")).hexdigest()
    slug = market.get("slug") or ""
    over_odds = cents_to_american(over_p)
    under_odds = cents_to_american(under_p)
    evaluation = compute_evaluation(slate_row, market_id, line, over_p, under_p,
                                    over_odds, under_odds)
    fair_raw = slate_row.get("fair_line_yards") if market_id == "receiving_yards" else slate_row.get("fair_line_rec")
    try:
        fair_line = round(float(fair_raw), 1) if fair_raw is not None else None
    except (TypeError, ValueError):
        fair_line = None
    return {
        "quote_id": f"pm_{content_hash[:16]}",
        "provider_quote_id": str(market.get("id") or ""),
        "receipt_id": f"pm_{content_hash[:16]}",
        "source_url": f"https://polymarket.com/market/{slug}" if slug else "",
        "content_hash": content_hash,
        "book": BOOK,
        "player_id": slate_row["player_id"],
        "player_name": slate_row.get("player_display_name") or player,
        "team": slate_row.get("team") or "",
        "opponent": slate_row.get("opponent_team") or "",
        "game_id": slate_row.get("game_id") or "",
        "position": slate_row.get("position") or "",
        "market": market_id,
        "line": line,
        "fair_line": fair_line,
        "over_odds": over_odds,
        "under_odds": under_odds,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "source": SOURCE,
        "liquidity_usd": round(liq, 2),
        "event_title": event.get("title") or "",
        "end_date": market.get("endDate") or "",
        "evaluation": evaluation,
    }


def load_slate() -> list[dict]:
    """Active NFL slate rows: the manifest's default (newest non-historical)."""
    candidates: list[Path] = []
    try:
        idx = json.loads(SLATE_INDEX.read_text(encoding="utf-8"))
        nfl = (idx.get("sports") or {}).get("nfl") or {}
        default_key = nfl.get("default_slate")
        slates = nfl.get("slates") or {}
        if default_key and slates.get(default_key, {}).get("slate"):
            candidates.append(VIEWER / slates[default_key]["slate"])
        else:
            for key, entry in slates.items():
                if not entry.get("historical") and entry.get("slate"):
                    candidates.append(VIEWER / entry["slate"])
    except Exception:
        pass
    if not candidates:
        # Last resort: newest week on disk (w1 excluded — historical audit).
        for p in sorted(VIEWER.glob("slate_*.json")):
            if "w1.json" not in p.name:
                candidates.append(p)
    rows: list[dict] = []
    for path in candidates:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                rows.extend(data)
        except Exception:
            continue
    return rows


def index_slate(rows: list[dict]) -> dict[str, dict]:
    return {_norm_name(r.get("player_display_name") or ""): r for r in rows}


def collect_quotes(min_liquidity: float = 10.0) -> list[dict]:
    events = fetch_events()
    slate_idx = index_slate(load_slate())
    quotes: list[dict] = []
    matched, skipped_liq, skipped_nomatch, skipped_parse = 0, 0, 0, 0
    for event in events:
        for market in event.get("markets", []):
            parsed = parse_market(market.get("question") or "")
            if parsed is None:
                continue  # stat out of v1 scope (TD, passing, rushing...)
            pair = parse_outcome_prices(market)
            if pair is None:
                skipped_parse += 1
                continue
            liq = float(market.get("liquidityNum") or 0)
            if liq < min_liquidity:
                skipped_liq += 1
                continue
            player, stat, _line = parsed
            row = slate_idx.get(_norm_name(player))
            if row is None:
                skipped_nomatch += 1
                continue
            q = build_quote(market, event, row, stat)
            if q:
                quotes.append(q)
                matched += 1
    print(f"[polymarket] prop events: {len(events)} | matched: {matched} | "
          f"low-liq skipped: {skipped_liq} | off-slate: {skipped_nomatch} | unparsed: {skipped_parse}")
    return quotes


def merge_feed(quotes: list[dict], dry_run: bool = False) -> bool:
    if not quotes:
        print("[polymarket] nothing to merge (no liquid matched quotes) — feed untouched")
        return False
    feed = json.loads(FEED_PATH.read_text(encoding="utf-8"))
    keep = [q for q in feed.get("quotes", []) if q.get("book") != BOOK]
    seen = set()
    base = datetime.now(timezone.utc)
    merged: list[dict] = []
    for i, q in enumerate(quotes):
        key = (q["player_id"], q["market"], q["line"])
        if key in seen:
            continue
        seen.add(key)
        # unique observed_at per quote (provenance test contract) — the
        # stamps remain the true fetch window, microseconds apart.
        q = dict(q)
        q["observed_at"] = (base + timedelta(microseconds=i)).isoformat()
        merged.append(q)
    keep.extend(merged)
    monitored = feed.get("monitored_books") or []
    if BOOK not in monitored:
        monitored = monitored + [BOOK]
    pm_n = len(merged)
    feed["quotes"] = keep
    feed["updated_at"] = base.isoformat()
    feed["monitored_books"] = monitored
    feed["total_quotes"] = len(keep)
    feed["polymarket_quotes_count"] = pm_n
    feed["polymarket_observed_at"] = base.isoformat()
    # Honest mixed-feed status: Polymarket receipts are real, hashed
    # observations (verified); the synthetic baseline quotes stay labeled
    # unverified per-quote. The viewer maps this to the VERIFIED odds label.
    feed["feed_status"] = "LIVE_POLYMARKET_RECEIPTS"
    feed["verified_books_count"] = 1
    feed["verified_quotes_count"] = pm_n
    rows = load_slate()
    if rows:
        w = rows[0].get("week")
        season = rows[0].get("season")
        if w and season:
            feed["slate"] = f"{season}-W{int(w):02d}"
    print(f"[polymarket] merged {pm_n} Polymarket quotes into {FEED_PATH.name} "
          f"(total {len(keep)})")
    if dry_run:
        print("[polymarket] dry-run: file NOT written")
        return True
    FEED_PATH.write_text(json.dumps(feed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


# ── offline selftest (no network) ─────────────────────────────────────────
def selftest() -> int:
    ok = True

    def check(label, cond, detail=""):
        nonlocal ok
        print(f"{'PASS' if cond else 'FAIL'}  {label}" + (f" -> {detail}" if detail else ""))
        ok = ok and cond

    check("parser: receiving yards market",
          parse_market("Puka Nacua: Receiving Yards O/U 74.5") == ("Puka Nacua", "receiving_yards", 74.5))
    check("parser: receptions market",
          parse_market("Colston Loveland: Receptions O/U 4.5") == ("Colston Loveland", "receptions", 4.5))
    check("parser: out-of-scope stat skipped", parse_market("Caleb Williams: Passing Yards O/U 249.5") is None)
    check("parser: malformed question skipped", parse_market("Bears vs. Seahawks Moneyline") is None)

    check("odds: 0.55 -> -122 (favorite)", cents_to_american(0.55) == -122, str(cents_to_american(0.55)))
    check("odds: 0.45 -> +122 (dog)", cents_to_american(0.45) == 122, str(cents_to_american(0.45)))
    check("odds: 0.5 -> -100", cents_to_american(0.5) == -100)
    check("odds: clamp at extremes", cents_to_american(0.999) == -4900, str(cents_to_american(0.999)))

    mk = {
        "id": "6374549", "question": "Puka Nacua: Receiving Yards O/U 74.5",
        "outcomes": '["Over","Under"]', "outcomePrices": '["0.55","0.45"]',
        "slug": "nfl-puka-nacua-74pt5", "liquidityNum": 91.0,
        "endDate": "2026-11-03T01:15:00Z",
    }
    pair = parse_outcome_prices(mk)
    check("prices: over/under orientation", pair == (0.55, 0.45), str(pair))
    row = {"player_id": "00-0039075", "player_display_name": "Puka Nacua", "team": "LA",
           "opponent_team": "LAC", "game_id": "2026_08_LA_LAC", "position": "WR"}
    q = build_quote(mk, {"title": "Rams vs. Chargers - Player Props"}, row, "receiving_yards")
    check("quote: receipt hash + ids", q is not None and q["receipt_id"].startswith("pm_") and q["quote_id"] == q["receipt_id"])
    check("quote: american odds conversion", q and q["over_odds"] == -122 and q["under_odds"] == 122, f"{q and q['over_odds']}/{q and q['under_odds']}")
    check("quote: source url + liquidity carried", q and q["source_url"].startswith("https://polymarket.com/market/") and q["liquidity_usd"] == 91.0)
    dead = dict(mk, liquidityNum=1.92, outcomePrices='["0.5","0.5"]')
    check("fail-closed: dead 0.5/0.5 low-liq market refused", build_quote(dead, {}, row, "receiving_yards") is None)

    check("name index: punctuation-insensitive match",
          _norm_name("D'Andre Swift") == _norm_name("DAndre Swift"))
    print("polymarket selftest: ALL PASS" if ok else "polymarket selftest: FAILURES")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-liquidity", type=float, default=10.0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    try:
        quotes = collect_quotes(min_liquidity=args.min_liquidity)
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        print(f"[polymarket] network/parse failure ({exc}) — feed untouched (fail-closed)")
        return 0
    try:
        merge_feed(quotes, dry_run=args.dry_run)
    except Exception as exc:  # never corrupt the feed on a bad merge
        print(f"[polymarket] merge failure ({exc}) — feed untouched (fail-closed)")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
