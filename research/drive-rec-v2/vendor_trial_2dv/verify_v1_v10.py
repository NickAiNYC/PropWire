"""verify_v1_v10.py — Decision 2D-V trial verification checks V1-V10.

Consumes the raw acquisition directory produced by fetch_trial_quotes.py
(real vendor pull OR dry-run fixtures — identical layout), the precommitted
sample manifest, and independent settlement statistics, then emits one
structured evidence JSON per check, a checks summary, a canonical-schema
preview of the quotes, and the human-readable TRIAL_REPORT.md that is the
Decision 2D-V deliverable skeleton.

Acceptance rule (Decision 2D review, 2026-10-30): ANY critical failure blocks
the full 392-game acquisition until resolved. V8 (written commercial
permission) is MANUAL evidence; absence leaves the trial BLOCKED, which also
blocks acquisition.

Determinism: evidence JSONs contain no wall-clock timestamps and all lists
are sorted, so re-running on the same raw directory is byte-identical (the
selftest asserts this).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
DRIVE = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(DRIVE / "decision_2d"))

from credit_meter import load_config, ledger_summary  # noqa: E402
from fetch_trial_quotes import TEAM_NAMES, norm_team  # noqa: E402

PASS, FAIL, PENDING_MANUAL = "PASS", "FAIL", "PENDING_MANUAL"

EVIDENCE_FILES = {
    "V1": "v01_availability.json",
    "V2": "v02_timestamps.json",
    "V3": "v03_market_identification.json",
    "V4": "v04_bookmaker_identity.json",
    "V5": "v05_price_integrity.json",
    "V6": "v06_missingness.json",
    "V7": "v07_settlement.json",
    "V8": "v08_commercial_rights.json",
    "V9": "v09_cost.json",
    "V10": "v10_reproducibility.json",
}


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def decimal_of(american: float) -> float:
    return 1.0 + (100.0 / abs(american) if american < 0 else american / 100.0)


def settle(line: float, yards: float) -> str:
    if yards > line:
        return "over"
    if yards < line:
        return "under"
    return "push"


def norm_name(s: str) -> str:
    return norm_team(s)


class Trial:
    """Loads a raw acquisition directory into indexed structures."""

    def __init__(self, data_dir: Path, sample_manifest: Path, stats_arg: str):
        self.dir = data_dir
        self.sample = json.loads(sample_manifest.read_text())
        self.games = {g["game_id"]: g for g in self.sample["games"]}
        self.raw_manifest = json.loads((data_dir / "manifest.json").read_text())
        self.data_label = self.raw_manifest.get("data_label", "UNKNOWN")
        self.synthetic = self.data_label != "REAL_VENDOR_RESPONSES"
        self.cfg = load_config()
        # event-ID map actually used by the acquisition run (defect-1 fix:
        # copied byte-for-byte into the run directory by fetch_trial_quotes)
        map_path = data_dir / "event_id_map.json"
        self.event_map = (json.loads(map_path.read_text())
                          if map_path.exists() else None)
        self.ledger = [json.loads(line) for line in
                       (data_dir / "credit_ledger.jsonl").read_text().splitlines()
                       if line.strip()]
        self.responses: dict[tuple, dict] = {}
        for meta_path in sorted((data_dir / "responses").glob("*.meta.json")):
            meta = json.loads(meta_path.read_text())
            resp_path = meta_path.parent / meta_path.name[:-len(".meta.json")]
            try:
                doc = json.loads(resp_path.read_text())
            except (json.JSONDecodeError, OSError):
                doc = None
            self.responses[(meta["game_id"], meta["offset_label"])] = {
                "meta": meta, "doc": doc, "path": resp_path}
        self.stats = (self._stats_from_pbp() if stats_arg == "auto"
                      else self._stats_from_csv(stats_arg))
        # normalized (game, player) -> yards, for name-robust joins
        self._stats_norm = {
            (norm_name(g), norm_name(p)): float(y)
            for g, p, y in zip(self.stats.game_id, self.stats.player_name,
                               self.stats.receiving_yards)}

    def _stats_from_csv(self, path: str) -> pd.DataFrame:
        df = pd.read_csv(path)
        need = {"game_id", "player_name", "receiving_yards"}
        missing = need - set(df.columns)
        if missing:
            raise SystemExit(f"stats file missing columns: {sorted(missing)}")
        return df

    def _stats_from_pbp(self) -> pd.DataFrame:
        """Real mode: receiving yards from nflverse play-by-play via the frozen
        decision_2d settlement module; gsis ids resolved to names through
        data/players.csv so vendor player descriptions can be joined."""
        from settlement import receiving_yards_by_game  # decision_2d package
        frames = []
        for season in sorted({g["season"] for g in self.sample["games"]}):
            pbp = pd.read_parquet(DRIVE / "data" / f"play_by_play_{season}.parquet")
            ids = [g["game_id"] for g in self.sample["games"]
                   if g["season"] == season]
            frames.append(receiving_yards_by_game(pbp.loc[pbp.game_id.isin(ids)]))
        yards = pd.concat(frames, ignore_index=True)
        players = pd.read_csv(DRIVE / "data" / "players.csv",
                              usecols=["gsis_id", "display_name"])
        yards = yards.merge(players, left_on="player_id",
                            right_on="gsis_id", how="left")
        unresolved = yards.display_name.isna().sum()
        if unresolved:
            raise SystemExit(f"{unresolved} pbp receivers could not be resolved "
                             "to names via players.csv — stats path broken")
        return yards[["game_id", "display_name", "receiving_yards"]].rename(
            columns={"display_name": "player_name"})

    def yards_for(self, game_id: str, player_name: str) -> float | None:
        return self._stats_norm.get((norm_name(game_id), norm_name(player_name)))

    def iter_quotes(self):
        """Yield (game, offset_label, meta, doc, book, market, outcome)."""
        for (gid, off) in sorted(self.responses):
            entry = self.responses[(gid, off)]
            meta, doc = entry["meta"], entry["doc"]
            game = self.games.get(gid)
            if doc is None or game is None:
                continue
            for book in doc.get("bookmakers", []) or []:
                for mkt in book.get("markets", []) or []:
                    for out in mkt.get("outcomes", []) or []:
                        yield game, off, meta, doc, book, mkt, out


# ----------------------------------------------------------------------
# Checks V1-V10: each returns {"check","title","status","summary",...}
# ----------------------------------------------------------------------

def v1_availability(t: Trial) -> dict:
    rows, fails = [], []
    for gid in sorted(t.games):
        game = t.games[gid]
        per_time = {}
        for off in t.cfg["observation_offsets_minutes"]:
            entry = t.responses.get((gid, off))
            if entry is None or entry["doc"] is None \
                    or entry["meta"].get("http_status") != 200:
                per_time[off] = {"http_status": (entry or {}).get(
                    "meta", {}).get("http_status"), "n_books": 0, "n_players": 0}
                continue
            doc = entry["doc"]
            players, n_books = set(), 0
            for b in doc.get("bookmakers", []) or []:
                for m in b.get("markets", []) or []:
                    mkey = m.get("key") or ""
                    if "receiving" in mkey or "reception_yds" in mkey:
                        n_books += 1
                        players.update((o.get("description") or "").strip()
                                       for o in m.get("outcomes", []))
                        break
            per_time[off] = {"http_status": 200, "n_books": n_books,
                             "n_players": len(players)}
        max_players = max((v["n_players"] for v in per_time.values()), default=0)
        if not any(v["n_books"] > 0 for v in per_time.values()):
            fails.append(f"{gid}: no receiving-yards market at any observation time")
        rows.append({"game_id": gid, "season": game["season"],
                     "week": game["week"], "per_time": per_time,
                     "max_players_priced": max_players,
                     "low_player_count": max_players < t.cfg["min_players_per_game"]})
    seasons_ok = {r["season"] for r in rows if r["max_players_priced"] > 0}
    if not {2025, 2026}.issubset(seasons_ok):
        fails.append(f"seasons with receiving props {sorted(seasons_ok)} — "
                     "need both 2025 and 2026")
    return {"check": "V1", "title": "Historical availability",
            "status": FAIL if fails else PASS,
            "summary": (f"{len(rows)} sampled games; receiving-yards props "
                        f"observed for seasons {sorted(seasons_ok)}"),
            "failures": fails,
            "games": rows,
            "discovery_misses": t.raw_manifest.get("discovery_misses", []),
            "requirement": "Actual NFL receiving-yards props returned for 2025 and 2026"}


def v2_timestamps(t: Trial) -> dict:
    violations, lags = [], []
    for (gid, off) in sorted(t.responses):
        meta, doc = t.responses[(gid, off)]["meta"], t.responses[(gid, off)]["doc"]
        if doc is None:
            violations.append(f"{gid}@{off}: unparseable response")
            continue
        decision_ts = parse_ts(meta["decision_ts_utc"])
        snap = datetime.fromtimestamp(doc.get("timestamp", 0), tz=timezone.utc)
        lag = (decision_ts - snap).total_seconds()
        lags.append({"game_id": gid, "offset": off, "snapshot_lag_s": lag})
        if snap > decision_ts:
            violations.append(
                f"{gid}@{off}: snapshot exceeds decision ts by {abs(lag):.0f}s "
                f"(snapshot {snap.isoformat()}, decision {decision_ts.isoformat()})")
        prev, nxt = doc.get("previous_timestamp"), doc.get("next_timestamp")
        if prev is not None and not prev < doc.get("timestamp", -1):
            violations.append(f"{gid}@{off}: previous_timestamp not before timestamp")
        if nxt is not None and not nxt > doc.get("timestamp", -1):
            violations.append(f"{gid}@{off}: next_timestamp not after timestamp")
        tol = t.cfg["book_last_update_tolerance_seconds"]
        for b in doc.get("bookmakers", []) or []:
            lu = datetime.fromtimestamp(b.get("last_update", 0), tz=timezone.utc)
            if lu > snap + timedelta(seconds=tol):
                violations.append(
                    f"{gid}@{off}:{b.get('key')} last_update after snapshot +{tol}s")
    lag_vals = [l["snapshot_lag_s"] for l in lags]
    med = sorted(lag_vals)[len(lag_vals) // 2] if lag_vals else 0
    return {"check": "V2", "title": "Timestamp integrity",
            "status": FAIL if violations else PASS,
            "summary": (f"{len(lags)} responses; snapshot lag min/median/max = "
                        f"{min(lag_vals):.0f}/{med:.0f}/{max(lag_vals):.0f}s "
                        "(positive = snapshot BEFORE decision ts)"),
            "violations": violations,
            "lags": lags,
            "requirement": "Snapshot timestamp never exceeds decision timestamp"}


def v3_market_identification(t: Trial) -> dict:
    violations, observed = [], []
    # --- event-ID map provenance (owner defect-1 fix, 2026-10-30): every
    # sampled game needs a verified map entry whose discovery SOURCE and
    # TIMESTAMP are recorded; response event ids must trace to the map. ---
    entries = ({e.get("game_id"): e
                for e in (t.event_map or {}).get("entries", [])}
               if t.event_map else {})
    if t.event_map is None:
        violations.append("event_id_map.json missing from the run directory "
                          "(discovery provenance unverifiable)")
    tol_h = t.cfg["commence_vs_schedule_tolerance_hours"]
    for gid in sorted(t.games):
        game = t.games[gid]
        e = entries.get(gid)
        if e is None:
            violations.append(f"{gid}: no event_id_map entry (discovery "
                              "provenance missing)")
            continue
        if not e.get("event_id"):
            violations.append(f"{gid}: event_id_map entry has null event_id")
        if e.get("status") != "verified":
            violations.append(f"{gid}: event_id_map entry status "
                              f"{e.get('status')!r} != 'verified'")
        if not str(e.get("discovery_source") or "").strip():
            violations.append(f"{gid}: discovery_source missing (owner "
                              "requirement: record the discovery source)")
        ts = e.get("discovery_timestamp_utc")
        ts_ok = isinstance(ts, str) and ts.strip()
        if ts_ok:
            try:
                parse_ts(ts)
            except ValueError:
                ts_ok = False
        if not ts_ok:
            violations.append(f"{gid}: discovery_timestamp_utc missing or "
                              f"invalid ({ts!r}) (owner requirement: record "
                              "the discovery timestamp)")
        cv = e.get("commence_time_verified")
        if not cv:
            violations.append(f"{gid}: commence_time_verified missing from "
                              "event_id_map entry")
        else:
            c = parse_ts(cv)
            gameday = datetime.strptime(game["gameday"], "%Y-%m-%d").replace(
                tzinfo=timezone.utc)
            if not (gameday - timedelta(hours=tol_h)
                    <= c <= gameday + timedelta(hours=36)):
                violations.append(
                    f"{gid}: map commence_time_verified {cv} outside schedule "
                    f"window around {game['gameday']}")
    for (gid, off) in sorted(t.responses):
        meta, doc = t.responses[(gid, off)]["meta"], t.responses[(gid, off)]["doc"]
        game = t.games.get(gid)
        if game is None or doc is None:
            continue
        entry = entries.get(gid)
        if entry is not None and str(doc.get("game_id")) != str(entry.get("event_id")):
            violations.append(f"{gid}@{off}: response event {doc.get('game_id')} "
                              f"!= event_id_map {entry.get('event_id')}")
        if entry is not None and entry.get("commence_time_verified") \
                and doc.get("commence_time") is not None:
            if parse_ts(entry["commence_time_verified"]) != parse_ts(doc["commence_time"]):
                violations.append(f"{gid}@{off}: response commence_time "
                                  f"{doc.get('commence_time')} != map "
                                  f"{entry['commence_time_verified']}")
        if str(doc.get("game_id")) != str(meta.get("event_id")):
            violations.append(f"{gid}@{off}: response game_id {doc.get('game_id')} "
                              f"!= requested event {meta.get('event_id')}")
        commence = doc.get("commence_time")
        if commence is None:
            violations.append(f"{gid}@{off}: commence_time missing")
        else:
            c = parse_ts(commence)
            gameday = datetime.strptime(game["gameday"], "%Y-%m-%d").replace(
                tzinfo=timezone.utc)
            if not (gameday - timedelta(hours=t.cfg["commence_vs_schedule_tolerance_hours"])
                    <= c <= gameday + timedelta(hours=36)):
                violations.append(
                    f"{gid}@{off}: commence_time {commence} outside schedule "
                    f"window around {game['gameday']}")
        for field in ("home_team", "away_team"):
            want = norm_team(TEAM_NAMES.get(game[field], game[field]))
            got = norm_team(doc.get(field, ""))
            if want != got:
                violations.append(f"{gid}@{off}: {field} {doc.get(field)} "
                                  f"!= schedule {game[field]}")
        requested_market = (meta.get("params") or {}).get("markets")
        for b in doc.get("bookmakers", []) or []:
            for m in b.get("markets", []) or []:
                if m.get("key") != requested_market:
                    violations.append(
                        f"{gid}@{off}:{b.get('key')} market {m.get('key')} "
                        f"!= requested {requested_market}")
                for o in m.get("outcomes", []) or []:
                    desc = (o.get("description") or "").strip()
                    if not desc:
                        violations.append(
                            f"{gid}@{off}:{b.get('key')} empty player description")
                    point = o.get("point")
                    lo, hi = t.cfg["line_range"]
                    if not isinstance(point, (int, float)) or not (lo <= point <= hi):
                        violations.append(
                            f"{gid}@{off}:{b.get('key')} player {desc!r} line "
                            f"{point} outside plausible range [{lo}, {hi}]")
                    if o.get("label") not in ("Over", "Under"):
                        violations.append(
                            f"{gid}@{off}:{b.get('key')} player {desc!r} label "
                            f"{o.get('label')!r} not Over/Under")
        observed.append({"game_id": gid, "offset": off,
                         "commence_time": commence,
                         "home": doc.get("home_team"), "away": doc.get("away_team"),
                         "event_id": meta.get("event_id")})
    return {"check": "V3", "title": "Market identification",
            "status": FAIL if violations else PASS,
            "summary": (f"{len(observed)} responses checked for player/team/game/"
                        "line/over-under identification + event-ID map "
                        f"provenance ({len(entries)} map entries)"),
            "violations": violations[:50],
            "n_violations": len(violations),
            "observed": observed,
            "requirement": ("Correct player, team, game, line, and over/under, "
                            "traced to a verified event-ID map whose discovery "
                            "source and timestamp are recorded")}


def v4_bookmaker_identity(t: Trial) -> dict:
    violations, per_game = [], []
    for gid in sorted(t.games):
        key_titles: dict[str, set] = {}
        title_keys: dict[str, set] = {}
        for off in t.cfg["observation_offsets_minutes"]:
            entry = t.responses.get((gid, off))
            if entry is None or entry["doc"] is None:
                continue
            for b in entry["doc"].get("bookmakers", []) or []:
                key_titles.setdefault(b.get("key"), set()).add(b.get("title"))
                title_keys.setdefault(b.get("title"), set()).add(b.get("key"))
        for key, titles in key_titles.items():
            if len(titles) > 1:
                violations.append(
                    f"{gid}: book key {key} maps to titles {sorted(titles)}")
        for title, keys in title_keys.items():
            if len(keys) > 1:
                violations.append(
                    f"{gid}: book title {title!r} maps to keys {sorted(keys)}")
        per_game.append({"game_id": gid, "books": sorted(key_titles),
                         "n_books": len(key_titles)})
    return {"check": "V4", "title": "Sportsbook identity",
            "status": FAIL if violations else PASS,
            "summary": (f"bookmaker key/title stability across observation times; "
                        f"{sum(p['n_books'] for p in per_game)} book-game slots"),
            "violations": violations,
            "per_game": per_game,
            "requirement": "Stable bookmaker identifiers across observations"}


def v5_price_integrity(t: Trial) -> dict:
    violations, vig_rows = [], []
    pairs = 0
    min_mag = t.cfg["american_odds_min_magnitude"]
    for game, off, meta, doc, book, mkt, out in t.iter_quotes():
        gid = game["game_id"]
        desc, side, price = out.get("description"), out.get("label"), out.get("price")
        if not isinstance(price, (int, float)) or abs(price) < min_mag:
            violations.append(f"{gid}@{off}:{book.get('key')}:{desc} {side} "
                              f"american price {price} invalid")
            continue
        pairs += 1
        if "price_decimal" in out:
            dec_provided = float(out["price_decimal"])
            dec_computed = decimal_of(price)
            if abs(dec_provided - dec_computed) > 1e-3:
                violations.append(
                    f"{gid}@{off}:{book.get('key')}:{desc} {side} decimal "
                    f"{dec_provided} != american {price} -> {dec_computed:.4f}")
    seen: dict[tuple, dict] = {}
    for game, off, meta, doc, book, mkt, out in t.iter_quotes():
        key = (game["game_id"], off, book.get("key"), out.get("description"),
               out.get("point"))
        seen.setdefault(key, {})[out.get("label")] = out
    for key, sides in sorted(seen.items(), key=lambda kv: str(kv[0])):
        if "Over" not in sides or "Under" not in sides:
            violations.append(f"{key}: only sides {sorted(sides)} priced (need both)")
            continue
        po = decimal_of(sides["Over"]["price"])
        pu = decimal_of(sides["Under"]["price"])
        implied_sum = 1 / po + 1 / pu
        vig_rows.append({"key": str(key), "implied_sum": round(implied_sum, 4),
                         "vig_pp": round((implied_sum - 1) * 100, 2)})
        if implied_sum <= 1.0:
            violations.append(
                f"{key}: implied probability sum {implied_sum:.4f} <= 1 "
                "(negative vig — mispriced or misparsed market)")
    vigs = [v["vig_pp"] for v in vig_rows]
    summary = (f"{pairs} outcome prices validated; {len(vig_rows)} two-sided "
               f"markets; vig mean {sum(vigs) / len(vigs):.2f}pp "
               f"(min {min(vigs):.2f}, max {max(vigs):.2f})" if vigs else
               f"{pairs} outcome prices validated; no complete two-sided markets")
    return {"check": "V5", "title": "Price integrity",
            "status": FAIL if violations else PASS,
            "summary": summary,
            "violations": violations[:50],
            "n_violations": len(violations),
            "vig_rows": vig_rows[:200],
            "requirement": "Both sides, American odds, and decimal conversion validated"}


def v6_missingness(t: Trial, out_dir: Path) -> dict:
    offsets = list(t.cfg["observation_offsets_minutes"])
    rows, pulled = [], []
    for gid in sorted(t.games):
        # book -> players, per observation time
        by_time: dict[str, dict[str, set]] = {off: {} for off in offsets}
        for off in offsets:
            entry = t.responses.get((gid, off))
            doc = entry["doc"] if entry else None
            if not doc:
                continue
            for b in doc.get("bookmakers", []) or []:
                for m in b.get("markets", []) or []:
                    mkey = m.get("key") or ""
                    if "receiving" in mkey or "reception_yds" in mkey:
                        by_time[off][b.get("key")] = {
                            (o.get("description") or "").strip()
                            for o in m.get("outcomes", [])}
                        break
        present_books = set().union(*[set(by_time[off]) for off in offsets]) \
            if any(by_time.values() for off in offsets) else set()
        for off in offsets:
            for bk in sorted(present_books):
                rows.append({"game_id": gid, "offset": off, "bookmaker": bk,
                             "present": bk in by_time[off],
                             "n_players": len(by_time[off].get(bk, set()))})
        for bk in sorted(present_books):
            for player in sorted(set().union(
                    *[by_time[off].get(bk, set()) for off in offsets])):
                seen = [off for off in offsets if player in by_time[off].get(bk, set())]
                first_idx = min(offsets.index(off) for off in seen) if seen else None
                missing_after = [off for off in offsets
                                 if off not in seen
                                 and offsets.index(off) > first_idx]
                if missing_after:
                    pulled.append({"game_id": gid, "bookmaker": bk, "player": player,
                                   "observed_at": seen, "missing_at": missing_after})
    ledger_path = out_dir / "missingness_ledger.csv"
    with ledger_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["game_id", "offset", "bookmaker",
                                          "present", "n_players"])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    pulled_path = out_dir / "pulled_lines.csv"
    with pulled_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["game_id", "bookmaker", "player",
                                          "observed_at", "missing_at"])
        w.writeheader()
        for r in pulled:
            w.writerow({**r, "observed_at": ";".join(r["observed_at"]),
                        "missing_at": ";".join(r["missing_at"])})
    complete = len(rows) > 0
    return {"check": "V6", "title": "Missingness",
            "status": PASS if complete else FAIL,
            "summary": (f"{len(rows)} game x time x book ledger rows "
                        f"(missingness_ledger.csv); {len(pulled)} pulled/absent "
                        f"player-line entries (pulled_lines.csv); "
                        f"{len(t.raw_manifest.get('discovery_misses', []))} "
                        "discovery misses"),
            "ledger_path": str(ledger_path),
            "pulled_path": str(pulled_path),
            "n_ledger_rows": len(rows),
            "n_absent_book_slots": sum(1 for r in rows if not r["present"]),
            "n_pulled_lines": len(pulled),
            "pulled_lines": pulled[:50],
            "discovery_misses": t.raw_manifest.get("discovery_misses", []),
            "requirement": "Missing players, markets, and books explicitly recorded"}


def v7_settlement(t: Trial, out_dir: Path) -> dict:
    """Settlement reconciliation against independent statistics.

    Every priced player must resolve in the independent stats (identification
    integrity). Outcomes settle on the FINAL observed line; pushes counted;
    any vendor-provided `settlement` field must agree with the independent
    computation.
    """
    violations, rows = [], []
    final_line: dict[tuple, tuple] = {}
    settlement_fields: dict[tuple, str] = {}
    offs_order = list(t.cfg["observation_offsets_minutes"])
    for game, off, meta, doc, book, mkt, out in t.iter_quotes():
        key = (game["game_id"], (out.get("description") or "").strip())
        idx = offs_order.index(off)
        cur = final_line.get(key)
        if cur is None or idx > cur[0]:
            final_line[key] = (idx, out.get("point"))
        if "settlement" in out and out.get("label") == "Over":
            settlement_fields[key] = str(out["settlement"])
    n_over = n_under = n_push = 0
    for (gid, player), (idx, line) in sorted(final_line.items()):
        yards = t.yards_for(gid, player)
        if yards is None:
            violations.append(f"{gid}: priced player {player!r} not found in "
                              "independent stats (identification failure)")
            continue
        outcome = settle(line, yards)
        n_over += outcome == "over"
        n_under += outcome == "under"
        n_push += outcome == "push"
        row = {"game_id": gid, "player": player, "final_line": line,
               "yards": yards, "outcome": outcome}
        if (gid, player) in settlement_fields:
            claimed = settlement_fields[(gid, player)]
            row["vendor_settlement"] = claimed
            if claimed != outcome:
                violations.append(
                    f"{gid}: {player} vendor settlement {claimed!r} contradicts "
                    f"independent stats ({outcome}; line {line}, yards {yards})")
        rows.append(row)
    stats_keys = {f"{g}|{p}" for g, p in
                  zip(t.stats.game_id, t.stats.player_name)}
    priced_keys = {f"{g}|{p}" for (g, p) in final_line}
    unpriced = sorted(stats_keys - priced_keys)
    path = out_dir / "settlement_reconciliation.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["game_id", "player", "final_line",
                                          "yards", "outcome", "vendor_settlement"])
        w.writeheader()
        for r in rows:
            w.writerow({**r, "vendor_settlement": r.get("vendor_settlement", "")})
    return {"check": "V7", "title": "Settlement",
            "status": FAIL if violations else PASS,
            "summary": (f"{len(rows)} player-games settled from independent stats "
                        f"(over {n_over} / under {n_under} / push {n_push}); "
                        f"{len(unpriced)} stats players unpriced (informational)"),
            "violations": violations,
            "n_push": n_push,
            "outcomes": {"over": n_over, "under": n_under, "push": n_push},
            "reconciliation_path": str(path),
            "unpriced_stats_players": unpriced[:50],
            "requirement": "Outcomes reconcile with independent NFL statistics"}


def v8_commercial_rights(t: Trial) -> dict:
    path = HERE / "ATTACHMENT_V8_COMMERCIAL_RIGHTS.md"
    text = path.read_text() if path.exists() else ""
    confirmed = "status: CONFIRMED" in text
    placeholders = [m for m in ("[VENDOR", "[PLAN", "[DATE", "[NAME", "[PASTE",
                                "[REQUIREMENTS", "[LIMITS]", "[NOTES",
                                "status: PENDING")
                      if m in text]
    if confirmed and not placeholders:
        return {"check": "V8", "title": "Commercial rights", "status": PASS,
                "summary": "written permission attached and accepted",
                "attachment": str(path), "placeholders_remaining": [],
                "requirement": "Written permission for intended storage, analysis, "
                               "and display",
                "note": "manual evidence accepted"}
    note = ("status marked CONFIRMED but template placeholders remain"
            if confirmed else
            "written permission not yet attached (blocking full acquisition, "
            "not a harness failure)")
    return {"check": "V8", "title": "Commercial rights", "status": PENDING_MANUAL,
            "summary": "written permission for storage, analysis, and display "
                       "NOT YET ATTACHED",
            "attachment": str(path), "placeholders_remaining": placeholders,
            "requirement": "Written permission for intended storage, analysis, "
                           "and display",
            "note": note}


def v9_cost(t: Trial) -> dict:
    """Cost reconciliation (owner defect-2 fix, 2026-10-30).

    Every metered request — baseline, discovery, retries, quote pulls — is
    reconciled from the recorded usage headers (x-requests-used cumulative
    delta, cross-checked against x-requests-last and the remaining delta).
    FAIL when: consumption could not be established on any response, headers
    disagree with each other or the recorded actuals, a null actual is not a
    tolerated open/baseline row, the measured total exceeds the cap, any
    quote pull's actual != modeled, or the run aborted on a consumption
    failure.
    """
    s = ledger_summary(t.dir / "credit_ledger.jsonl")
    cap = t.cfg["credit_budget_cap"]
    failures = []
    if s["n_unestablished"]:
        failures.append(f"{s['n_unestablished']} response(s) with consumption "
                        "UNESTABLISHED (usage headers missing/unreliable)")
    if s["n_inconsistencies"]:
        failures.append(f"{s['n_inconsistencies']} usage-header reconciliation "
                        "inconsistency(ies)")
    if s["n_null_anomalies"]:
        failures.append(f"{s['n_null_anomalies']} ledger row(s) with null "
                        "actual_credits outside tolerated open/baseline rows")
    if s["n_quote_mismatches"]:
        failures.append(f"{s['n_quote_mismatches']} quote request(s) where "
                        "actual credits != modeled (vendor headers disagree "
                        "with documented rule)")
    if s["actual_total"] > cap:
        failures.append(f"measured total {s['actual_total']} exceeds budget "
                        f"cap {cap} (baseline+discovery+retries+quotes, all "
                        "metered kinds)")
    partial_reason = t.raw_manifest.get("partial_reason")
    if partial_reason and "consumption" in str(partial_reason).lower():
        failures.append(f"run aborted on a consumption failure: {partial_reason}")
    by_kind = ", ".join(f"{k}={v}" for k, v in sorted(s["by_kind"].items())) \
        or "none"
    return {"check": "V9", "title": "Cost",
            "status": FAIL if failures else PASS,
            "summary": (f"{s['n_rows']} metered requests; measured "
                        f"{s['actual_total']} credits total ({by_kind}); "
                        f"budget cap {cap}; {s['n_quote_mismatches']} quote "
                        "actual-vs-modeled mismatches"),
            "failures": failures,
            "modeled_total": sum(r.get("modeled_credits") or 0 for r in t.ledger
                                 if r.get("request_kind") == "historical_event_odds"),
            "actual_total": s["actual_total"],
            "actual_total_by_kind": s["by_kind"],
            "n_metered_rows": s["n_rows"],
            "n_unestablished": s["n_unestablished"],
            "unestablished": s["unestablished"],
            "n_inconsistencies": s["n_inconsistencies"],
            "inconsistencies": s["inconsistencies"][:50],
            "n_null_anomalies": s["n_null_anomalies"],
            "mismatches": s["quote_mismatches"],
            "n_mismatches": s["n_quote_mismatches"],
            "partial_reason": partial_reason,
            "requirement": ("Actual credits consumed reconcile with vendor "
                            "documentation; consumption established for every "
                            "request incl. discovery and retries")}


def v10_reproducibility(t: Trial) -> dict:
    problems = []
    listed = {f["path"]: f["sha256"] for f in t.raw_manifest.get("files", [])}
    for rel, expected in sorted(listed.items()):
        p = t.dir / rel
        if not p.exists():
            problems.append(f"listed file missing: {rel}")
        elif sha256_file(p) != expected:
            problems.append(f"hash mismatch: {rel}")
    on_disk = {str(p.relative_to(t.dir)) for p in
               list((t.dir / "responses").glob("*.json"))
               + list((t.dir / "events").glob("*.json"))
               + list((t.dir / "infra").glob("*.json"))}
    orphans = sorted(on_disk - set(listed))
    if orphans:
        problems.append(f"raw files not in manifest: {orphans}")
    return {"check": "V10", "title": "Reproducibility",
            "status": FAIL if problems else PASS,
            "summary": (f"{len(listed)} manifest entries verified by SHA-256; "
                        f"{len(on_disk)} raw responses with redacted-URL metadata"),
            "problems": problems,
            "manifest_sha256": sha256_file(t.dir / "manifest.json"),
            "requirement": "Raw responses preserved with timestamps and SHA-256 hashes"}


# ----------------------------------------------------------------------

def canonical_preview(t: Trial, out_dir: Path) -> dict:
    """Map trial responses into the decision_2d canonical quote schema.

    synthetic=True for harness output — decision_2d.quotes.validate_quotes
    REFUSES such rows by design (fail-closed), so dry-run output can never
    feed the pilot. The preview validates schema invariants on a
    synthetic=False copy. player_id is provisional (player name) until the
    pilot ingestion resolves nflverse gsis ids.
    """
    rows = []
    for game, off, meta, doc, book, mkt, out in t.iter_quotes():
        if out.get("label") != "Over":
            continue
        under = next((o for o in mkt.get("outcomes", [])
                      if o.get("label") == "Under"
                      and (o.get("description") or "").strip()
                      == (out.get("description") or "").strip()
                      and o.get("point") == out.get("point")), None)
        if under is None:
            continue
        snap = datetime.fromtimestamp(doc.get("timestamp", 0), tz=timezone.utc)
        lu = datetime.fromtimestamp(book.get("last_update", 0), tz=timezone.utc)
        rows.append({
            "game_id": game["game_id"],
            "kickoff_utc": doc.get("commence_time"),
            "bookmaker": book.get("key"),
            "player_id": (out.get("description") or "").strip(),
            "player_name": (out.get("description") or "").strip(),
            "line": out.get("point"),
            "price_over_decimal": round(decimal_of(out["price"]), 4),
            "price_under_decimal": round(decimal_of(under["price"]), 4),
            "snapshot_ts_utc": snap.isoformat().replace("+00:00", "Z"),
            "book_last_update_utc": lu.isoformat().replace("+00:00", "Z"),
            "voided": False,
            "synthetic": t.synthetic,
            "source": f"trial:{t.data_label}",
        })
    df = pd.DataFrame(rows)
    path = out_dir / "trial_quotes_canonical_preview.csv"
    df.to_csv(path, index=False)
    result = {"rows": len(rows), "path": str(path)}
    try:
        from quotes import COLUMNS, validate_quotes  # decision_2d package
        if set(COLUMNS).issubset(df.columns):
            validate_quotes(df.copy().assign(synthetic=False), strict=True)
            result["schema_validation"] = "PASS (on synthetic=False copy)"
            try:
                validate_quotes(df, strict=True)
                result["synthetic_refusal"] = "NOT REFUSED — FAIL-CLOSED BROKEN"
            except Exception:
                result["synthetic_refusal"] = "REFUSED (fail-closed intact)"
        else:
            result["schema_validation"] = (
                "missing columns: "
                f"{sorted(set(COLUMNS) - set(df.columns))}")
    except Exception as e:
        result["schema_validation"] = f"FAIL: {e}"
    return result


def overall_status(checks: list[dict]) -> tuple[str, str]:
    statuses = {c["status"] for c in checks}
    if FAIL in statuses:
        return "FAIL", "critical failure(s) present — full acquisition BLOCKED"
    if PENDING_MANUAL in statuses:
        return ("BLOCKED_PENDING_MANUAL",
                "V8 written permission outstanding — full acquisition BLOCKED "
                "until attached")
    return ("PASS",
            "all automatable checks pass and manual attachment accepted — "
            "proceed to the full-acquisition decision")


def render_report(t: Trial, checks: list[dict], verdict: tuple[str, str],
                   canonical: dict, out_dir: Path) -> str:
    lines = []
    a = lines.append
    a(f"# Decision 2D-V Trial Verification Report — {t.cfg['trial_id']}")
    a("")
    a(f"- **Data label:** `{t.data_label}`"
      + ("  — SYNTHETIC HARNESS TEST, not vendor evidence" if t.synthetic else ""))
    a(f"- **Sample:** {len(t.games)} games "
      f"({sum(1 for g in t.games.values() if g['season'] == 2025)} x 2025, "
      f"{sum(1 for g in t.games.values() if g['season'] == 2026)} x 2026 w1-7)")
    a(f"- **Overall verdict:** **{verdict[0]}** — {verdict[1]}")
    a("")
    v1 = next(c for c in checks if c["check"] == "V1")
    a("## 1. Verified sample")
    a("")
    a("| game | season | week | books (max) | players priced (max) |")
    a("| --- | --- | --- | --- | --- |")
    for g in v1["games"]:
        a(f"| {g['game_id']} | {g['season']} | {g['week']} | "
          f"{max(v['n_books'] for v in g['per_time'].values())} | "
          f"{g['max_players_priced']} |")
    a("")
    v6 = next(c for c in checks if c["check"] == "V6")
    a("## 2. Coverage and missingness")
    a("")
    a(f"- ledger rows (game x time x book): **{v6['n_ledger_rows']}** "
      f"({v6['n_absent_book_slots']} absent-book slots recorded explicitly)")
    a(f"- pulled/absent player-lines: **{v6['n_pulled_lines']}** → "
      f"`{v6['pulled_path']}`")
    a(f"- discovery misses: {len(v6['discovery_misses'])}")
    a("")
    v9 = next(c for c in checks if c["check"] == "V9")
    a("## 3. Actual API consumption")
    a("")
    a(f"- metered requests: **{v9['n_metered_rows']}**; measured total "
      f"**{v9['actual_total']}** credits vs cap {t.cfg['credit_budget_cap']}")
    a(f"- by request kind: "
      f"{', '.join(f'{k}={v}' for k, v in sorted(v9['actual_total_by_kind'].items()))}")
    a(f"- quote pulls: modeled **{v9['modeled_total']}**; actual-vs-modeled "
      f"mismatches: {v9['n_mismatches']}")
    a(f"- consumption-unestablished rows: {v9['n_unestablished']}; header "
      f"inconsistencies: {v9['n_inconsistencies']}")
    a("")
    a("## 4. Check verdicts V1-V10")
    a("")
    a("| check | title | status |")
    a("| --- | --- | --- |")
    for c in checks:
        a(f"| {c['check']} | {c['title']} | **{c['status']}** |")
    a("")
    for c in checks:
        a(f"### {c['check']} — {c['title']} [{c['status']}]")
        a("")
        a(c["summary"])
        a("")
        problems = (c.get("violations") or []) + (c.get("failures") or []) \
            + (c.get("problems") or [])
        if problems:
            a("Violations / problems:")
            a("")
            for v in problems[:30]:
                a(f"- {v}")
            for m in c.get("mismatches") or []:
                a(f"- credit mismatch: {m}")
            a("")
    v7 = next(c for c in checks if c["check"] == "V7")
    a("## 5. Settlement reconciliation")
    a("")
    a(f"- outcomes: over {v7['outcomes']['over']} / under "
      f"{v7['outcomes']['under']} / push {v7['outcomes']['push']}")
    a(f"- row-level reconciliation: `{v7['reconciliation_path']}`")
    a("")
    a("## 6. Canonical-schema preview (decision_2d integration)")
    a("")
    a(f"- rows: {canonical['rows']}; schema validation: "
      f"{canonical.get('schema_validation')}; synthetic-refusal path: "
      f"{canonical.get('synthetic_refusal')}")
    a("")
    a("## 7. Recommendation")
    a("")
    if verdict[0] == "PASS":
        a("**PASS** — trial data quality verified; recommend proceeding to the "
          "full 392-game acquisition decision (purchase remains a separate "
          "human authorization).")
    elif verdict[0] == "BLOCKED_PENDING_MANUAL":
        a("**BLOCKED (pending V8)** — automated checks pass, but written "
          "commercial permission must be attached before any full acquisition. "
          "Attach the vendor's written permission to "
          "ATTACHMENT_V8_COMMERCIAL_RIGHTS.md and re-run the verifier.")
    else:
        a("**FAIL** — critical failures above block the full acquisition until "
          "resolved (Decision 2D acceptance rule: any critical failure is "
          "disqualifying).")
    a("")
    a("## 8. Provenance")
    a("")
    a(f"- raw manifest: `{t.dir / 'manifest.json'}` (sha256 "
      f"{sha256_file(t.dir / 'manifest.json')[:16]}…)")
    a("- sample manifest: precommitted selection, schedule metadata only")
    if t.event_map is not None:
        a(f"- event-ID map: `{t.dir / 'event_id_map.json'}` (discovery source "
          "+ timestamp per entry; verified by V3)")
    a(f"- evidence JSONs: `{out_dir}` (deterministic; no wall-clock content)")
    if t.synthetic:
        a("- **SYNTHETIC HARNESS TEST**: zero vendor requests, zero credits "
          "consumed; this report validates CODE, not the vendor.")
    a("")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=Path("raw"))
    ap.add_argument("--sample-manifest", type=Path,
                    default=HERE / "artifacts" / "sample_manifest.json")
    ap.add_argument("--stats", default="auto",
                    help="independent stats CSV (game_id, player_name, "
                         "receiving_yards) or 'auto' (real mode: nflverse pbp)")
    ap.add_argument("--out", type=Path, default=Path("evidence"))
    args = ap.parse_args()

    t = Trial(args.data_dir, args.sample_manifest, args.stats)
    args.out.mkdir(parents=True, exist_ok=True)

    checks = [
        v1_availability(t),
        v2_timestamps(t),
        v3_market_identification(t),
        v4_bookmaker_identity(t),
        v5_price_integrity(t),
        v6_missingness(t, args.out),
        v7_settlement(t, args.out),
        v8_commercial_rights(t),
        v9_cost(t),
        v10_reproducibility(t),
    ]
    canonical = canonical_preview(t, args.out)
    verdict = overall_status(checks)

    for c in checks:
        (args.out / EVIDENCE_FILES[c["check"]]).write_text(
            json.dumps(c, indent=2, sort_keys=True, default=str) + "\n")
    summary = {
        "trial_id": t.cfg["trial_id"],
        "data_label": t.data_label,
        "overall": verdict[0],
        "overall_note": verdict[1],
        "checks": {c["check"]: c["status"] for c in checks},
        "canonical_preview": canonical,
        "sample_manifest_games": [g["game_id"] for g in t.sample["games"]],
    }
    (args.out / "checks_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True, default=str) + "\n")
    (args.out / "TRIAL_REPORT.md").write_text(
        render_report(t, checks, verdict, canonical, args.out) + "\n")

    print(json.dumps({"overall": verdict[0],
                      "checks": summary["checks"]}, indent=2))
    print(f"report: {args.out / 'TRIAL_REPORT.md'}")


if __name__ == "__main__":
    main()
