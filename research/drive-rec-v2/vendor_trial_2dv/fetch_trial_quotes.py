"""fetch_trial_quotes.py — Decision 2D-V trial acquisition (The Odds API).

PATCHED 2026-10-30 after the project owner's code inspection found two
material defects (PATCH_LOG_2026-10-30.md). Everything else — modes,
credential handling, redaction, persistence layout, PRECOMMITMENT.md
P2/P6 — is unchanged.

DEFECT 1 (fixed) — historical event discovery. The previous version
  discovered event IDs via GET /sports/{sport_key}/events, a CURRENT-events
  endpoint that is not a reliable way to discover completed games from 2025
  or earlier in 2026 (owner finding 2026-10-30; vendor docs: completed games
  surface via /scores only within daysFrom=3). Acquisition now requires a
  VERIFIED event-ID mapping (event_id_map.json) in which every entry
  records its discovery source and timestamp. The map is built BEFORE any
  quote request by discover_event_ids.py (Stage A) or owner attestation;
  games without a verified entry are ledgered as discovery misses and never
  requested. The map actually used is copied byte-for-byte into the run
  directory and hash-listed in the manifest (tamper-evident; V3 verifies
  provenance fields).

DEFECT 2 (fixed) — actual credit measurement. REAL mode previously
  initialized before_rem=None, so actual_credits, cumulative spending, and
  the 600-credit cap could never be computed from real balances, and
  discovery requests / HTTP retries were not budget-guarded at all. Now
  credit_meter.Meter reads the vendor's usage headers (x-requests-used
  cumulative, x-requests-remaining, x-requests-last per-call) on EVERY
  response of EVERY request kind — baseline, discovery, retries, quote
  pulls — reconciles the three against each other, enforces the cap
  pre-request AND post-observation, and the run FAILS CLOSED (aborts
  PARTIAL) whenever consumption cannot be established or headers disagree.

Modes:
  REAL (default): pulls historical event-odds for the precommitted trial
  sample. Requires the API key in the environment variable ODDS_API_KEY
  (trial_config.json env_key_name) AND a verified event-ID map. THE KEY IS
  NEVER WRITTEN, LOGGED, OR COMMITTED: request URLs are redacted before
  storage; the key is not accepted from any file inside the repository.

  --dry-run --fixtures <dir>: exercises the full request-plan/orchestration
  path against SYNTHETIC fixture responses (no network, no credits). Output
  layout is byte-identical to real mode so the V1-V10 verifier runs
  unmodified — including the metering path (the fixture server simulates
  usage headers, so dry-run exercises the same fail-closed code).
"""

from __future__ import annotations

import argparse
import hashlib
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
                          Meter, documented_cost, ledger_summary,
                          load_config, request_cost)

DRY_RUN_STAMP = "SYNTHETIC-DRY-RUN-FIXTURES"

# nflverse schedule abbreviations -> The Odds API team-name strings (matching
# is case/punctuation-insensitive; unmatched teams are LEDGERED, never guessed).
TEAM_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons",
    "BAL": "Baltimore Ravens", "BUF": "Buffalo Bills",
    "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns",
    "DAL": "Dallas Cowboys", "DEN": "Denver Broncos",
    "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts",
    "JAX": "Jacksonville Jaguars", "KC": "Kansas City Chiefs",
    "LAC": "Los Angeles Chargers", "LA": "Los Angeles Rams",
    "LAR": "Los Angeles Rams", "LV": "Las Vegas Raiders",
    "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints",
    "NYG": "New York Giants", "NYJ": "New York Jets",
    "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers",
    "TB": "Tampa Bay Buccaneers", "TEN": "Tennessee Titans",
    "WAS": "Washington Commanders", "WSH": "Washington Commanders",
}


def norm_team(s: str) -> str:
    return "".join(ch for ch in str(s).lower() if ch.isalnum())


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def redact(url: str) -> str:
    return urllib.parse.urlparse(url)._replace(
        query="apikey=REDACTED").geturl() if "apikey=" in url else url


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def stamp(mode: str) -> str:
    return now_iso() if mode == "REAL" else DRY_RUN_STAMP


