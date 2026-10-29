#!/usr/bin/env python3
"""
v175 three-piece cache-bust sweep (honesty layer + P2, Task 61).

The v175 batch (real heartbeat probe, ledger-driven CLV ribbon, simulator
relabel, checkout auth) changed viewer assets (app.js / index.html /
style.css) — so the cache trio bumps with it:
  buster     2026_v174 (and older)    -> 2026_v175
  SW cache   propstein-v174-prod     -> propstein-v175-prod
  build-hash 2026-w8-v27 (and older) -> 2026-w8-v28

Also re-pins the 4 verification harnesses (verify_v152_books / v153_rebrand /
v154_dropwire / v155_photos .mjs) to the same v175 values. The visual harness
(verify_v175_visual.mjs) is intentionally version-agnostic (no pins).

Verification pass at the end: zero stale v171/v172/v173/v174 markers anywhere
in the swept viewer assets.
"""

from __future__ import annotations

from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
VIEWER = BASE / "viewer"

PAGES = [
    VIEWER / "index.html",
    VIEWER / "ledger.html",
    VIEWER / "ledger" / "index.html",
    VIEWER / "audit.html",
    VIEWER / "verify.html",
]
EXTRAS = [
    VIEWER / "sw.js",
    VIEWER / "site.webmanifest",
]
HARNESSES = [
    BASE / "scripts" / "verify_v152_books.mjs",
    BASE / "scripts" / "verify_v153_rebrand.mjs",
    BASE / "scripts" / "verify_v154_dropwire.mjs",
    BASE / "scripts" / "verify_v155_photos.mjs",
]

SWAPS = [
    # v174 -> v175 (normal bump; owner-official propstein- prefix retained)
    ("2026_v174", "2026_v175"),
    ("propwire-v174-prod", "propstein-v175-prod"),
    ("propstein-v174-prod", "propstein-v175-prod"),
    ("2026-w8-v27", "2026-w8-v28"),
    # v173/v172/v171-era -> v175 (defensive repair of any rewound pins)
    ("2026_v173", "2026_v175"),
    ("2026_v172", "2026_v175"),
    ("2026_v171", "2026_v175"),
    ("propwire-v173-prod", "propstein-v175-prod"),
    ("propwire-v172-prod", "propstein-v175-prod"),
    ("propwire-v171-prod", "propstein-v175-prod"),
    ("propstein-v173-prod", "propstein-v175-prod"),
    ("propstein-v172-prod", "propstein-v175-prod"),
    ("propstein-v171-prod", "propstein-v175-prod"),
    ("2026-w8-v26", "2026-w8-v28"),
    ("2026-w8-v25", "2026-w8-v28"),
    ("2026-w8-v24", "2026-w8-v28"),
]

STALE_MARKERS = [
    "2026_v171", "2026_v172", "2026_v173", "2026_v174",
    "propwire-v171-prod", "propwire-v172-prod", "propwire-v173-prod", "propwire-v174-prod",
    "propstein-v171-prod", "propstein-v172-prod", "propstein-v173-prod", "propstein-v174-prod",
    "2026-w8-v24", "2026-w8-v25", "2026-w8-v26", "2026-w8-v27",
]


def sweep_file(path: Path) -> bool:
    if not path.exists():
        raise SystemExit(f"FATAL: expected file missing: {path}")
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in SWAPS:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding="utf-8")
        print(f"[sweep] updated {path.relative_to(BASE)}")
        return True
    print(f"[sweep] no change  {path.relative_to(BASE)}")
    return False


def verify() -> int:
    stale = []
    for path in PAGES + EXTRAS:
        text = path.read_text(encoding="utf-8")
        for marker in STALE_MARKERS:
            if marker in text:
                stale.append(f"{path.relative_to(BASE)}: {marker}")
    if stale:
        print("[sweep] STALE MARKERS REMAIN:")
        for s in stale:
            print(f"   - {s}")
        return 1
    print("[sweep] CLEAN: zero stale v171/v172/v173/v174 markers in viewer assets")
    return 0


def main() -> None:
    changed = 0
    for path in PAGES + EXTRAS + HARNESSES:
        changed += 1 if sweep_file(path) else 0
    print(f"[sweep] {changed} file(s) updated")
    raise SystemExit(verify())


if __name__ == "__main__":
    main()
