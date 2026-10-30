"""01_build_corpus.py — DRIVE-REC-V2 corpus construction (Decision 2C rebuild).

Unit of observation: (game, drive, player) for skill-position players (WR/TE/RB/FB).
Outcome y: the player records >= 1 reception during the drive (completed pass; two-point
attempts and penalty-nullified plays excluded by construction).

Both teams of every regular-season game are processed; each team's drives are emitted
with that team's own causal feature snapshots.

Leakage protection (enforced below, asserted at the end):
  * Every feature is computed from a snapshot taken BEFORE the drive's first play:
    completed prior games (this season and prior season) plus prior drives of the
    current game, plus static registry data (position, height, rookie season).
  * In-game counters are asserted to be zero on each team's first drive of a game.
  * Outcome-side columns (y, od_*) and baseline predictions are asserted to be disjoint
    from all feature blocks.

Player participation (who is on the field for a given play) is NOT observable in public
play-by-play and is NOT imputed — the agreed modeling boundary. The per-game player
universe is an explicitly documented causal proxy:
  * if the team played an earlier regular-season game this season: players with at least
    one recorded target / reception / rush in that previous game;
  * otherwise (season opener): players with at least 4 games-with-usage for the team in
    the prior regular season.
Both rules use only information available before the game starts. Players who play but
record no usage in the prior game are outside the universe; this is a conservative,
market-relevant approximation whose coverage is measured in corpus_stats.json.
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import (  # noqa: E402
    ALL_FEATURES, ARTIFACTS, BASELINE_COLS, DATA, OUTCOME_COLS, POSITION_GROUP,
    SEASONS_MODELED, SKILL_POSITIONS,
)

PBP_COLS = [
    "game_id", "play_id", "fixed_drive", "posteam", "defteam", "qtr", "season_type",
    "quarter_seconds_remaining", "game_seconds_remaining", "down", "ydstogo",
    "yardline_100", "posteam_score", "defteam_score", "play_type", "complete_pass",
    "receiver_player_id", "receiver_player_name", "rusher_player_id",
    "two_point_attempt", "play_deleted", "qb_kneel", "qb_spike",
    "posteam_timeouts_remaining", "defteam_timeouts_remaining", "season", "week",
    "game_date", "home_team", "away_team",
]

SCRIMMAGE = {"pass", "run", "no_play", "qb_kneel", "qb_spike", "field_goal", "punt"}
PRIOR_WEIGHT_GAMES = 3.0      # shrinkage weight (in games) of prior-season aggregates
B1_SHRINKAGE = 20.0           # drives of shrinkage toward the position prior (baseline B1)
OPENER_MIN_GAMES = 4          # prior-season games-with-usage required in a season opener


# ---------------------------------------------------------------------------
# Loading and per-season aggregates
# ---------------------------------------------------------------------------

def load_season(season: int) -> pd.DataFrame:
    df = pd.read_parquet(DATA / f"play_by_play_{season}.parquet", columns=PBP_COLS)
    df = df[df.season_type == "REG"].copy()
    df = df[df.play_deleted != 1]
    return df.sort_values(["game_id", "play_id"]).reset_index(drop=True)


def usage_table(pbp: pd.DataFrame) -> pd.DataFrame:
    """One row per recorded usage event (target / reception / rush)."""
    passing = pbp[(pbp.play_type == "pass") & (pbp.two_point_attempt != 1)]
    rushing = pbp[(pbp.play_type == "run") & (pbp.two_point_attempt != 1)]

    tgt = passing[passing.receiver_player_id.notna()][
        ["game_id", "fixed_drive", "posteam", "receiver_player_id"]].rename(
        columns={"receiver_player_id": "player_id"})
    tgt["kind"] = "target"
    rec = passing[passing.complete_pass == 1][
        ["game_id", "fixed_drive", "posteam", "receiver_player_id"]].rename(
        columns={"receiver_player_id": "player_id"})
    rec["kind"] = "reception"
    rus = rushing[rushing.rusher_player_id.notna()][
        ["game_id", "fixed_drive", "posteam", "rusher_player_id"]].rename(
        columns={"rusher_player_id": "player_id"})
    rus["kind"] = "rush"
    return pd.concat([tgt, rec, rus], ignore_index=True)


def aggregate_season(pbp: pd.DataFrame) -> dict:
    """Full-season aggregates used as PRIOR information for the following season."""
    use = usage_table(pbp)
    use["is_tgt"] = (use.kind == "target").astype(int)
    use["is_rec"] = (use.kind == "reception").astype(int)
    use["is_rush"] = (use.kind == "rush").astype(int)

    game_team = pbp.dropna(subset=["posteam"]).groupby(
        ["game_id", "posteam"]).agg(drives=("fixed_drive", "nunique")).reset_index()

    per_game_player = use.groupby(["game_id", "player_id"]).agg(
        tgts=("is_tgt", "sum"), recs=("is_rec", "sum"),
        team=("posteam", lambda s: s.mode().iat[0])).reset_index()
    per_game_player = per_game_player.merge(
        game_team, left_on=["game_id", "team"], right_on=["game_id", "posteam"],
        how="left")

    player = per_game_player.groupby("player_id").agg(
        games=("game_id", "nunique"), tgts=("tgts", "sum"), recs=("recs", "sum"),
        drives=("drives", "sum")).reset_index()
    rush_g = use[use.is_rush == 1].groupby("player_id").agg(
        rushes=("is_rush", "sum")).reset_index()
    # positive drives: distinct (game, drive) with >= 1 reception by the player.
    # This is the probability-consistent numerator: a player can catch 2+ passes
    # on one drive, so raw receptions / drives is NOT bounded by 1.
    pos_drv = (use[use.is_rec == 1][["game_id", "fixed_drive", "player_id"]]
               .drop_duplicates().groupby("player_id").size().rename("pos_drives")
               .reset_index())
    player = (player.merge(rush_g, on="player_id", how="left")
              .merge(pos_drv, on="player_id", how="left"))
    player["rushes"] = player["rushes"].fillna(0)
    player["pos_drives"] = player["pos_drives"].fillna(0)

    player_team = per_game_player.groupby(["player_id", "team"]).agg(
        games=("game_id", "nunique")).reset_index()

    team_off = game_team.groupby("posteam").agg(
        games=("game_id", "nunique"), drives=("drives", "sum")).reset_index()
    team_tgt = use[use.is_tgt == 1].groupby("posteam").agg(tgts=("is_tgt", "sum"))
    team_cmp = use[use.is_rec == 1].groupby("posteam").agg(comps=("is_rec", "sum"))
    team_off = team_off.merge(team_tgt, on="posteam", how="left").merge(
        team_cmp, on="posteam", how="left")
    team_off[["tgts", "comps"]] = team_off[["tgts", "comps"]].fillna(0)

    drive_comp = use[use.is_rec == 1].groupby(["game_id", "fixed_drive"]).size().rename("comps")
    drive_team = pbp.dropna(subset=["posteam"]).groupby(
        ["game_id", "fixed_drive"]).agg(posteam=("posteam", "first")).reset_index()
    drive_team = drive_team.merge(drive_comp, on=["game_id", "fixed_drive"], how="left")
    drive_team["comps"] = drive_team["comps"].fillna(0)
    team_def = drive_team.groupby("posteam").agg(
        defteam_drives=("fixed_drive", "count"),
        comps_allowed_as_posteam=("comps", "sum")).reset_index()
    # completions allowed while playing DEFENSE = completions by the OTHER posteam
    other = drive_team.copy()
    other["defteam"] = other["posteam"]
    comps_by_posteam = drive_team[["game_id", "fixed_drive", "posteam", "comps"]]
    drive_def = pbp.dropna(subset=["defteam"]).groupby(
        ["game_id", "fixed_drive"]).agg(defteam=("defteam", "first")).reset_index()
    drive_def = drive_def.merge(comps_by_posteam, on=["game_id", "fixed_drive"], how="left")
    drive_def["comps"] = drive_def["comps"].fillna(0)
    team_def = drive_def.groupby("defteam").agg(
        def_drives=("fixed_drive", "count"), comps_allowed=("comps", "sum")).reset_index()

    return {
        "player": player.set_index("player_id").to_dict("index"),
        "player_team": {(r.player_id, r.team): int(r.games)
                        for r in player_team.itertuples()},
        "team_off": team_off.set_index("posteam").to_dict("index"),
        "team_def": team_def.set_index("defteam").to_dict("index"),
        "league": {
            "tgts_per_drive": float(use.is_tgt.sum() / max(len(drive_team), 1)),
            "comps_per_drive": float(use.is_rec.sum() / max(len(drive_team), 1)),
        },
    }


def position_priors(pbp: pd.DataFrame, registry: dict) -> dict:
    """League per-position prior rates from one season (rookie fallbacks)."""
    agg = aggregate_season(pbp)
    rows = []
    for pid, a in agg["player"].items():
        reg = registry.get(pid)
        if reg and reg["position"] in SKILL_POSITIONS:
            rows.append({"position": reg["pos_group"], "tgts": a["tgts"],
                         "recs": a["recs"], "drives": a["drives"],
                         "pos_drives": a["pos_drives"],
                         "games": a["games"], "rushes": a["rushes"]})
    df = pd.DataFrame(rows)
    out = {}
    for pos, grp in df.groupby("position"):
        out[pos] = {
            "tpg": float(grp.tgts.sum() / max(grp.games.sum(), 1)),
            "cth": float((grp.recs.sum() + 1) / (grp.tgts.sum() + 2)),
            "share": float(grp.tgts.sum() / max(df.tgts.sum(), 1)),
            "rpg": float(grp.rushes.sum() / max(grp.games.sum(), 1)),
            "rec_per_drive": float(grp.pos_drives.sum() / max(grp.drives.sum(), 1)),
        }
    out["_league_rec_per_drive"] = float(df.pos_drives.sum() / max(df.drives.sum(), 1))
    return out


# ---------------------------------------------------------------------------
# Per-season corpus emission
# ---------------------------------------------------------------------------

def build_season(season, pbp, prior, pos_prior, registry) -> tuple[pd.DataFrame, dict]:
    use = usage_table(pbp)
    use_by_game = {g: u for g, u in use.groupby("game_id")}

    games = (pbp[["game_id", "week", "game_date", "home_team", "away_team"]]
             .drop_duplicates("game_id")
             .sort_values(["week", "game_date", "game_id"]))
    pbp_by_game = {g: d for g, d in pbp.groupby("game_id")}

    so_player = defaultdict(lambda: {"games": 0, "tgts": 0, "recs": 0,
                                     "rushes": 0, "drives": 0, "pos_drives": 0})
    so_team_off = defaultdict(lambda: {"games": 0, "drives": 0, "tgts": 0, "comps": 0})
    so_team_def = defaultdict(lambda: {"def_drives": 0, "comps_allowed": 0})
    last_game_usage: dict = {}

    rows = []
    diag = {"games": 0, "team_games": 0, "drives": 0, "rows": 0,
            "universe_sizes": [], "openers": 0, "receptions_total_skill": 0,
            "receptions_covered": 0, "drives_with_completion": 0, "nan_ctx": 0}

    for g in games.itertuples():
        game_id, week, game_date = g.game_id, int(g.week), str(g.game_date)
        gp = pbp_by_game[game_id]
        gu = use_by_game.get(game_id)
        if gu is None:
            continue
        diag["games"] += 1

        for team, defteam in [(g.home_team, g.away_team), (g.away_team, g.home_team)]:
            team_gp = gp[gp.posteam == team].sort_values(["fixed_drive", "play_id"])
            team_use = gu[gu.posteam == team]
            if team_gp.empty:
                continue
            diag["team_games"] += 1

            # ---- causal player universe ----
            if team in last_game_usage:
                u_ids = {p for p in last_game_usage[team]
                         if p in registry and registry[p]["position"] in SKILL_POSITIONS}
            else:
                diag["openers"] += 1
                u_ids = {p for (p, t), n in prior["player_team"].items()
                         if t == team and n >= OPENER_MIN_GAMES
                         and p in registry and registry[p]["position"] in SKILL_POSITIONS}
            diag["universe_sizes"].append(len(u_ids))

            # ---- season-to-date snapshots (constant within this game) ----
            to = so_team_off[team]
            td = so_team_def[defteam]
            pto = prior["team_off"].get(team, {"drives": 0, "tgts": 0, "comps": 0})
            ptd = prior["team_def"].get(defteam, {"def_drives": 0, "comps_allowed": 0})
            lg = prior["league"]

            t_games = to["games"]
            tw = t_games / (t_games + PRIOR_WEIGHT_GAMES)
            t_prior_vol = (pto["tgts"] / pto["drives"] if pto["drives"] > 0
                           else lg["tgts_per_drive"])
            t_vol = to["tgts"] / to["drives"] if to["drives"] > 0 else t_prior_vol
            t_blend_vol = tw * t_vol + (1 - tw) * t_prior_vol
            t_prior_comp = (pto["comps"] / pto["drives"] if pto["drives"] > 0
                            else lg["comps_per_drive"])
            t_comp = to["comps"] / to["drives"] if to["drives"] > 0 else t_prior_comp
            t_blend_comp = tw * t_comp + (1 - tw) * t_prior_comp
            d_prior = (ptd["comps_allowed"] / ptd["def_drives"] if ptd["def_drives"] > 0
                       else lg["comps_per_drive"])
            d_comp_allowed = (td["comps_allowed"] / td["def_drives"]
                              if td["def_drives"] > 0 else d_prior)

            # ---- drives of this game for this team ----
            drive_list = []
            for fd, dplay in team_gp.groupby("fixed_drive"):
                ctx_src = dplay[dplay.play_type.isin(SCRIMMAGE)]
                if ctx_src.empty:
                    ctx_src = dplay[dplay.play_type.notna()]
                ctx = ctx_src.iloc[0] if not ctx_src.empty else dplay.iloc[0]
                du = team_use[team_use.fixed_drive == fd]
                tgts = du[du.kind == "target"]
                recs = du[du.kind == "reception"]
                rush = du[du.kind == "rush"]
                drive_list.append({
                    "fd": fd, "ctx": ctx, "n_plays": int(ctx_src.shape[0]),
                    "tgts": tgts, "recs": recs, "rush": rush,
                    "team_tgts": int(len(tgts)), "team_recs": int(len(recs)),
                    "is_kneel": bool(ctx_src.shape[0] > 0 and
                                     ctx_src.play_type.isin({"qb_kneel", "qb_spike"}).all()),
                })
            drive_list.sort(key=lambda d: d["fd"])

            recs_by_player_game = team_use[team_use.kind == "reception"]
            diag["receptions_total_skill"] += int(
                recs_by_player_game.player_id.map(
                    lambda p: p in registry and registry[p]["position"]
                    in SKILL_POSITIONS).sum())

            # in-game counters: strictly prior drives of THIS game for THIS team
            in_tgts = defaultdict(int)
            in_recs = defaultdict(int)
            in_team_tgts = 0

            drive_idx = 0
            for drv in drive_list:
                drive_idx += 1
                ctx = drv["ctx"]
                qtr = float(ctx.qtr) if pd.notna(ctx.qtr) else 1.0
                gsr = float(ctx.game_seconds_remaining) if pd.notna(
                    ctx.game_seconds_remaining) else 0.0
                gsr = max(gsr, 0.0)
                qsr = float(ctx.quarter_seconds_remaining) if pd.notna(
                    ctx.quarter_seconds_remaining) else 900.0
                score_diff = float(ctx.posteam_score - ctx.defteam_score)
                down = float(ctx.down) if pd.notna(ctx.down) else 1.0
                ytg = float(ctx.ydstogo) if pd.notna(ctx.ydstogo) else 10.0
                yd100 = float(ctx.yardline_100) if pd.notna(ctx.yardline_100) else 75.0
                if pd.isna(ctx.posteam_score) or pd.isna(ctx.defteam_score):
                    diag["nan_ctx"] += 1
                off_to = (float(ctx.posteam_timeouts_remaining)
                          if pd.notna(ctx.posteam_timeouts_remaining) else 3.0)
                def_to = (float(ctx.defteam_timeouts_remaining)
                          if pd.notna(ctx.defteam_timeouts_remaining) else 3.0)

                base_ctx = {
                    "qtr": qtr, "is_ot": float(qtr >= 5), "game_secs_rem": gsr,
                    "game_secs_rem_log": math.log1p(gsr),
                    "two_min": float(qtr in (2, 4) and qsr <= 120.0),
                    "score_diff": score_diff, "abs_score_diff": abs(score_diff),
                    "offense_leading": float(score_diff > 0),
                    "yardline_100_start": yd100, "down_start": down,
                    "ydstogo_start": ytg, "off_timeouts_rem": off_to,
                    "def_timeouts_rem": def_to, "drive_idx_team": float(drive_idx),
                }

                rec_ids = set(drv["recs"].player_id)
                diag["receptions_covered"] += len(rec_ids & u_ids)
                if drv["team_recs"] > 0:
                    diag["drives_with_completion"] += 1

                for pid in u_ids:
                    reg = registry[pid]
                    pos_group = reg["pos_group"]
                    pr = pos_prior[pos_group]
                    pp = prior["player"].get(pid)
                    has_prior = int(pp is not None and (pp["tgts"] + pp["rushes"]) > 0)
                    if has_prior:
                        prior_tpg = pp["tgts"] / max(pp["games"], 1)
                        prior_cth = (pp["recs"] + 1) / (pp["tgts"] + 2)
                        prior_share = pp["tgts"] / max(pto["tgts"], 1)
                        prior_rpg = pp["rushes"] / max(pp["games"], 1)
                        prior_recs, prior_drives = float(pp["recs"]), float(pp["drives"])
                        prior_pos = float(pp["pos_drives"])
                    else:
                        prior_tpg, prior_cth = pr["tpg"], pr["cth"]
                        prior_share, prior_rpg = pr["share"], pr["rpg"]
                        prior_recs, prior_drives = 0.0, 0.0
                        prior_pos = 0.0

                    sp = so_player[pid]
                    w = sp["games"] / (sp["games"] + PRIOR_WEIGHT_GAMES)
                    sts_tpg = sp["tgts"] / sp["games"] if sp["games"] > 0 else prior_tpg
                    sts_cth = ((sp["recs"] + 1) / (sp["tgts"] + 2) if sp["tgts"] > 0
                               else prior_cth)
                    sts_share = sp["tgts"] / to["tgts"] if to["tgts"] > 0 else prior_share
                    sts_rpg = (sp["rushes"] / sp["games"] if sp["games"] > 0 else prior_rpg)
                    sts_recs_pd = (sp["pos_drives"] / sp["drives"] if sp["drives"] > 0
                                   else None)
                    prior_recs_pd = (prior_pos / prior_drives if prior_drives > 0
                                     else pr["rec_per_drive"])
                    recs_pd = sts_recs_pd if sts_recs_pd is not None else prior_recs_pd

                    share_blend = w * sts_share + (1 - w) * prior_share
                    cth_blend = w * sts_cth + (1 - w) * prior_cth
                    recs_pd_blend = w * recs_pd + (1 - w) * prior_recs_pd
                    ing_share = (in_tgts[pid] + 2.0 * share_blend) / (in_team_tgts + 2.0)

                    lam = share_blend * t_blend_vol * cth_blend
                    b1 = ((sp["pos_drives"] + prior_pos + B1_SHRINKAGE * pr["rec_per_drive"])
                          / (sp["drives"] + prior_drives + B1_SHRINKAGE))
                    b2 = 1.0 - math.exp(-lam)
                    b3 = (1.0 - math.exp(-t_blend_comp)) * share_blend

                    rows.append({
                        "game_id": game_id, "season": season, "week": week,
                        "game_date": game_date, "drive": int(drv["fd"]),
                        "drive_idx_team": drive_idx, "posteam": team,
                        "defteam": defteam, "player_id": pid,
                        "player_name": reg["name"], "position": reg["position"],
                        "pos_group": pos_group, "y": int(pid in rec_ids),
                        **base_ctx,
                        "p_prior_tpg": prior_tpg, "p_prior_cth": prior_cth,
                        "p_prior_share": prior_share, "p_prior_rpg": prior_rpg,
                        "has_prior": has_prior,
                        "rookie": float(reg["rookie_season"] == season),
                        "p_sts_tpg": sts_tpg, "p_sts_cth": sts_cth,
                        "p_sts_share": sts_share, "p_sts_rpg": sts_rpg,
                        "p_games_so_far": sp["games"],
                        "p_ingame_tgts_so_far": in_tgts[pid],
                        "p_ingame_recs_so_far": in_recs[pid],
                        "p_ingame_share": ing_share,
                        "p_blend_share": share_blend, "p_blend_cth": cth_blend,
                        "p_blend_recs_per_drive": recs_pd_blend,   # blended rate of drives with >= 1 reception
                        "pos_WR": float(pos_group == "WR"),
                        "pos_TE": float(pos_group == "TE"),
                        "pos_RB": float(pos_group == "RB"),
                        "height_in": reg["height"],
                        "t_games_so_far": t_games,
                        "t_sts_tgts_per_drive": t_vol,
                        "t_prior_tgts_per_drive": t_prior_vol,
                        "t_blend_tgts_per_drive": t_blend_vol,
                        "t_blend_comps_per_drive": t_blend_comp,
                        "d_sts_comps_per_drive": d_comp_allowed,
                        "d_prior_comps_per_drive": d_prior,
                        "b1_empirical": b1, "b2_target_share": b2,
                        "b3_possession_survival": b3,
                        "od_drive_plays": drv["n_plays"],
                        "od_drive_tgts": drv["team_tgts"],
                        "od_drive_comps": drv["team_recs"],
                        "od_drive_is_kneel": int(drv["is_kneel"]),
                    })

                # update in-game counters AFTER emitting rows for this drive
                for pid in drv["tgts"].player_id:
                    in_tgts[pid] += 1
                for pid in drv["recs"].player_id:
                    in_recs[pid] += 1
                in_team_tgts += drv["team_tgts"]

            # ---- end of team-game: update season-to-date aggregates ----
            n_team_drives = len(drive_list)
            so_team_off[team]["games"] += 1
            so_team_off[team]["drives"] += n_team_drives
            so_team_off[team]["tgts"] += int((team_use.kind == "target").sum())
            so_team_off[team]["comps"] += int((team_use.kind == "reception").sum())
            so_team_def[defteam]["def_drives"] += n_team_drives
            so_team_def[defteam]["comps_allowed"] += int(
                (team_use.kind == "reception").sum())
            for pid in team_use.player_id.unique():
                so_player[pid]["drives"] += n_team_drives
            pos_this_game = (team_use[team_use.kind == "reception"]
                             [["fixed_drive", "player_id"]].drop_duplicates()
                             .groupby("player_id").size())
            for pid, n in pos_this_game.items():
                so_player[pid]["pos_drives"] += int(n)
            for pid, n in team_use[team_use.kind == "target"].groupby(
                    "player_id").size().items():
                so_player[pid]["tgts"] += int(n)
            for pid, n in team_use[team_use.kind == "reception"].groupby(
                    "player_id").size().items():
                so_player[pid]["recs"] += int(n)
            for pid, n in team_use[team_use.kind == "rush"].groupby(
                    "player_id").size().items():
                so_player[pid]["rushes"] += int(n)
            for pid in team_use.player_id.unique():
                so_player[pid]["games"] += 1
            last_game_usage[team] = set(team_use.player_id.unique())

            diag["drives"] += n_team_drives
            diag["rows"] += len(u_ids) * n_team_drives

    return pd.DataFrame(rows), diag


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    players = pd.read_csv(DATA / "players.csv", low_memory=False)
    players = players[players.gsis_id.notna()]
    registry = {}
    for r in players.itertuples():
        if r.position in SKILL_POSITIONS:
            registry[r.gsis_id] = {
                "position": r.position, "pos_group": POSITION_GROUP[r.position],
                "name": r.display_name,
                "height": None if pd.isna(r.height) else float(r.height),
                "rookie_season": (None if pd.isna(r.rookie_season)
                                  else int(r.rookie_season)),
            }
    pos_height = (players[players.position.isin(SKILL_POSITIONS)]
                  .groupby(players.position.map(POSITION_GROUP)).height.median().to_dict())
    for reg in registry.values():
        if reg["height"] is None:
            reg["height"] = float(pos_height.get(reg["pos_group"], 74.0))

    pbp_cache = {}
    prior_cache = {}
    pos_prior_cache = {}

    stats = {"seasons": {}, "assertions": {}}
    all_ok = True

    for season in SEASONS_MODELED:
        prior_season = season - 1
        for s in (season, prior_season):
            if s not in pbp_cache:
                pbp_cache[s] = load_season(s)
        if prior_season not in prior_cache:
            prior_cache[prior_season] = aggregate_season(pbp_cache[prior_season])
            pos_prior_cache[prior_season] = position_priors(
                pbp_cache[prior_season], registry)

        df, diag = build_season(
            season, pbp_cache[season], prior_cache[prior_season],
            pos_prior_cache[prior_season], registry)

        # ---- lag reference rows (same player, same game, k team-drives earlier) ----
        df = df.sort_values(["game_id", "player_id", "drive_idx_team"]).reset_index(drop=True)
        grp = df.groupby(["game_id", "player_id"], sort=False)
        sizes = grp.size().to_numpy()
        starts = np.repeat(grp.head(1).index.to_numpy(), sizes)
        local = np.arange(len(df)) - starts
        for k in (1, 2, 4):
            df[f"lag{k}_row"] = np.where(local >= k, np.arange(len(df)) - k, -1)

        # ---- leakage assertions ----
        first = df[df.drive_idx_team == 1]
        lag1_ok = True
        pos = np.arange(len(df))
        l1 = df.lag1_row.to_numpy()
        same_player = ((df.game_id.to_numpy() == df.game_id.to_numpy()[np.maximum(l1, 0)])
                       & (df.player_id.to_numpy()
                          == df.player_id.to_numpy()[np.maximum(l1, 0)]))
        lag1_ok = bool(((l1 == -1) | ((l1 < pos) & same_player)).all())
        checks = {
            "ingame_counters_zero_on_first_drive": bool(
                (first.p_ingame_tgts_so_far == 0).all()
                and (first.p_ingame_recs_so_far == 0).all()),
            "feature_outcome_disjoint": bool(
                not (set(ALL_FEATURES) & (set(OUTCOME_COLS) | set(BASELINE_COLS)))),
            "y_binary_no_missing": bool(df.y.isin([0, 1]).all() and df.y.notna().all()),
            "no_missing_features": bool(df[ALL_FEATURES].notna().all().all()),
            "baseline_bounds_ok": bool(
                df[BASELINE_COLS].apply(lambda s: ((s >= 0) & (s <= 1)).all()).all()),
            "lag1_rows_valid": lag1_ok,
        }
        stats["assertions"][season] = checks
        all_ok = all_ok and all(checks.values())

        df.to_parquet(DATA / f"player_drives_{season}.parquet", index=False)

        uni = np.array(diag["universe_sizes"])
        stats["seasons"][season] = {
            "games": diag["games"], "team_games": diag["team_games"],
            "drives": diag["drives"], "rows": int(len(df)),
            "players": int(df.player_id.nunique()),
            "mean_universe_size": float(uni.mean()),
            "openers_using_prior_season_rule": diag["openers"],
            "positive_rate": float(df.y.mean()),
            "receptions_skill_players": diag["receptions_total_skill"],
            "receptions_covered_by_universe": diag["receptions_covered"],
            "reception_coverage_rate": float(diag["receptions_covered"]
                                             / max(diag["receptions_total_skill"], 1)),
            "drives_with_completion_rate": float(diag["drives_with_completion"]
                                                 / max(diag["drives"], 1)),
            "kneel_drive_rate": float(df.od_drive_is_kneel.mean()),
            "positive_rate_by_pos": {k: float(v) for k, v in
                                     df.groupby("pos_group").y.mean().items()},
            "nan_score_ctx_drives": diag["nan_ctx"],
        }
        print(f"[season {season}] rows={len(df):,} games={diag['games']} "
              f"drives={diag['drives']:,} y-rate={df.y.mean():.4f} "
              f"coverage={stats['seasons'][season]['reception_coverage_rate']:.3f} "
              f"checks={'OK' if all(checks.values()) else 'FAIL ' + str(checks)}")

    stats["all_assertions_passed"] = all_ok
    with open(ARTIFACTS / "corpus_stats.json", "w") as f:
        json.dump(stats, f, indent=2)
    print(f"[corpus] all_assertions_passed={all_ok}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
