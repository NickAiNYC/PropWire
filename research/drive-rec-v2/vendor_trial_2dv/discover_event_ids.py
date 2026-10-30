"""discover_event_ids.py — Decision 2D-V Stage A: build the VERIFIED
historical event-ID mapping (owner defect-1 fix, 2026-10-30).

WHY THIS EXISTS. The previous acquisition code discovered event IDs through
GET /sports/{sport_key}/events — a CURRENT-events endpoint that is not a
reliable way to discover completed games from 2025 or earlier in 2026
(project-owner code inspection, 2026-10-30). Vendor docs (retrieved
2026-10-30): completed games surface via GET /sports/{sport}/scores only
within daysFrom<=3, and there is no historical events-list endpoint. So the
event IDs for completed games must come from a recorded, verifiable source:

  (a) IDs captured while the games were upcoming (the sustainable pattern
      for the full acquisition: snapshot /events each week BEFORE games
      complete and archive the mapping);
  (b) owner-supplied candidate IDs (from the owner's own records, exports,
      or vendor support), verified here against the precommitted schedule;
  (c) owner attestation — owner authority, recorded honestly as such.

Every entry this tool writes records its discovery source and timestamp
(the owner's explicit requirement). Verification matches home/away teams
(through the nflverse -> vendor team-name table) and commence time against
the precommitted sample manifest schedule window.

Usage (project owner's machine; ODDS_API_KEY in the environment ONLY —
never in chat, arguments, or committed files):

  # candidates file: [{"game_id": "2025_06_ARI_IND", "event_id": "xxxx",
  #                    "sport_key": "playerprops_nfl",
  #                    "source_note": "captured 2025-10-11 from /events"}]
  python3 discover_event_ids.py --candidates candidates.json \
      --out raw_discovery

  # owner attestation (recorded as attested, source = owner note):
  python3 discover_event_ids.py --candidates candidates.json \
      --attest --attest-note "source: owner export 2026-10-30" \
      --out raw_discovery

  # optional probes (cheap, metered, honestly labeled):
  #   --probe-events  current-events endpoint; recorded as UNSUITABLE for
  #                   completed games (owner finding 2026-10-30)
  #   --probe-scores  completed games within daysFrom<=3 only (useful for
  #                   go-forward capture; will MISS the 2025 sample)

Output: raw_discovery/candidates_map.json (status per entry: verified /
attested / unverified), raw responses with SHA-256 sidecars, and a metered
credit ledger (same Meter as acquisition: baseline, retries, and every
probe request are measured from usage headers; fail-closed).

Promote verified/attested entries into artifacts/event_id_map.json, commit
the map, THEN run fetch_trial_quotes.py (Stage B). The map is the required
acquisition input; the fetcher refuses to run without it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from credit_meter import (BudgetExceeded, ConsumptionUnestablished,  # noqa: E402
                          Meter, documented_cost, load_config)
from fetch_trial_quotes import (TEAM_NAMES, norm_team, redact,  # noqa: E402
                                sha256_bytes, stamp)


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def load_candidates(path: Path) -> list[dict]:
    doc = json.loads(Path(path).read_text())
    items = doc if isinstance(doc, list) else doc.get("candidates", [])
    out = []
    for it in items:
        out.append({
            "game_id": it.get("game_id"),
            "event_id": it.get("event_id"),
            "sport_key": it.get("sport_key") or "playerprops_nfl",
            "source_note": it.get("source_note") or "",
        })
    return out


def verify_against_schedule(entry: dict, game: dict, cfg: dict) -> tuple[bool, list[str]]:
    """Structural verification of a candidate entry against the schedule.

    Team names normalize through the nflverse->vendor table; commence time
    must be inside the precommitted schedule window. Returns (ok, matches).
    """
    tol_h = cfg["commence_vs_schedule_tolerance_hours"]
    matches: list[str] = []
    problems: list[str] = []
    for field in ("home_team", "away_team"):
        want = norm_team(TEAM_NAMES.get(game[field], game[field]))
        got = norm_team(entry.get(f"{field}_verified", "") or "")
        if not got:
            problems.append(f"{field} not returned by verification source")
        elif want != got:
            problems.append(f"{field} {got!r} != schedule {game[field]}")
        else:
            matches.append(field)
    cv = entry.get("commence_time_verified")
    if not cv:
        problems.append("commence_time not returned by verification source")
    else:
        c = parse_iso(cv)
        gameday = datetime.strptime(game["gameday"], "%Y-%m-%d").replace(
            tzinfo=timezone.utc)
        if not (gameday - timedelta(hours=tol_h)
                <= c <= gameday + timedelta(hours=36)):
            problems.append(f"commence_time {cv} outside schedule window "
                            f"around {game['gameday']}")
        else:
            matches.append("commence_time")
    return (not problems), matches + problems


def _selftest() -> int:
    """Offline validation of the map-gate logic (no network, no key, no
    ledger): the same structural checks V3 applies to the acquisition map."""
    cfg = load_config()
    game = {"game_id": "SYN25_G01", "gameday": "2025-10-12",
            "home_team": "IND", "away_team": "ARI"}
    good = {"game_id": "SYN25_G01", "event_id": "ev1",
            "sport_key": "playerprops_nfl", "status": "verified",
            "discovery_source": "synthetic", "discovery_timestamp_utc":
            "2026-10-30T00:00:00Z",
            "home_team_verified": "Indianapolis Colts",
            "away_team_verified": "Arizona Cardinals",
            "commence_time_verified": "2025-10-12T17:00:00Z"}
    bad_team = dict(good, home_team_verified="Kansas City Chiefs")
    bad_ts = dict(good, discovery_timestamp_utc=None)
    ok_good, _ = verify_against_schedule(good, game, cfg)
    ok_team, _ = verify_against_schedule(bad_team, game, cfg)
    ok_ts = bool(bad_ts.get("discovery_timestamp_utc"))
    checks = [
        ("verified entry passes", ok_good),
        ("team mismatch rejected", not ok_team),
        ("null discovery timestamp rejected", not ok_ts),
    ]
    failed = [name for name, ok in checks if not ok]
    print(json.dumps({"discover_selftest": "PASS" if not failed else "FAIL",
                      "checks": {n: bool(o) for n, o in checks}}, indent=2))
    return 0 if not failed else 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--candidates", type=Path, default=None,
                    help="JSON file of candidate event IDs (see module docstring)")
    ap.add_argument("--sample-manifest", type=Path,
                    default=HERE / "artifacts" / "sample_manifest.json")
    ap.add_argument("--out", type=Path, default=Path("raw_discovery"))
    ap.add_argument("--attest", action="store_true",
                    help="mark candidates attested (owner authority) instead "
                         "of API-verified")
    ap.add_argument("--attest-note", default="")
    ap.add_argument("--probe-events", action="store_true",
                    help="also probe the CURRENT-events endpoint (recorded "
                         "as unsuitable for completed games)")
    ap.add_argument("--probe-scores", action="store_true",
                    help="also probe /scores with daysFrom=3 (completed "
                         "games within 3 days only)")
    ap.add_argument("--selftest", action="store_true",
                    help="offline validation of map-gate logic (no network)")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(_selftest())

    cfg = load_config()
    key = os.environ.get(cfg["vendor"]["env_key_name"])
    if not key:
        raise SystemExit(
            f"REAL mode requires the API key in the environment variable "
            f"{cfg['vendor']['env_key_name']} (never pass it as an argument, "
            "never paste it into chat or files).")
    if args.attest and not args.candidates:
        ap.error("--attest requires --candidates")
    if args.candidates is None and not (args.probe_events or args.probe_scores):
        ap.error("nothing to do: provide --candidates and/or a --probe-* flag")

    sample = json.loads(Path(args.sample_manifest).read_text())
    games = {g["game_id"]: g for g in sample["games"]}
    out = Path(args.out)
    (out / "responses").mkdir(parents=True, exist_ok=True)
    meter = Meter(cfg, out / "credit_ledger.jsonl", "REAL")
    base = cfg["vendor"]["base_url"]
    files: list[dict] = []
    entries: list[dict] = []

    def persist(name: str, body: bytes, meta: dict) -> None:
        rel = Path("responses") / name
        (out / rel).write_bytes(body)
        meta["content_sha256"] = sha256_bytes(body)
        (out / (str(rel) + ".meta.json")).write_text(
            json.dumps(meta, indent=2, sort_keys=True) + "\n")
        files.append({"path": str(rel), "sha256": meta["content_sha256"],
                      "bytes": len(body), "role": "response"})

    def metered(url: str, kind: str, purpose: str, name: str,
                params_extra: dict | None = None):
        params = {"apikey": key, **(params_extra or {})}
        modeled = documented_cost(kind, cfg)
        for attempt in range(1, int(cfg.get("retry", {}).get(
                "max_attempts", 3)) + 1):
            meter.authorize(modeled, context=f"{kind}/{purpose} attempt {attempt}")
            full = url + "?" + urllib.parse.urlencode(params)
            try:
                req = urllib.request.Request(full, method="GET")
                try:
                    with urllib.request.urlopen(req, timeout=30) as r:
                        body, status, headers = r.read(), r.status, \
                            {k.lower(): v for k, v in r.headers.items()}
                except urllib.error.HTTPError as e:
                    body, status, headers = e.read(), e.code, \
                        {k.lower(): v for k, v in (e.headers or {}).items()}
            except urllib.error.URLError as e:
                meter.observe(kind, f"{purpose} (attempt {attempt}, network "
                                    f"error)", None, {})
                time.sleep(2)
                continue
            retryable = set(cfg.get("retry", {}).get(
                "retryable_status", [429, 500, 502, 503, 504]))
            if status in retryable and attempt < 3:
                meter.observe(kind, f"{purpose} (attempt {attempt}, "
                                    f"retryable status {status})", status,
                              headers)
                time.sleep(float(headers.get("retry-after", "2")))
                continue
            try:
                meter.observe(kind, purpose, status, headers,
                              {"raw_file": str(Path("responses") / name)})
            except ConsumptionUnestablished:
                persist(name, body, {"request_kind": kind, "purpose": purpose,
                                     "url_redacted": redact(url),
                                     "http_status": status,
                                     "consumption_unestablished": True,
                                     "fetched_at_utc": stamp("REAL")})
                raise
            persist(name, body, {"request_kind": kind, "purpose": purpose,
                                 "url_redacted": redact(url),
                                 "http_status": status,
                                 "fetched_at_utc": stamp("REAL")})
            return body, status
        raise ConsumptionUnestablished(
            f"{kind}/{purpose}: retries exhausted; consumption cannot be "
            "established")

    partial_reason = None
    try:
        # zero-cost baseline: two GET /v4/sports calls (docs: unmetered)
        for i in (1, 2):
            metered(f"{base}/sports", "baseline_sports",
                    f"usage-baseline-{i}", f"baseline_sports_{i}.json")

        # optional probes — cheap, metered, honestly labeled
        if args.probe_events:
            url = f"{base}/sports/{cfg['sport_key_candidates'][0]}/events"
            metered(url, "events_probe",
                    "current-events probe (UNSUITABLE for completed games — "
                    "owner finding 2026-10-30)", "probe_events.json")
        if args.probe_scores:
            url = f"{base}/sports/{cfg['sport_key_candidates'][0]}/scores"
            metered(url, "events_probe",
                    "scores probe daysFrom=3 (completed games within 3 days "
                    "only)", "probe_scores.json",
                    {"daysFrom": "3"})

        # candidate verification via event detail (1 modeled credit each)
        candidates = load_candidates(args.candidates) if args.candidates else []
        for c in candidates:
            game = games.get(c["game_id"])
            if game is None:
                entries.append({**c, "status": "unverified",
                                "note": "game_id not in precommitted sample"})
                continue
            entry = {
                "game_id": c["game_id"],
                "event_id": c.get("event_id"),
                "sport_key": c.get("sport_key"),
                "status": "unverified",
                "discovery_source": None,
                "discovery_timestamp_utc": None,
                "commence_time_verified": None,
                "home_team_verified": None,
                "away_team_verified": None,
                "verification": {},
            }
            if args.attest:
                entry.update({
                    "status": "attested",
                    "discovery_source": "owner-attestation:"
                                        + (args.attest_note or "unspecified"),
                    "discovery_timestamp_utc": stamp("REAL"),
                    "note": "attested by project owner (owner authority); "
                            "field verification deferred to acquisition V3",
                })
                entries.append(entry)
                continue
            if not c.get("event_id"):
                entry["note"] = "null event_id in candidates file"
                entries.append(entry)
                continue
            url = (f"{base}/sports/{c.get('sport_key')}/events/"
                   f"{c['event_id']}")
            name = f"event_detail_{c['game_id']}.json"
            body, status = metered(url, "event_detail",
                                    f"verify {c['game_id']}", name)
            try:
                doc = json.loads(body) if status == 200 else {}
            except json.JSONDecodeError:
                doc = {}
            if isinstance(doc, list) and doc:
                doc = doc[0]
            entry.update({
                "home_team_verified": doc.get("home_team"),
                "away_team_verified": doc.get("away_team"),
                "commence_time_verified": doc.get("commence_time"),
            })
            ok, detail = verify_against_schedule(entry, game, cfg)
            entry["discovery_source"] = f"event-detail:{redact(url)}"
            entry["discovery_timestamp_utc"] = stamp("REAL")
            entry["status"] = "verified" if (ok and status == 200) else "unverified"
            entry["verification"] = {
                "http_status": status,
                "fields": detail,
                "method": "GET /v4/sports/{sport}/events/{eventId} vs "
                          "precommitted schedule",
            }
            if status != 200:
                entry["note"] = (f"event detail HTTP {status} — event may no "
                                 "longer be served post-completion (expected "
                                 "for old games); use owner attestation or "
                                 "captured IDs")
            entries.append(entry)
    except (BudgetExceeded, ConsumptionUnestablished) as e:
        partial_reason = str(e)
        print(f"ABORTED PARTIAL: {e}", file=sys.stderr)

    candidates_map = {
        "trial_id": cfg["trial_id"],
        "generated_utc": stamp("REAL"),
        "policy": ("Stage-A candidate event-ID map. Entries marked 'verified' "
                   "passed event-detail field verification against the "
                   "precommitted schedule; 'attested' carry owner authority; "
                   "everything else is 'unverified' and MUST NOT be used for "
                   "acquisition. Promote into artifacts/event_id_map.json "
                   "after review, then commit."),
        "partial_reason": partial_reason,
        "measured_credits": meter.spent,
        "entries": entries,
    }
    (out / "candidates_map.json").write_text(
        json.dumps(candidates_map, indent=2, sort_keys=True) + "\n")
    manifest = {
        "stage": "discovery",
        "mode": "REAL",
        "generated_utc": stamp("REAL"),
        "partial_reason": partial_reason,
        "measured_credits": meter.spent,
        "files": sorted(files, key=lambda f: f["path"]),
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    n_verified = sum(1 for e in entries if e.get("status") == "verified")
    n_attested = sum(1 for e in entries if e.get("status") == "attested")
    print(f"discovery stage: {len(entries)} candidate(s); "
          f"{n_verified} verified, {n_attested} attested, "
          f"{len(entries) - n_verified - n_attested} unverified")
    print(f"measured credits: {meter.spent} / cap {meter.cap}")
    print(f"map: {out / 'candidates_map.json'}")


if __name__ == "__main__":
    main()
