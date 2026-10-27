#!/usr/bin/env python3
"""Deterministic NBA fixture builder (offline, no network, no API key).

Builds the "full night" research fixtures that complete the NBA section:

  viewer/nba_slate_2026-10-23.json    10 games, 62 modeled player rows
  viewer/nba_games_2026-10-23.json    10 games (all tips map to Oct 23 ET)
  viewer/nba_odds_2026-10-23.json     EV-ranked quote envelope (fixture)
  viewer/nba_injuries_2026-10-23.json availability feed + minutes beneficiaries
  viewer/nba_injuries_2026-10-22.json companion availability feed for the
                                      existing 2-game opener night

Provenance rules (docs/MULTISPORT.md §2): every row/quote/item carries
_fixture: true; quotes never claim verification; players stay anonymized
(Player A ... continuing Y, Z, then AA-AZ/BA-BZ/CA-CH) — real athlete names
are never combined with synthetic statistics. Re-running is idempotent:
output is a pure function of the seed (random.Random(20261023)).

Self-validates every constraint the node suite enforces before writing.
Usage: python3 scripts/build_nba_fixtures.py
"""
import json
import math
import os
import random
import re
from datetime import datetime, timedelta, timezone
from statistics import NormalDist
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.join(HERE, "..", "viewer")
ET = ZoneInfo("America/New_York")
ND = NormalDist()
DATE = "2026-10-23"
STAMPS = {"22": "2026-10-22T17:00:00Z", "23": "2026-10-23T17:00:00Z"}
MARKETS = ("points", "rebounds", "assists", "threes", "pra")
BANNED = re.compile(r"\b(guaranteed|lock|locks|sure thing|banker|free money|can'?t lose|proven winner)\b", re.I)

# 10 games — 20 teams; BOS/NYK/DEN/OKC sit (they played the Oct 22 opener).
GAMES = [
    ("MIL", "CLE", "19:00", "Rocket Mortgage FieldHouse"),
    ("TOR", "BKN", "19:30", "Barclays Center"),
    ("IND", "PHI", "19:00", "Wells Fargo Center"),
    ("ORL", "MIA", "19:30", "Kaseya Center"),
    ("DET", "CHI", "20:00", "United Center"),
    ("SAS", "HOU", "20:00", "Toyota Center"),
    ("MEM", "NOP", "20:00", "Smoothie King Center"),
    ("UTA", "SAC", "22:00", "Golden 1 Center"),
    ("GSW", "LAC", "22:00", "Intuit Dome"),
    ("PHX", "LAL", "22:30", "Crypto.com Arena"),
]

# Per-game lineup archetypes: (position, minutes, usage).
LINEUPS = [
    [("PG", 36.0, 0.315), ("SG", 34.5, 0.285), ("SF", 33.0, 0.245), ("PF", 30.5, 0.205), ("C", 29.0, 0.225), ("SG", 22.0, 0.155), ("PF", 15.5, 0.125)],
    [("PG", 35.5, 0.305), ("SG", 33.0, 0.270), ("SF", 32.0, 0.235), ("PF", 29.5, 0.200), ("C", 28.0, 0.215), ("SF", 21.0, 0.150), ("PG", 14.0, 0.115)],
    [("PG", 36.5, 0.325), ("SG", 34.0, 0.290), ("SF", 31.5, 0.240), ("PF", 30.0, 0.210), ("C", 27.5, 0.220), ("SG", 20.5, 0.145), ("C", 13.0, 0.110)],
    [("PG", 35.0, 0.310), ("SG", 33.5, 0.280), ("SF", 32.5, 0.250), ("PF", 28.5, 0.195), ("C", 27.0, 0.230), ("PF", 19.5, 0.140), ("SG", 12.5, 0.105)],
    [("PG", 34.5, 0.300), ("SG", 33.0, 0.275), ("SF", 31.0, 0.230), ("PF", 29.0, 0.205), ("C", 28.5, 0.235), ("SG", 20.0, 0.150), ("PF", 14.5, 0.115)],
    [("PG", 36.0, 0.320), ("SG", 34.5, 0.295), ("SF", 32.0, 0.245), ("PF", 29.5, 0.215), ("C", 28.0, 0.200), ("SF", 18.5, 0.135), ("PG", 12.0, 0.100)],
]

