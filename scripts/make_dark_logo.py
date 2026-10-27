#!/usr/bin/env python3
"""Generate the light-theme (dark-ink) variant of the PropWire header lockup.

propwire-logo.svg is tuned for the dark terminal: near-white PROP text,
lime accents. On the light topbar (rgba(247,249,250,.97)) the near-white
text is invisible. This derives propwire-logo-dark.svg with an ink/green
palette that reads on light backgrounds. Deterministic; re-runnable.
"""
SOURCE = "viewer/propwire-logo.svg"
TARGET = "viewer/propwire-logo-dark.svg"
# near-white PROP -> light-theme ink; lime -> readable brand green; gray dot -> muted
REPLACEMENTS = {
    "#F3F4F6": "#17202b",
    "#B6F36B": "#4d7c0f",
    "#8B949E": "#526174",
}

svg = open(SOURCE).read()
for old, new in REPLACEMENTS.items():
    assert old in svg, f"expected fill {old} missing from source"
    svg = svg.replace(old, new)
open(TARGET, "w").write(svg)
print(f"written {TARGET} ({len(svg)} bytes)")
