"""00_download_data.py — acquire public nflverse inputs and record provenance.

Every file downloaded by this script is recorded in artifacts/provenance_manifest.json with:
  source URL, download timestamp (UTC), season/coverage, byte size, SHA-256 hash,
  license, and the required attribution text.

Licensing rules enforced here:
  * Only nflverse releases (CC BY 4.0) are fetched.
  * Big Data Bowl / NGS tracking data (non-commercial) is NOT fetched and must never be
    added to this pipeline.
  * No sportsbook quote data is fetched; no such license exists in this workspace.

The manifest is the authoritative dataset inventory for all downstream scripts.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import pathlib
import sys
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
DATA = REPO / "data"
ARTIFACTS = REPO / "artifacts"

PBP_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/pbp/"
    "play_by_play_{season}.parquet"
)
PLAYERS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
)
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

ATTRIBUTION = (
    "Data provided by nflverse (https://github.com/nflverse), play-by-play data from "
    "nflfastR, player and schedule data from the nflverse data repositories. "
    "Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)."
)
LICENSE = "CC BY 4.0"

PBP_SEASONS = [2022, 2023, 2024, 2025, 2026]


def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: pathlib.Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "propstein-research/2.0"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(dest, "wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)


def main() -> int:
    DATA.mkdir(exist_ok=True)
    ARTIFACTS.mkdir(exist_ok=True)

    downloads: list[dict] = []

    for season in PBP_SEASONS:
        url = PBP_URL.format(season=season)
        dest = DATA / f"play_by_play_{season}.parquet"
        entry = {
            "role": "play_by_play",
            "season": season,
            "note": (
                "2026 = season-to-date as of download; used only as a genuinely-unseen "
                "prospective evaluation slice"
                if season == 2026
                else "regular-season and postseason plays"
            ),
        }
        if dest.exists() and dest.stat().st_size > 0:
            print(f"[skip] {dest.name} already present")
        else:
            print(f"[get ] {url}")
            fetch(url, dest)
        entry.update(
            source_url=url,
            downloaded_at_utc=dt.datetime.now(dt.timezone.utc).isoformat(),
            bytes=dest.stat().st_size,
            sha256=sha256_of(dest),
            license=LICENSE,
            attribution=ATTRIBUTION,
        )
        downloads.append(entry)

    for role, url, fname in [
        ("player_registry", PLAYERS_URL, "players.csv"),
        ("game_schedule", GAMES_URL, "games.csv"),
    ]:
        dest = DATA / fname
        entry = {"role": role, "season": None, "note": "cross-season registry"}
        if dest.exists() and dest.stat().st_size > 0:
            print(f"[skip] {fname} already present")
        else:
            print(f"[get ] {url}")
            fetch(url, dest)
        entry.update(
            source_url=url,
            downloaded_at_utc=dt.datetime.now(dt.timezone.utc).isoformat(),
            bytes=dest.stat().st_size,
            sha256=sha256_of(dest),
            license=LICENSE,
            attribution=ATTRIBUTION,
        )
        downloads.append(entry)

    manifest = {
        "manifest_version": 1,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "policy": {
            "commercial_use": "nflverse CC BY 4.0 data only; attribution required",
            "excluded": [
                "Big Data Bowl 2023 and all NGS tracking data (non-commercial license)",
                "Any sportsbook quote feed (no license held); simulated quotes only",
            ],
        },
        "files": downloads,
    }
    out = ARTIFACTS / "provenance_manifest.json"
    with open(out, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[manifest] wrote {out} ({len(downloads)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