REB_BASE = {"PG": (3.0, 5.0), "SG": (3.2, 5.2), "SF": (4.2, 6.4), "PF": (6.0, 8.2), "C": (7.5, 10.5)}
AST_BASE = {"PG": (5.5, 8.0), "SG": (2.5, 4.0), "SF": (2.0, 3.5), "PF": (1.5, 3.0), "C": (1.0, 2.5)}
THREE_BASE = {"PG": (1.8, 3.0), "SG": (2.0, 3.2), "SF": (1.5, 2.6), "PF": (1.0, 2.0), "C": (0.4, 1.2)}
PTS_TIER = [(24.0, 28.5), (19.0, 23.5), (14.0, 17.5), (9.0, 12.5), (6.0, 8.5), (3.5, 5.5), (2.0, 4.0)]


def anon_names(n):
    """Continuation of the anonymized pool after Player X: Y, Z, then AA-AZ, BA-BZ, CA-CH."""
    out = []
    for singles in ("Y", "Z"):
        out.append(singles)
    i = 0
    while len(out) < n:
        first = chr(ord("A") + i // 26)
        second = chr(ord("A") + i % 26)
        out.append(f"{first}{second}")
        i += 1
    return out[:n]


def et_date(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET).strftime("%Y-%m-%d")


def tip_utc(date, et_time):
    h, m = map(int, et_time.split(":"))
    dt = datetime.strptime(date, "%Y-%m-%d").replace(hour=h, minute=m, tzinfo=ET)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def r1(x):
    return round(x + 1e-9, 1)


def build_slate():
    rng = random.Random(20261023)
    names = anon_names(70)
    rows, games = [], []
    idx = 0
    for gi, (away, home, tip, venue) in enumerate(GAMES):
        games.append({
            "game_id": f"nba-20261023-{away}-{home}",
            "gameday": DATE,
            "gametime": tip,
            "gametime_et": tip,
            "tipoff_utc": tip_utc(DATE, tip),
            "away_team": away,
            "home_team": home,
            "venue": venue,
            "_fixture": True,
        })
        lineup = LINEUPS[gi % len(LINEUPS)]
        for pi, (pos, minutes, usage) in enumerate(lineup):
            name = names[idx]
            pid = f"fx-nba-player-{name.lower()}"
            idx += 1
            team, opp, is_home = (home, away, 1) if pi % 2 == 0 else (away, home, 0)
            lo, hi = PTS_TIER[pi]
            pts = rng.uniform(lo, hi)
            if pos == "C":
                pts -= 1.0
            reb_lo, reb_hi = REB_BASE[pos]
            reb = rng.uniform(reb_lo, reb_hi) + (0.6 if pi == 0 else 0.0)
            ast_lo, ast_hi = AST_BASE[pos]
            ast = rng.uniform(ast_lo, ast_hi) + (0.6 if pi == 0 else 0.0)
            th_lo, th_hi = THREE_BASE[pos]
            th = rng.uniform(th_lo, th_hi)
            row = {
                "player_id": pid, "player_display_name": f"Player {name}",
                "position": pos, "team": team, "opponent_team": opp,
                "game_id": games[-1]["game_id"], "is_home": is_home,
                "status": "ACTIVE", "minutes": minutes, "usage_rate": round(usage, 3),
                "_fixture": True,
            }
            mu = {"pts": pts, "reb": reb, "ast": ast, "fg3m": th}
            fair = {}
            for key in ("pts", "reb", "ast", "fg3m"):
                m = r1(mu[key])
                sd = max({"pts": 1.5, "reb": 0.9, "ast": 0.7, "fg3m": 0.5}[key], r1(m * {"pts": 0.24, "reb": 0.26, "ast": 0.34, "fg3m": 0.40}[key]))
                f = r1(m - rng.uniform(0.1, 0.4))
                suffix = {"pts": "pts", "reb": "reb", "ast": "ast", "fg3m": "fg3m"}[key]
                row[f"proj_{suffix}"] = m
                row[f"mu_{suffix}"] = m
                row[f"fair_line_{suffix}"] = f
                row[f"sd_{suffix}"] = sd
                fair[key] = f
            row["proj_pra"] = r1(row["proj_pts"] + row["proj_reb"] + row["proj_ast"])
            row["mu_pra"] = r1(row["mu_pts"] + row["mu_reb"] + row["mu_ast"])
            row["fair_line_pra"] = r1(fair["pts"] + fair["reb"] + fair["ast"])
            row["sd_pra"] = round(math.sqrt(row["sd_pts"] ** 2 + row["sd_reb"] ** 2 + row["sd_ast"] ** 2), 2)
            rows.append(row)
    return rows, games


def p_over(mu, sd, line):
    """Mirror of the documented normal approximation (continuity-corrected)."""
    if not sd > 0:
        return 0.5
    return 1.0 - ND.cdf((line + 0.5 - mu) / sd)


def build_odds(rows):
    rng = random.Random(20261024)
    by_game = {}
    for r in rows:
        by_game.setdefault(r["game_id"], []).append(r)
    quotes = []
    n = 0
    for gid, players in by_game.items():
        players = sorted(players, key=lambda r: r["player_id"])
        plan = [
            (players[0], "points"), (players[0], "pra"), (players[1], "points"),
            (players[2], "assists"), (players[4], "rebounds"), (players[1], "threes"),
        ]
        for player, market in plan[: rng.choice([4, 5, 5])]:
            suffix = {"points": "pts", "rebounds": "reb", "assists": "ast", "threes": "fg3m", "pra": "pra"}[market]
            mu = player[f"mu_{suffix}"]
            sd = player[f"sd_{suffix}"]
            fair = player[f"fair_line_{suffix}"]
            base = math.floor(fair) + 0.5
            line = None
            for delta in (0.0, -0.5, 0.5, -1.0, 1.0):
                cand = max(0.5, round(base + delta, 1))
                if abs(p_over(mu, sd, cand) - 0.5) <= 0.12:
                    line = cand
                    break
            if line is None:
                line = max(0.5, round(base, 1))
            p = p_over(mu, sd, line)
            best_side = "OVER" if p >= 0.5 else "UNDER"
            p_win = p if best_side == "OVER" else 1.0 - p
            edge = abs(p - 0.5)
            quotes.append({
                "quote_id": f"fixture_{n:02d}_{player['player_id']}_{market}",
                "provider_quote_id": f"fixture_{n:02d}_{player['player_id']}_{market}",
                "source_url": f"propwire://fixture/nba/{DATE}",
                "book": "PropWire Fixture",
                "player_id": player["player_id"],
                "player_name": player["player_display_name"],
                "team": player["team"], "opponent": player["opponent_team"],
                "game_id": player["game_id"], "position": player["position"],
                "market": market, "line": line, "fair_line": fair,
                "over_odds": -110, "under_odds": -110,
                "observed_at": STAMPS["23"],
                "source": "PropWire synthetic fixture (not a sportsbook quote; unverified research data)",
                "verified": False, "_fixture": True,
                "unit": {"points": "pts", "rebounds": "reb", "assists": "ast", "threes": "3pm", "pra": "pra"}[market],
                "evaluation": {
                    "is_qualified": False, "status": "UNVERIFIED", "best_side": best_side,
                    "prob_edge": round(edge, 3),
                    "break_even_adv": round(edge - 0.03, 3),
                    "expected_return": round(p_win * 0.9091 - (1 - p_win), 3),
                    "actionable_stake": 0.0, "catalyst": "none",
                    "injury_context": "none (fixture)",
                },
            })
            n += 1
    envelope = {
        "schema_version": "nba.v1", "feed_status": "fixture", "_fixture": True,
        "fixture_notice": "Research fixtures — synthetic model data for terminal validation. Not sportsbook quotes. Not for wagering decisions.",
        "updated_at": STAMPS["23"], "slate": DATE,
        "verified_books_count": 0, "verified_quotes_count": 0,
        "monitored_books": [], "unverified_books": ["PropWire Fixture"],
        "total_quotes": len(quotes), "qualified_count": 0,
        "quotes": quotes,
    }
    return envelope


def beneficiary_entry(player, injury, share, minutes, role, risk):
    return {
        "_fixture": True,
        "player_id": player["player_id"], "player_name": player["player_display_name"],
        "team": player["team"], "opponent": player["opponent_team"],
        "game_id": player["game_id"], "position": player["position"],
        "catalyst_injury": f"{injury['player_name']} ({injury['injury_type']} {injury['report_status']})",
        "injury_id": injury["injury_id"], "role_type": role,
        "role_label": "PROVISIONAL SURGE (Minutes Vacancy)", "role_class": "role-surge",
        "absorption_share": share, "added_minutes": minutes,
        "invalidation_risk": risk,
    }


def make_injuries(rows, date, plan, stamp):
    """plan: list of (out_player, status, injury_type, practice, severity, notes, [(bene, share, minutes, role, risk)]).

    QUESTIONABLE items carry a risk-weighted half of the player's minutes as
    vacated_minutes (a game-time decision has not vacated the full role)."""
    by_id = {r["player_id"]: r for r in rows}
    injuries, beneficiaries = [], {}
    for i, (out_id, status, itype, practice, severity, notes, benes) in enumerate(plan):
        out_player = by_id[out_id]
        inj = {
            "_fixture": True,
            "injury_id": f"fx-inj-{i + 1}-{date}",
            "player_id": out_id, "player_name": out_player["player_display_name"],
            "team": out_player["team"], "opponent": out_player["opponent_team"],
            "game_id": out_player["game_id"], "position": out_player["position"],
            "injury_type": itype, "report_status": status, "practice_status": practice,
            "severity": severity,
            "source": "PropWire fixture availability report — synthetic, not a real injury report",
            "updated_at": stamp, "notes": notes,
            "vacated_minutes": r1(out_player["minutes"] * (0.5 if status == "QUESTIONABLE" else 1.0)),
            "vacated_usage": out_player["usage_rate"],
            "redistribution_plan": {},
        }
        for j, (bene_id, share, minutes, role, risk) in enumerate(benes):
            bene = by_id[bene_id]
            inj["redistribution_plan"][bene_id] = {
                "_fixture": True,
                "beneficiary_name": bene["player_display_name"], "position": bene["position"],
                "absorption_share": share, "role_type": role,
                "added_minutes": minutes,
                "role_label": "PROVISIONAL SURGE (Minutes Vacancy)", "role_class": "role-surge",
                "invalidation_risk": risk,
            }
            beneficiaries[bene_id] = beneficiary_entry(bene, inj, share, minutes, role, risk)
        injuries.append(inj)
    return {
        "_fixture": True,
        "as_of": stamp, "slate_date": date, "season": 2026,
        "total_active_injuries": len(injuries),
        "injuries": injuries, "impacted_beneficiaries": beneficiaries,
    }


def oct22_injuries():
    """Availability feed for the existing opener night, referencing its players."""
    slate = json.load(open(os.path.join(VIEWER, "nba_slate_2026-10-22.json")))
    by_team = {}
    for r in slate:
        if all(isinstance(r.get(f"proj_{s}"), (int, float)) for s in ("pts", "reb", "ast", "pra")):
            by_team.setdefault(r["team"], []).append(r)
    bos = sorted(by_team["BOS"], key=lambda r: (-r["usage_rate"], r["player_id"]))
    okc = sorted(by_team.get("OKC", []), key=lambda r: (-r["usage_rate"], r["player_id"]))
    out_p, b1, b2 = bos[0], bos[1], bos[2]
    q_p = okc[0] if okc else bos[3]
    plan = [
        (out_p["player_id"], "OUT", "Knee — Patellar Tendonitis", "Did Not Practice (Estimated)", "CRITICAL",
         "Ruled out for the opener; absence is synthetic fixture context. Vacates a primary usage role and the largest minutes share on the roster.",
         [(b1["player_id"], 0.40, 6.5, "Primary creation minutes", "Defensive matchups dictate whether the expanded role survives the second unit."),
          (b2["player_id"], 0.30, 4.5, "Secondary ball-handling bulk", "Foul trouble collapses the experiment quickly; bench guard steals minutes.")]),
        (q_p["player_id"], "QUESTIONABLE", "Ankle Sprain (Grade 1)", "Limited Practice (Estimated)", "ELEVATED",
         "Game-time decision on a synthetic fixture slate; a limited designation flags minutes risk without removing the player from the board.",
         []),
    ]
    return make_injuries(slate, "2026-10-22", plan, STAMPS["22"])


def oct23_injuries(rows):
    by_id = {r["player_id"]: r for r in rows}
    by_team = {}
    for r in rows:
        by_team.setdefault(r["team"], []).append(r)
    mia = sorted(by_team["MIA"], key=lambda r: (-r["usage_rate"], r["player_id"]))
    sac = sorted(by_team["SAC"], key=lambda r: (-r["usage_rate"], r["player_id"]))
    tor = sorted(by_team["TOR"], key=lambda r: (-r["usage_rate"], r["player_id"]))
    plan = [
        (mia[0]["player_id"], "OUT", "Knee — Patellar Tendonitis", "Did Not Practice (Estimated)", "CRITICAL",
         "Synthetic absence for terminal validation: vacates the largest minutes and usage share on the roster; redistribution is conditional on the actual inactive list.",
         [(mia[1]["player_id"], 0.40, 7.0, "Primary creation minutes", "Blowout risk truncates the fourth-quarter window the expanded role depends on."),
          (mia[2]["player_id"], 0.30, 5.0, "Wing scoring bulk", "Bench-unit lineups may route creation through the backup guard instead.")]),
        (sac[0]["player_id"], "QUESTIONABLE", "Ankle Sprain (Grade 1)", "Limited Practice (Estimated)", "ELEVATED",
         "Game-time decision on a synthetic fixture slate; a limited designation flags minutes risk without removing the player from the board.",
         []),
        (tor[0]["player_id"], "OUT", "Illness (Non-COVID)", "Did Not Practice (Estimated)", "CRITICAL",
         "Synthetic illness absence; vacated minutes flow to the next man up in the rotation.",
         [(tor[1]["player_id"], 0.35, 5.5, "Second-unit forward minutes", "Frontcourt foul trouble reshuffles the rotation within a quarter.")]),
    ]
    return make_injuries(rows, DATE, plan, STAMPS["23"])


def validate(slates, games_map, odds_map, inj_map):
    ids_by_date = {}
    for date, rows in slates.items():
        ids = set()
        for r in rows:
            assert r["_fixture"] is True, r["player_id"]
            for f in ("player_id", "player_display_name", "team", "opponent_team", "game_id", "position"):
                assert r.get(f), (r["player_id"], f)
            for m, suf in (("points", "pts"), ("rebounds", "reb"), ("assists", "ast"), ("threes", "fg3m"), ("pra", "pra")):
                for pre in ("proj_", "fair_line_", "mu_", "sd_"):
                    v = r[f"{pre}{suf}"]
                    assert v is None or isinstance(v, (int, float)), (r["player_id"], pre + suf)
            assert isinstance(r["minutes"], (int, float)) and isinstance(r["usage_rate"], (int, float))
            if all(isinstance(r.get(f"mu_{s}"), (int, float)) for s in ("pts", "reb", "ast")):
                assert abs(r["mu_pra"] - (r["mu_pts"] + r["mu_reb"] + r["mu_ast"])) < 0.06, r["player_id"]
                assert abs(r["sd_pra"] - math.sqrt(r["sd_pts"] ** 2 + r["sd_reb"] ** 2 + r["sd_ast"] ** 2)) < 0.06, r["player_id"]
            ids.add(r["player_id"])
        assert len(ids) == len(rows)
        ids_by_date[date] = ids
        for g in games_map[date]:
            assert g["_fixture"] is True and re.match(r"^nba-\d{8}-[A-Z]{2,4}-[A-Z]{2,4}$", g["game_id"])
            assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", g["tipoff_utc"])
            assert re.match(r"^\d{2}:\d{2}$", g["gametime_et"])
            assert et_date(g["tipoff_utc"]) == date, g["game_id"]
        env = odds_map[date]
        assert env["feed_status"] == "fixture" and env["_fixture"] is True and env["slate"] == date
        assert len(env["quotes"]) >= 10 and env["total_quotes"] == len(env["quotes"])
        qids = set()
        for q in env["quotes"]:
            assert q["_fixture"] is True and q["verified"] is False
            assert re.search(r"fixture", q["source"], re.I) and re.search(r"not a sportsbook quote", q["source"], re.I)
            assert q["market"] in MARKETS and q["line"] is not None and q["fair_line"] is not None
            assert isinstance(q["evaluation"]["prob_edge"], (int, float)) and isinstance(q["evaluation"]["expected_return"], (int, float))
            assert q["player_id"] in ids, q["quote_id"]
            row = next(r for r in rows if r["player_id"] == q["player_id"])
            assert q["game_id"] == row["game_id"], q["quote_id"]
            qids.add(q["quote_id"])
        assert len(qids) == len(env["quotes"])
        inj = inj_map[date]
        assert inj["_fixture"] is True
        for item in inj["injuries"]:
            assert item["_fixture"] is True, item["player_id"]
            assert item["player_id"] in ids, item["player_id"]
            assert item["report_status"] in ("OUT", "QUESTIONABLE", "LIMITED", "DAY-TO-DAY")
            assert isinstance(item["vacated_minutes"], (int, float))
            for bene in item["redistribution_plan"].values():
                assert bene["_fixture"] is True
                assert bene["added_minutes"] > 0 and isinstance(bene["absorption_share"], (int, float))
        for pid, bene in inj["impacted_beneficiaries"].items():
            assert bene["_fixture"] is True, pid
            assert pid in ids, pid
            assert bene["added_minutes"] > 0 and bene["player_id"] == pid
    for path, text in inj_text_checks:
        assert not BANNED.search(text), path
    for env in odds_map.values():
        assert not BANNED.search(json.dumps(env))
    print(f"validate: OK ({sum(len(v) for v in slates.values())} rows, {sum(len(v['quotes']) for v in odds_map.values())} quotes)")


if __name__ == "__main__":
    rows23, games23 = build_slate()
    odds23 = build_odds(rows23)
    inj23 = oct23_injuries(rows23)
    inj22 = oct22_injuries()
    slates = {"2026-10-22": json.load(open(os.path.join(VIEWER, "nba_slate_2026-10-22.json"))), DATE: rows23}
    games_map = {"2026-10-22": json.load(open(os.path.join(VIEWER, "nba_games_2026-10-22.json"))), DATE: games23}
    odds_map = {"2026-10-22": json.load(open(os.path.join(VIEWER, "nba_odds_2026-10-22.json"))), DATE: odds23}
    inj_map = {"2026-10-22": inj22, DATE: inj23}
    inj_text_checks = [(d, json.dumps(v)) for d, v in inj_map.items()]
    validate(slates, games_map, odds_map, inj_map)
    outputs = {
        f"nba_slate_{DATE}.json": rows23,
        f"nba_games_{DATE}.json": games23,
        f"nba_odds_{DATE}.json": odds23,
        f"nba_injuries_{DATE}.json": inj23,
        "nba_injuries_2026-10-22.json": inj22,
    }
    for name, payload in outputs.items():
        path = os.path.join(VIEWER, name)
        with open(path, "w") as f:
            json.dump(payload, f, indent=1)
            f.write("\n")
        print(f"wrote {name}")
    n23 = inj23["total_active_injuries"]
    n22 = inj22["total_active_injuries"]
    print(f"Oct 23: {len(games23)} games, {len(rows23)} players, {len(odds23['quotes'])} quotes, {n23} injuries")
    print(f"Oct 22: injuries {n22}, beneficiaries {len(inj22['impacted_beneficiaries'])}")
