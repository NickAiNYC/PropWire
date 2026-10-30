# propstein-live-sniper — research lineage (rebuild)

This repository/branch is the **independent rebuild lineage** of the PropStein Live
Sniper research track (Decisions 2C and 2D). It contains **research code and
artifacts only**: no live sportsbook adapters, no order-placement code, and no
production credentials. The model is **RESEARCH_ONLY**.

## Where everything lives

All research work — the rebuilt Decision 2C tail-calibration pipeline **and** the
Decision 2D historical-quote validation pilot — lives under:

```
research/drive-rec-v2/
  README.md               workspace readme (Decision 2C scope, rebuild disclosure, how to run)
  PROVENANCE.md           rebuild lineage, verification results, incorporation recipe
  DECISION_LOG.md         Decision 2C review outcome and Decision 2D authorization record
  HUMAN_REVIEW.md         present, UNSIGNED, status DEFERRED
  00–09_*.py              rebuilt pipeline (corpus → incumbent → criteria v3 → candidate → report)
  10_selection_amplification.py   EV-threshold selection-amplification diagnostic (Decision 2C review)
  verify_provenance.py    artifact-hash / corpus / ordering / split verification
  decision_2d/            precommitted execution contract + pilot harness (quotes pending)
  lib/                    shared loaders, metrics, clustered bootstrap
  docs/                   CRITERIA_V3.md, TAIL_RECALIBRATION_REPORT.md, Decision 2D docs
  artifacts/              every auditable output (models, predictions, gates, reports)
  data/                   gitignored raw nflverse downloads (reproducible via 00_download_data.py)
```

## Why this layout (Decision 2D §5)

The original engineering sandbox (including six local DRIVE-REC-V1 commits) was
lost before this rebuild. Those six commits are **documented as unrecovered**,
not restored. This lineage is explicitly independent; every number was re-measured
from public nflverse data (CC BY 4.0). See `research/drive-rec-v2/PROVENANCE.md`.

Nesting everything under `research/drive-rec-v2/` guarantees that incorporating
this work into the main repository **cannot replace the main repo's root README,
.gitignore, or any other root file**. The same applies to the delivered three-patch
series: apply it with `git apply --directory=research/drive-rec-v2` (tested; see
PROVENANCE.md §Incorporation) so all paths land inside the drive directory.

## Licensing

nflverse data only (CC BY 4.0, attribution in
`research/drive-rec-v2/LICENSES.md`). Big Data Bowl / NGS tracking data
(non-commercial) is excluded. No licensed sportsbook quote feed has been
purchased yet; all prior price-based analysis used **simulated (hypothetical)**
quotes.