class Fetcher:
    def __init__(self, cfg: dict, mode: str, out_dir: Path,
                 fixtures_dir: Path | None, sport_key: str, market: str,
                 event_map_path: Path):
        self.cfg = cfg
        self.mode = mode                      # "REAL" | "DRY_RUN"
        self.out = out_dir
        self.resp_dir = out_dir / "responses"
        self.infra_dir = out_dir / "infra"
        self.resp_dir.mkdir(parents=True, exist_ok=True)
        self.infra_dir.mkdir(parents=True, exist_ok=True)
        self.fixtures = fixtures_dir
        self.sport_key = sport_key
        self.market = market
        self.base = cfg["vendor"]["base_url"]
        self.key = os.environ.get(cfg["vendor"]["env_key_name"]) if mode == "REAL" else None
        self.event_map_path = Path(event_map_path)
        self.meter = Meter(cfg, out_dir / "credit_ledger.jsonl", mode)
        self.files: list[dict] = []
        self.used_sim = 0                     # dry-run simulated cumulative usage
        self.remaining_sim = 10_000           # dry-run simulated balance
        self.discovery_misses: list[str] = []
        self.event_map_summary: dict = {}
        self.partial = False
        self.partial_reason: str | None = None
        retry_cfg = cfg.get("retry", {})
        self.max_attempts = int(retry_cfg.get("max_attempts", 3))
        self.retryable = set(retry_cfg.get("retryable_status",
                                           [429, 500, 502, 503, 504]))
        self.backoff = float(retry_cfg.get("backoff_seconds", 2.0))

    # ---------------- request plumbing ----------------
    def _fixture_response(self, params: dict,
                          kind: str) -> tuple[bytes, int, dict]:
        """Synthetic vendor server: deterministic bodies + simulated usage
        headers (so dry-run exercises the REAL metering code path)."""
        assert self.fixtures is not None
        name = params["_fixture_name"]
        path = self.fixtures / "responses" / name
        if not path.exists():
            return (json.dumps({"error_code": 404,
                                "message": f"fixture missing: {name}"}).encode(),
                    404, {})
        doc = json.loads(path.read_text())
        sim = doc.pop("_sim", {}) if isinstance(doc, dict) else {}
        default_cost = 0 if kind == "baseline_sports" else request_cost(1, 1)
        cost = int(sim.get("credit_cost", default_cost))
        self.used_sim += cost
        self.remaining_sim -= cost
        headers = {}
        if not sim.get("omit_usage_headers"):
            headers = {"x-requests-remaining": str(self.remaining_sim),
                       "x-requests-used": str(self.used_sim),
                       "x-requests-last": str(cost)}
        return (json.dumps(doc, indent=2, sort_keys=True).encode(), 200,
                headers)

    def _raw_http(self, url: str, params: dict) -> tuple[bytes, int, dict]:
        """ONE HTTP GET (no retry logic here — retries are metered per
        attempt by _metered_http)."""
        if self.mode == "DRY_RUN":
            return self._fixture_response(params, params.get("_kind",
                                                             "historical_event_odds"))
        query = {k: v for k, v in params.items() if not k.startswith("_")}
        full = url + "?" + urllib.parse.urlencode(query)
        req = urllib.request.Request(full, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read(), r.status, {k.lower(): v
                                            for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            return e.read(), e.code, {k.lower(): v
                                      for k, v in (e.headers or {}).items()}
        # urllib.error.URLError propagates -> handled as no-response

    def _metered_http(self, *, url: str, params: dict, kind: str,
                      purpose: str, persist_as: Path | None = None,
                      meta_extra: dict | None = None,
                      fixture_name: str | None = None
                      ) -> tuple[bytes, int, dict]:
        """One request: authorized, retried, metered, persisted.

        - every attempt is authorized against the cap BEFORE the request
          (retries and discovery count toward the budget);
        - every response is observed by the Meter (fail-closed on missing /
          disagreeing usage headers — ConsumptionUnestablished aborts the
          run PARTIAL);
        - the final response body is persisted with redacted metadata and a
          SHA-256 sidecar when persist_as is given; an unestablished final
          response is still persisted (the body is evidence) before the
          abort propagates.
        """
        p = dict(params)
        if self.mode == "DRY_RUN":
            if fixture_name is None:
                raise ValueError("dry-run requires fixture_name")
            p["_fixture_name"] = fixture_name
            p["_kind"] = kind
        modeled = documented_cost(kind, self.cfg)
        last_err = None
        for attempt in range(1, self.max_attempts + 1):
            self.meter.authorize(modeled,
                                 context=f"{kind}/{purpose} attempt {attempt}")
            try:
                body, status, headers = self._raw_http(url, p)
            except urllib.error.URLError as e:
                last_err = str(e.reason)
                self.meter.observe(kind, f"{purpose} (attempt {attempt}, "
                                         f"network error)", None, {},
                                   {"attempt": attempt,
                                    **(meta_extra or {})})
                if attempt < self.max_attempts:
                    time.sleep(self.backoff if self.mode == "REAL" else 0.0)
                    continue
                raise ConsumptionUnestablished(
                    f"{kind}/{purpose}: network error after "
                    f"{self.max_attempts} attempts ({last_err}); consumption "
                    "cannot be established")
            if status in self.retryable and attempt < self.max_attempts:
                self.meter.observe(kind, f"{purpose} (attempt {attempt}, "
                                         f"retryable status {status})",
                                   status, headers,
                                   {"attempt": attempt, **(meta_extra or {})})
                wait = headers.get("retry-after")
                delay = (int(wait) if wait is not None else self.backoff)
                time.sleep(delay if self.mode == "REAL" else 0.0)
                continue
            try:
                row = self.meter.observe(kind, purpose, status, headers,
                                         {"attempt": attempt,
                                          **({"raw_file": str(persist_as)}
                                             if persist_as else {}),
                                          **(meta_extra or {})})
            except ConsumptionUnestablished:
                if persist_as is not None:
                    meta = self._meta(url, kind, purpose, status, attempt,
                                      meta_extra)
                    meta["consumption_unestablished"] = True
                    self._persist(persist_as, body, meta)
                raise
            if persist_as is not None:
                meta = self._meta(url, kind, purpose, status, attempt,
                                  meta_extra)
                meta["actual_credits"] = row.get("actual_credits")
                meta["x_requests_last"] = row.get("x_requests_last")
                meta["cumulative_actual_after"] = row.get(
                    "cumulative_actual_after")
                self._persist(persist_as, body, meta)
            return body, status, headers
        raise ConsumptionUnestablished(
            f"{kind}/{purpose}: retries exhausted ({last_err}); consumption "
            "cannot be established")

    def _meta(self, url: str, kind: str, purpose: str, status: int | None,
              attempt: int, meta_extra: dict | None) -> dict:
        meta = {
            "request_kind": kind, "purpose": purpose,
            "url_redacted": redact(url), "http_status": status,
            "mode": self.mode, "attempt": attempt,
            "fetched_at_utc": stamp(self.mode),
        }
        meta.update(meta_extra or {})
        return meta

    # ---------------- persistence ----------------
    def _persist(self, rel_path: Path, body: bytes, meta: dict) -> None:
        (self.out / rel_path).write_bytes(body)
        meta["content_sha256"] = sha256_bytes(body)
        meta_path = self.out / (str(rel_path) + ".meta.json")
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")
        self.files.append({"path": str(rel_path),
                           "sha256": meta["content_sha256"],
                           "bytes": len(body), "role": "response"})
        self.files.append({"path": str(meta_path.relative_to(self.out)),
                           "sha256": sha256_bytes(meta_path.read_bytes()),
                           "bytes": len(meta_path.read_bytes()),
                           "role": "meta"})

    # ---------------- baseline + event-ID map ----------------
    def _establish_baseline(self) -> None:
        """Two zero-cost GET /v4/sports calls establish the cumulative-usage
        baseline (vendor docs: /v4/sports does not count against usage). The
        second call's used-delta verifies the first was free; from here on
        every request's actual cost is an exact cumulative-counter delta."""
        for i in (1, 2):
            params = ({"apikey": self.key} if self.mode == "REAL" else {})
            self._metered_http(
                url=f"{self.base}/sports", params=params,
                kind="baseline_sports", purpose=f"usage-baseline-{i}",
                persist_as=Path("infra") / f"baseline_sports_{i}.json",
                fixture_name="sports_list.json")

    def _load_event_map(self, sample: dict) -> dict[str, dict]:
        """DEFECT-1 fix: verified event-ID mapping replaces the current-events
        endpoint. The exact map used is copied into the run directory."""
        doc = json.loads(self.event_map_path.read_text())
        entries = {e.get("game_id"): e for e in doc.get("entries", [])}
        dst = self.out / "event_id_map.json"
        dst.write_bytes(self.event_map_path.read_bytes())
        self.files.append({"path": "event_id_map.json",
                           "sha256": sha256_bytes(dst.read_bytes()),
                           "bytes": len(dst.read_bytes()),
                           "role": "event_map"})
        usable, missing = {}, []
        for game in sample["games"]:
            e = entries.get(game["game_id"])
            if e is None:
                missing.append(f"{game['game_id']}: no event_id_map entry")
            elif not e.get("event_id"):
                missing.append(f"{game['game_id']}: map entry has null "
                               "event_id (undiscovered)")
            elif e.get("status") != "verified":
                missing.append(
                    f"{game['game_id']}: map entry status "
                    f"{e.get('status')!r} != 'verified'")
            else:
                usable[game["game_id"]] = e
        self.discovery_misses.extend(
            f"{m}; quote requests SKIPPED (fail-closed)" for m in missing)
        self.event_map_summary = {
            "source_path": str(self.event_map_path),
            "sha256": sha256_bytes(dst.read_bytes()),
            "n_entries": len(entries),
            "n_verified_usable": len(usable),
            "games_without_verified_entry": sorted(
                g["game_id"] for g in sample["games"]
                if g["game_id"] not in usable),
        }
        return usable

    # ---------------- plan ----------------
    def run(self, sample: dict) -> None:
        offsets = self.cfg["observation_offsets_minutes"]
        modeled_per_pull = request_cost(1, 1)
        try:
            self._establish_baseline()
            entries = self._load_event_map(sample)
            for game in sample["games"]:
                entry = entries.get(game["game_id"])
                if entry is None:
                    continue
                kickoff = datetime.fromisoformat(
                    str(entry["commence_time_verified"]).replace("Z", "+00:00"))
                sport = entry.get("sport_key") or self.sport_key
                for label, off_min in offsets.items():
                    decision_ts = kickoff + timedelta(minutes=off_min)
                    self._pull_quote(game, entry, sport, label, decision_ts,
                                     modeled_per_pull)
                    time.sleep(self.cfg["request_delay_seconds"]
                               if self.mode == "REAL" else 0.0)
        except BudgetExceeded as e:
            self.partial = True
            self.partial_reason = str(e)
            print(f"ABORTED PARTIAL: {e}", file=sys.stderr)
        except ConsumptionUnestablished as e:
            self.partial = True
            self.partial_reason = str(e)
            print(f"ABORTED PARTIAL (consumption): {e}", file=sys.stderr)
        self._write_manifest(sample)

    def _pull_quote(self, game: dict, entry: dict, sport: str, label: str,
                    decision_ts: datetime, modeled: int) -> None:
        evid = str(entry["event_id"])
        name = f"{game['game_id']}__{label}.json"
        params = {
            "date": decision_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "regions": self.cfg["region"],
            "markets": self.market,
            "oddsFormat": self.cfg["odds_format"],
        }
        if self.mode == "REAL":
            params["apikey"] = self.key
        url = (f"{self.base}/historical/sports/{sport}/events/"
               f"{evid}")
        meta_extra = {
            "game_id": game["game_id"], "event_id": evid,
            "offset_label": label,
            "decision_ts_utc": decision_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sport_key": sport, "market": self.market,
            "regions": [self.cfg["region"]],
            "params": {
                "date": params["date"], "regions": params["regions"],
                "markets": self.market, "oddsFormat": params["oddsFormat"]},
            "modeled_credits": modeled,
            "kickoff_verified_utc": entry.get("commence_time_verified"),
            "discovery_source": entry.get("discovery_source"),
            "discovery_timestamp_utc": entry.get("discovery_timestamp_utc"),
        }
        self._metered_http(
            url=url, params=params, kind="historical_event_odds",
            purpose=f"{game['game_id']}@{label}",
            persist_as=Path("responses") / name,
            meta_extra=meta_extra, fixture_name=name)

    def _write_manifest(self, sample: dict) -> None:
        cons = ledger_summary(self.meter.ledger_path)
        manifest = {
            "trial_id": self.cfg["trial_id"],
            "mode": self.mode,
            "data_label": ("REAL_VENDOR_RESPONSES" if self.mode == "REAL"
                           else "SYNTHETIC-HARNESS-TEST"),
            "created_utc": stamp(self.mode),
            "sport_key": self.sport_key,
            "market": self.market,
            "regions": [self.cfg["region"]],
            "observation_offsets_minutes": self.cfg["observation_offsets_minutes"],
            "discovery_misses": self.discovery_misses,
            "event_id_map": self.event_map_summary,
            "partial": self.partial,
            "partial_reason": self.partial_reason,
            "consumption": {
                "credit_budget_cap": self.meter.cap,
                "measured_actual_total": cons["actual_total"],
                "by_kind": cons["by_kind"],
                "n_metered_rows": cons["n_rows"],
                "n_unestablished_rows": cons["n_unestablished"],
            },
            "files": sorted(self.files, key=lambda f: f["path"]),
            "credit_ledger": "credit_ledger.jsonl",
        }
        (self.out / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fixtures", type=Path, default=None,
                    help="fixtures dir (dry-run): contains sample_manifest.json, event_id_map.json, responses/, independent_stats.csv")
    ap.add_argument("--out", type=Path, default=Path("raw"))
    ap.add_argument("--sample-manifest", type=Path, default=None)
    ap.add_argument("--event-map", type=Path, default=None,
                    help="event-ID map override (default: fixtures dir in dry-run; artifacts/event_id_map.json in REAL mode)")
    ap.add_argument("--config-override", type=Path, default=None,
                    help="JSON layered over trial_config.json (harness tests only)")
    ap.add_argument("--sport-key", default=None)
    ap.add_argument("--market", default=None)
    args = ap.parse_args()
    cfg = load_config(args.config_override)

    if args.dry_run:
        if args.fixtures is None:
            ap.error("--dry-run requires --fixtures")
        sample = json.loads((args.fixtures / "sample_manifest.json").read_text())
        map_path = args.event_map or (args.fixtures / "event_id_map.json")
        if not Path(map_path).exists():
            raise SystemExit(
                f"event-ID map required ({map_path}): acquisition refuses to "
                "run without a verified historical event-ID mapping (owner "
                "defect-1 fix, 2026-10-30). Build it with discover_event_ids.py "
                "or owner attestation, then retry.")
        fetcher = Fetcher(cfg, "DRY_RUN", args.out, args.fixtures,
                          sport_key=args.sport_key or "playerprops_nfl",
                          market=args.market or cfg["market_candidates"][0],
                          event_map_path=Path(map_path))
    else:
        key = os.environ.get(cfg["vendor"]["env_key_name"])
        if not key:
            raise SystemExit(
                f"REAL mode requires the API key in the environment variable "
                f"{cfg['vendor']['env_key_name']} (never pass it as an argument, "
                "never paste it into chat or files).")
        sample_path = args.sample_manifest or (HERE / "artifacts" / "sample_manifest.json")
        sample = json.loads(Path(sample_path).read_text())
        map_path = args.event_map or (HERE / "artifacts" / "event_id_map.json")
        if not Path(map_path).exists():
            raise SystemExit(
                f"event-ID map required ({map_path}): REAL acquisition refuses "
                "to run without a verified historical event-ID mapping (owner "
                "defect-1 fix, 2026-10-30). See discover_event_ids.py (Stage A).")
        fetcher = Fetcher(cfg, "REAL", args.out, None,
                          sport_key=args.sport_key or cfg["sport_key_candidates"][0],
                          market=args.market or cfg["market_candidates"][0],
                          event_map_path=Path(map_path))

    fetcher.run(sample)
    print(f"mode={fetcher.mode} out={args.out}")
    print(f"requests ledgered: {len((args.out / 'credit_ledger.jsonl').read_text().splitlines())}")
    print(f"measured credits: {fetcher.meter.spent} / cap {fetcher.meter.cap}")
    if fetcher.discovery_misses:
        print("discovery misses (ledgered, to be reported by V1):")
        for m in fetcher.discovery_misses:
            print(f"  - {m}")
    if fetcher.partial:
        print(f"PARTIAL: {fetcher.partial_reason}")


if __name__ == "__main__":
    main()
