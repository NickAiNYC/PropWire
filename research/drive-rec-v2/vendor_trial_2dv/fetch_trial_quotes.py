"""fetch_trial_quotes.py — Decision 2D-V trial acquisition (The Odds API).

Two modes:

  REAL (default): pulls historical event-odds for the precommitted trial
  sample. Requires the API key in the environment variable ODDS_API_KEY
  (trial_config.json env_key_name). THE KEY IS NEVER WRITTEN, LOGGED, OR
  COMMITTED: request URLs are redacted before storage, and the key is not
  accepted from any file inside the repository. No credentials exist in this
  development environment; the real pull is executed by the project owner.

  --dry-run --fixtures <dir>: exercises the full request-plan/orchestration
  path against SYNTHETIC fixture responses (no network, no credits). Output
  layout is byte-identical to real mode so the V1-V10 verifier runs unmodified.

Every response is preserved verbatim with a SHA-256 sidecar, redacted request
metadata, and a credit-ledger row metering the vendor's x-requests-remaining
headers (check V9 reconciles these against the documented 10-credit rule).

Budget guard: modeled spend plus observed spend is checked against
credit_budget_cap before every historical request; the run aborts PARTIAL
rather than exceeding the cap (fail-closed spend control).
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

from credit_meter import load_config, request_cost  # noqa: E402

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


class BudgetExceeded(RuntimeError):
    pass


class Fetcher:
    def __init__(self, cfg: dict, mode: str, out_dir: Path,
                 fixtures_dir: Path | None, sport_key: str, market: str):
        self.cfg = cfg
        self.mode = mode                      # "REAL" | "DRY_RUN"
        self.out = out_dir
        self.resp_dir = out_dir / "responses"
        self.ev_dir = out_dir / "events"
        self.resp_dir.mkdir(parents=True, exist_ok=True)
        self.ev_dir.mkdir(parents=True, exist_ok=True)
        self.fixtures = fixtures_dir
        self.sport_key = sport_key
        self.market = market
        self.base = cfg["vendor"]["base_url"]
        self.key = os.environ.get(cfg["vendor"]["env_key_name"]) if mode == "REAL" else None
        self.ledger_path = out_dir / "credit_ledger.jsonl"
        self.ledger_path.write_text("")
        self.files: list[dict] = []
        self.remaining_sim = 10_000           # dry-run simulated balance
        self.discovery_misses: list[str] = []
        self.partial = False
        self.spent_credits = 0                # cumulative ACTUAL spend (headers)

    def _budget_guard(self, next_modeled: int) -> None:
        """Fail-closed spend control: abort PARTIAL before exceeding the cap."""
        if self.spent_credits + next_modeled > self.cfg["credit_budget_cap"]:
            self.partial = True
            raise BudgetExceeded(
                f"budget guard: observed spend {self.spent_credits} + modeled "
                f"{next_modeled} would exceed credit_budget_cap "
                f"{self.cfg['credit_budget_cap']}; aborting PARTIAL (fail-closed)")

    # ---------------- request plumbing ----------------
    def _http(self, url: str, params: dict) -> tuple[bytes, int, dict]:
        """One HTTP GET. Returns (body, status, selected headers). Retries
        transient errors; honors Retry-After on 429."""
        if self.mode == "DRY_RUN":
            return self._fixture_response(params)
        full = url + "?" + urllib.parse.urlencode(params)
        last_err = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(full, method="GET")
                with urllib.request.urlopen(req, timeout=30) as r:
                    body, status = r.read(), r.status
                    headers = {k.lower(): v for k, v in r.headers.items()}
                    return body, status, headers
            except urllib.error.HTTPError as e:
                body, status, headers = e.read(), e.code, \
                    {k.lower(): v for k, v in e.headers.items()}
                if status in (429, 500, 502, 503, 504) and attempt < 2:
                    wait = int(headers.get("retry-after", "2"))
                    time.sleep(wait)
                    last_err = f"HTTP {status}"
                    continue
                return body, status, headers
            except urllib.error.URLError as e:
                if attempt < 2:
                    time.sleep(2)
                    last_err = str(e.reason)
                    continue
                raise RuntimeError(f"network error: {last_err}")
        raise RuntimeError(f"retries exhausted: {last_err}")

    def _fixture_response(self, params: dict) -> tuple[bytes, int, dict]:
        assert self.fixtures is not None
        name = params["_fixture_name"]
        path = self.fixtures / "responses" / name
        if not path.exists():
            return (json.dumps({"error_code": 404,
                                "message": f"fixture missing: {name}"}).encode(),
                    404, {})
        doc = json.loads(path.read_text())
        sim = doc.pop("_sim", {}) or {}
        cost = int(sim.get("credit_cost", request_cost(1, 1)))
        before = self.remaining_sim
        self.remaining_sim -= cost
        headers = {"x-requests-remaining": str(self.remaining_sim),
                   "x-requests-used": str(10_000 - self.remaining_sim)}
        return (json.dumps(doc, indent=2, sort_keys=True).encode(), 200,
                headers)

    # ---------------- persistence ----------------
    def _persist(self, rel_path: Path, body: bytes, meta: dict) -> None:
        (self.out / rel_path).write_bytes(body)
        meta["content_sha256"] = sha256_bytes(body)
        meta_path = self.out / (str(rel_path) + ".meta.json")
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")
        self.files.append({"path": str(rel_path), "sha256": meta["content_sha256"],
                           "bytes": len(body), "role": "response"})
        self.files.append({"path": str(meta_path.relative_to(self.out)),
                           "sha256": sha256_bytes(meta_path.read_bytes()),
                           "bytes": len(meta_path.read_bytes()),
                           "role": "meta"})

    def _ledger(self, row: dict) -> None:
        if row.get("actual_credits") is not None:
            self.spent_credits += int(row["actual_credits"])
        with self.ledger_path.open("a") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")

    def _spend_state(self, headers: dict) -> tuple[int | None, int | None]:
        if self.mode == "DRY_RUN":
            return self.remaining_sim, 10_000 - self.remaining_sim
        rem = headers.get("x-requests-remaining")
        used = headers.get("x-requests-used")
        return (int(rem) if rem is not None else None,
                int(used) if used is not None else None)

    # ---------------- plan ----------------
    def run(self, sample: dict) -> None:
        offsets = self.cfg["observation_offsets_minutes"]
        modeled_per_pull = request_cost(1, 1)
        try:
            for game in sample["games"]:
                event = self._discover(game)
                if event is None:
                    continue
                event_id, commence_iso = event
                kickoff = datetime.fromisoformat(commence_iso.replace("Z", "+00:00"))
                for label, off_min in offsets.items():
                    decision_ts = kickoff + timedelta(minutes=off_min)
                    self._pull_quote(game, event_id, label, decision_ts,
                                     modeled_per_pull)
                    time.sleep(self.cfg["request_delay_seconds"]
                               if self.mode == "REAL" else 0.0)
        except BudgetExceeded as e:
            print(f"ABORTED PARTIAL: {e}", file=sys.stderr)
        self._write_manifest(sample)

    def _discover(self, game: dict) -> tuple[str, str] | None:
        if self.mode == "DRY_RUN":
            return game["event_id"], game["kickoff_utc"]
        gameday = datetime.strptime(game["gameday"], "%Y-%m-%d")
        params = {
            "apikey": self.key,
            "commence_time_from": (gameday - timedelta(days=1)
                                   ).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "commence_time_to": (gameday + timedelta(days=2)
                                 ).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        url = f"{self.base}/sports/{self.sport_key}/events"
        body, status, headers = self._http(url, params)
        rel = Path("events") / f"{game['game_id']}.events.json"
        self._persist(rel, body, {
            "game_id": game["game_id"], "request_kind": "events_discovery",
            "url_redacted": redact(url), "http_status": status,
            "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
            "mode": self.mode, "note": "credit cost metered, not modeled",
        })
        rem, used = self._spend_state(headers)
        self._ledger({
            "game_id": game["game_id"], "event_id": None,
            "offset_label": None, "decision_ts_utc": None,
            "request_kind": "events_discovery", "sport_key": self.sport_key,
            "market": None, "regions": None, "modeled_credits": None,
            "x_requests_remaining_before": None,
            "x_requests_remaining_after": rem, "actual_credits": None,
            "http_status": status, "raw_file": str(rel),
            "ts_request_utc": datetime.now(timezone.utc).isoformat(),
        })
        if status != 200:
            self.discovery_misses.append(
                f"{game['game_id']}: events HTTP {status}")
            return None
        try:
            events = json.loads(body)
        except json.JSONDecodeError:
            self.discovery_misses.append(f"{game['game_id']}: bad events JSON")
            return None
        want_home = norm_team(TEAM_NAMES.get(game["home_team"], game["home_team"]))
        want_away = norm_team(TEAM_NAMES.get(game["away_team"], game["away_team"]))
        for ev in events:
            if (norm_team(ev.get("home_team", "")) == want_home
                    and norm_team(ev.get("away_team", "")) == want_away):
                return str(ev["id"]), str(ev["commence_time"])
        self.discovery_misses.append(
            f"{game['game_id']}: no event matched {game['away_team']} @ "
            f"{game['home_team']} (observed teams: "
            f"{[ (e.get('away_team'), e.get('home_team')) for e in events[:6] ]})")
        return None

    def _pull_quote(self, game: dict, event_id: str, label: str,
                    decision_ts: datetime, modeled: int) -> None:
        name = f"{game['game_id']}__{label}.json"
        params = {
            "date": decision_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "regions": self.cfg["region"],
            "markets": self.market,
            "oddsFormat": self.cfg["odds_format"],
        }
        url = (f"{self.base}/historical/sports/{self.sport_key}/events/"
               f"{event_id}")
        self._budget_guard(modeled)
        before_rem = (self.remaining_sim if self.mode == "DRY_RUN" else None)
        if self.mode == "REAL":
            params["apikey"] = self.key
        else:
            params["_fixture_name"] = name
        body, status, headers = self._http(url, params)
        rem, _used = self._spend_state(headers)
        after_rem = rem
        actual = None
        if before_rem is not None and after_rem is not None:
            actual = before_rem - after_rem
        rel = Path("responses") / name
        self._persist(rel, body, {
            "game_id": game["game_id"], "event_id": event_id,
            "offset_label": label,
            "decision_ts_utc": decision_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "request_kind": "historical_event_odds",
            "url_redacted": redact(url), "params": {
                "date": params["date"], "regions": params["regions"],
                "markets": self.market, "oddsFormat": params["oddsFormat"]},
            "http_status": status, "mode": self.mode,
            "fetched_at_utc": (datetime.now(timezone.utc).isoformat()
                               if self.mode == "REAL" else DRY_RUN_STAMP),
        })
        self._ledger({
            "game_id": game["game_id"], "event_id": event_id,
            "offset_label": label,
            "decision_ts_utc": decision_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "request_kind": "historical_event_odds",
            "sport_key": self.sport_key, "market": self.market,
            "regions": [self.cfg["region"]], "modeled_credits": modeled,
            "x_requests_remaining_before": before_rem,
            "x_requests_remaining_after": after_rem,
            "actual_credits": actual, "http_status": status,
            "raw_file": str(rel),
            "ts_request_utc": (datetime.now(timezone.utc).isoformat()
                               if self.mode == "REAL" else DRY_RUN_STAMP),
        })

    def _write_manifest(self, sample: dict) -> None:
        manifest = {
            "trial_id": self.cfg["trial_id"],
            "mode": self.mode,
            "data_label": ("REAL_VENDOR_RESPONSES" if self.mode == "REAL"
                           else "SYNTHETIC-HARNESS-TEST"),
            "created_utc": (datetime.now(timezone.utc).isoformat()
                            if self.mode == "REAL" else DRY_RUN_STAMP),
            "sport_key": self.sport_key,
            "market": self.market,
            "regions": [self.cfg["region"]],
            "observation_offsets_minutes": self.cfg["observation_offsets_minutes"],
            "discovery_misses": self.discovery_misses,
            "partial": self.partial,
            "files": sorted(self.files, key=lambda f: f["path"]),
            "credit_ledger": "credit_ledger.jsonl",
        }
        (self.out / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fixtures", type=Path, default=None,
                    help="fixtures dir (dry-run): contains sample_manifest.json, responses/, independent_stats.csv")
    ap.add_argument("--out", type=Path, default=Path("raw"))
    ap.add_argument("--sample-manifest", type=Path, default=None)
    ap.add_argument("--sport-key", default=None)
    ap.add_argument("--market", default=None)
    args = ap.parse_args()
    cfg = load_config()

    if args.dry_run:
        if args.fixtures is None:
            ap.error("--dry-run requires --fixtures")
        sample = json.loads((args.fixtures / "sample_manifest.json").read_text())
        fetcher = Fetcher(cfg, "DRY_RUN", args.out, args.fixtures,
                          sport_key=args.sport_key or "playerprops_nfl",
                          market=args.market or cfg["market_candidates"][0])
    else:
        key = os.environ.get(cfg["vendor"]["env_key_name"])
        if not key:
            raise SystemExit(
                f"REAL mode requires the API key in the environment variable "
                f"{cfg['vendor']['env_key_name']} (never pass it as an argument, "
                "never paste it into chat or files).")
        sample_path = args.sample_manifest or (HERE / "artifacts" / "sample_manifest.json")
        sample = json.loads(Path(sample_path).read_text())
        fetcher = Fetcher(cfg, "REAL", args.out, None,
                          sport_key=args.sport_key or cfg["sport_key_candidates"][0],
                          market=args.market or cfg["market_candidates"][0])

    fetcher.run(sample)
    print(f"mode={fetcher.mode} out={args.out}")
    print(f"requests ledgered: {len((args.out / 'credit_ledger.jsonl').read_text().splitlines())}")
    if fetcher.discovery_misses:
        print("discovery misses (ledgered, to be reported by V1):")
        for m in fetcher.discovery_misses:
            print(f"  - {m}")


if __name__ == "__main__":
    main()
