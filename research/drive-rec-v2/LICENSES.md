# Data Licenses and Attribution

## Sources used by this workspace

| Dataset | Source | License | Commercial use |
| --- | --- | --- | --- |
| Play-by-play (seasons 2022–2026) | nflverse-data releases (`pbp` tag) | CC BY 4.0 | Yes, with attribution |
| Player registry | nflverse-data releases (`players` tag) | CC BY 4.0 | Yes, with attribution |
| Game schedule | nflverse `nfldata` repository | CC BY 4.0 | Yes, with attribution |

## Attribution statement (required by CC BY 4.0)

Any redistribution or reuse of derived data files from this workspace must carry the
following attribution:

> Data provided by nflverse (https://github.com/nflverse), play-by-play data from
> nflfastR, player and schedule data from the nflverse data repositories.
> Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

The per-file provenance manifest (`artifacts/provenance_manifest.json`) records, for every
downloaded file: source URL, download timestamp (UTC), season, SHA-256 hash, license, and
attribution text.

## Excluded sources (hard rule)

* **Big Data Bowl 2023 and any NGS tracking data**: competition data licensed for
  non-commercial use only. It is excluded from this pipeline and must not be introduced for
  any purpose, including evaluation. The player-participation fields that tracking data
  would provide (route participation, snap counts) are therefore **unavailable and remain
  missing** — they are never imputed or inferred as fact, per the agreed modeling boundary.
* **Sportsbook quote feeds**: no licensed historical quote data is included. All price-based
  analysis in this workspace uses clearly labeled **simulated** quotes.

## Consequence for missing participation data

Player-level features are limited to what is observable from public play-by-play: recorded
targets, receptions, rush attempts, and game context. Whether a player was on the field for
a given play is unknown and is not modeled. The player universe per drive is defined by a
documented, causally safe proxy rule (see `research/01_build_corpus.py` docstring).

## Vendor trial status (Decision 2D-V, 2026-10-30)

The hard rule above still holds for everything committed to this workspace: no
licensed sportsbook quotes are included yet. `vendor_trial_2dv/` contains only
SYNTHETIC harness-test fixtures (clearly labeled; refused by the canonical
quote store by design) plus the precommitted trial protocol. When real The
Odds API responses are acquired for the trial, they remain under
`vendor_trial_2dv/raw/` (git-ignored): storage and analysis are licensed under
the terms to be attached at `vendor_trial_2dv/ATTACHMENT_V8_COMMERCIAL_RIGHTS.md`;
committing vendor responses to a repository would be redistribution and is not
covered by the trial permission. Settlement cross-checks continue to use
nflverse play-by-play (CC BY 4.0, attribution above).
