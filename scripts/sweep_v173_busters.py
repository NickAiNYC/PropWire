#!/usr/bin/env python3
"""
v173 three-piece cache-bust sweep (PropStein rebrand discipline repair).

The owner's rebrand batch (c651dad..0e53529) changed viewer assets (logo suite,
telemetry ribbon, line pulse, card density) and rewrote audit/ledger/verify.html
head sections — but LEFT THE CACHE BUSTERS BEHIND:
  - audit.html / verify.html were REWOUND to v171-era pins (?v=2026_v171,
    build-hash 2026-w8-v24) by scripts/install_propstein_lighter_logo.py
  - ledger.html / index.html partially kept v172 pins
  - sw.js cache name stayed propwire-v172-prod (icons changed content!)

This sweep bumps EVERYTHING to the v173 trio AND repairs the rewound pins:
  buster     2026_v172 / 2026_v171 -> 2026_v173
  SW cache   propwire-v172-prod    -> propwire-v173-prod
  build-hash 2026-w8-v25 / v24     -> 2026-w8-v26

Also re-pins the 4 verification harnesses (verify_v152_books / v153_rebrand /
v154_dropwire / v155_photos .mjs) to the same v173 values.

Verification pass at the end: zero stale v171/v172 markers anywhere in the
swept viewer assets.
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
    # v172 -> v173 (normal bump)
    ("2026_v172", "2026_v173"),
    ("propwire-v172-prod", "propwire-v173-prod"),
    ("2026-w8-v25", "2026-w8-v26"),
    # v171-era -> v173 (repair of the rebrand rewind)
    ("2026_v171", "2026_v173"),
    ("propwire-v171-prod", "propwire-v173-prod"),
    ("2026-w8-v24", "2026-w8-v26"),
]

STALE_MARKERS = [
    "2026_v171", "2026_v172",
    "propwire-v171-prod", "propwire-v172-prod",
    "2026-w8-v24", "2026-w8-v25",
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
    print("[sweep] CLEAN: zero stale v171/v172 markers in viewer assets")
    return 0


def main() -> None:
    changed = 0
    for path in PAGES + EXTRAS + HARNESSES:
        changed += 1 if sweep_file(path) else 0
    print(f"[sweep] {changed} file(s) updated")
    raise SystemExit(verify())


if __name__ == "__main__":
    main()
