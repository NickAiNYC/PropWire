"""Shared definitions for the DRIVE-REC research pipeline.

The feature-block layout is load-bearing: scripts 05–08 rely on it to distinguish
strictly-causal feature groups (e.g., to build lagged "stale quote" feature rows for the
simulated market reference), and leakage assertions verify that outcome-side columns are
never part of any feature block.
"""

from __future__ import annotations

import pathlib

# DRIVE = the Decision 2C/2D research drive directory (research/drive-rec-v2).
# Per Decision 2D §5 (rebuild and provenance control), the entire rebuilt lineage
# lives under this path so it can never clobber the main repository's root files
# when the three-patch series (or this branch) is incorporated.
DRIVE = pathlib.Path(__file__).resolve().parents[1]
REPO = DRIVE.parents[1]
DATA = DRIVE / "data"
ARTIFACTS = DRIVE / "artifacts"
DOCS = DRIVE / "docs"
HUMAN_REVIEW = DRIVE / "HUMAN_REVIEW.md"

SEASONS_PRIOR_SOURCE = [2022]          # used only to initialize priors for the 2023 training season
SEASONS_MODELED = [2023, 2024, 2025, 2026]
TRAIN_SEASON = 2023
DEV_SEASON = 2024
HOLDOUT_SEASON = 2025                  # previously inspected holdout (per Decision 2C)
UNSEEN_SEASON = 2026                   # genuinely unseen prospective slice (weeks 1-7)

SKILL_POSITIONS = {"WR", "TE", "RB", "FB"}
POSITION_GROUP = {"WR": "WR", "TE": "TE", "RB": "RB", "FB": "RB"}

# ---------------------------------------------------------------------------
# Feature blocks. Every column here must be computable BEFORE the drive's first
# play from (a) completed prior games, (b) prior drives of the current game, or
# (c) static registry data. Outcome-side columns live in OUTCOME_COLS and must
# never appear in any feature block (asserted in 01_build_corpus.py).
# ---------------------------------------------------------------------------

FEATURE_BLOCKS = {
    "context": [
        "qtr",                     # quarter at drive start (5 = OT)
        "is_ot",                   # overtime indicator
        "game_secs_rem",           # seconds remaining in game (clipped at 0)
        "game_secs_rem_log",       # log1p of the above
        "two_min",                 # two-minute-drill indicator at drive start
        "score_diff",              # posteam score minus defteam score at drive start
        "abs_score_diff",
        "offense_leading",         # score_diff > 0
        "yardline_100_start",      # yards from opponent goal line at drive start
        "down_start",              # down at drive start (almost always 1)
        "ydstogo_start",           # yards to go at drive start
        "off_timeouts_rem",        # timeouts remaining for possession team
        "def_timeouts_rem",        # timeouts remaining for defense
        "drive_idx_team",          # this possession's ordinal number within the game
    ],
    "player": [
        "p_prior_tpg",             # prior-season targets per game (games with usage)
        "p_prior_cth",             # prior-season smoothed catch rate
        "p_prior_share",           # prior-season share of team targets
        "p_prior_rpg",             # prior-season rushes per game
        "has_prior",               # 1 if prior-season usage exists
        "rookie",                  # 1 if registry rookie_season == current season
        "p_sts_tpg",               # season-to-date targets per game
        "p_sts_cth",               # season-to-date smoothed catch rate
        "p_sts_share",             # season-to-date share of team targets
        "p_sts_rpg",               # season-to-date rushes per game
        "p_games_so_far",          # games with usage so far this season
        "p_ingame_tgts_so_far",    # targets in current game before this drive
        "p_ingame_recs_so_far",    # receptions in current game before this drive
        "p_ingame_share",          # smoothed in-game share of team targets
        "p_blend_share",           # prior/season-to-date blended target share
        "p_blend_cth",             # blended catch rate
        "p_blend_recs_per_drive",  # blended rate of drives with >= 1 reception
        "pos_WR", "pos_TE", "pos_RB",
        "height_in",
    ],
    "team": [
        "t_games_so_far",          # team games completed this season
        "t_sts_tgts_per_drive",    # season-to-date team targets per drive
        "t_prior_tgts_per_drive",  # prior-season team targets per drive
        "t_blend_tgts_per_drive",  # blended
        "t_blend_comps_per_drive", # blended team completions per drive
    ],
    "defense": [
        "d_sts_comps_per_drive",   # opponent completions allowed per drive, season-to-date
        "d_prior_comps_per_drive", # same, prior season
    ],
}

ALL_FEATURES = [c for block in FEATURE_BLOCKS.values() for c in block]

# Baseline predictions (causal; included in the corpus for comparison, never used
# as model inputs by the incumbent).
BASELINE_COLS = ["b1_empirical", "b2_target_share", "b3_possession_survival"]

# Outcome-side columns: usable for evaluation only. The od_ prefix marks
# within-drive diagnostics that are NOT knowable at prediction time.
OUTCOME_COLS = ["y"] + [
    "od_drive_plays", "od_drive_tgts", "od_drive_comps", "od_drive_is_kneel",
]

KEY_COLS = [
    "game_id", "season", "week", "game_date", "drive", "drive_idx_team",
    "posteam", "defteam", "player_id", "player_name", "position", "pos_group",
]

LAG_REF_COLS = ["lag1_row", "lag2_row", "lag4_row"]

PROVENANCE = (
    "Data provided by nflverse (https://github.com/nflverse), play-by-play data from "
    "nflfastR, player and schedule data from the nflverse data repositories. "
    "Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)."
)
