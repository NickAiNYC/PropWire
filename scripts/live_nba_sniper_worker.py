#!/usr/bin/env python3
"""
Standalone Live NBA Sniper Worker Daemon (`scripts/live_nba_sniper_worker.py`)

Polls `nba_api.live.nba.endpoints.playbyplay` during active NBA game windows on a
5-second cadence, detects substitutions (`PLAYER1_ID -> PLAYER2_ID`) and foul trouble
(`foulPersonalTotal`), and dispatches structured events to the PropWire internal API
(`/api/sniper/simulate-substitution`).

Anti-Ban & Resilience Safeguards:
1. Proxy Rotation (`NBA_PROXY_URLS` or `SCRAPER_API_KEY`) to prevent Akamai WAF IP bans.
2. Exponential Backoff with Jitter (`5s, 10s, 20s, 40s`) on HTTP 429 / 403 / timeout.
3. Active Roster State & Desync Guard: verifies `PLAYER1_ID` is on court and `PLAYER2_ID`
   is on bench before emitting, deduplicates identical `(actionNumber, edited)` ticks,
   and handles official scorer reversals (`is_correction`).
4. 3-Strike Stale Kill Switch: if the PBP feed fails for >= 3 consecutive polls, logs
   `CRITICAL` JSON and emits `feed_stale` to `/api/sniper/feed-stale` to grey out UI lineups.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Optional

logger = logging.getLogger("propwire.worker.nba_live_pbp")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def log_structured(level: int, event: str, **fields: Any) -> dict[str, Any]:
    """Emit a single-line structured JSON log record."""
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "service": "live_nba_sniper_worker",
        "level": logging.getLevelName(level),
        "event": event,
        **fields,
    }
    logger.log(level, json.dumps(record, default=str))
    return record


class ProxyRotator:
    """
    Rotates across configured proxy endpoints (`NBA_PROXY_URLS` or `SCRAPER_API_KEY`)
    so `nba_api` Live PlayByPlay requests never hammer Akamai WAF from a single IP.
    """

    def __init__(
        self,
        proxy_urls: Optional[list[str]] = None,
        scraper_api_key: Optional[str] = None,
    ) -> None:
        env_proxies = os.environ.get("NBA_PROXY_URLS", "")
        parsed = [p.strip() for p in env_proxies.split(",") if p.strip()]
        self.proxies: list[str] = list(proxy_urls) if proxy_urls is not None else parsed
        self.scraper_api_key = (
            scraper_api_key
            if scraper_api_key is not None
            else os.environ.get("SCRAPER_API_KEY", "").strip()
        )
        self._index = 0

    def next_proxy(self) -> Optional[str]:
        """Return the next proxy URL in round-robin rotation."""
        if self.proxies:
            proxy = self.proxies[self._index % len(self.proxies)]
            self._index += 1
            return proxy
        if self.scraper_api_key:
            return f"http://scraperapi:{self.scraper_api_key}@proxy-server.scraperapi.com:8001"
        return None

    def wrap_target_url(self, target_url: str) -> str:
        """If `SCRAPER_API_KEY` is set without explicit proxy list, wrap URL via ScraperAPI."""
        if self.scraper_api_key and not self.proxies:
            encoded = urllib.parse.quote(target_url, safe="")
            return f"http://api.scraperapi.com?api_key={self.scraper_api_key}&url={encoded}"
        return target_url


class ExponentialBackoff:
    """
    Exponential backoff with jitter: `5s, 10s, 20s, 40s` (capped at `max_delay_sec`).
    """

    def __init__(
        self,
        base_delay_sec: float = 5.0,
        max_delay_sec: float = 40.0,
        jitter_max_sec: float = 0.75,
    ) -> None:
        self.base_delay_sec = base_delay_sec
        self.max_delay_sec = max_delay_sec
        self.jitter_max_sec = jitter_max_sec
        self.attempt = 0

    def next_delay(self, retry_after: Optional[float] = None) -> float:
        if retry_after is not None and retry_after > 0:
            self.attempt += 1
            return min(float(retry_after), self.max_delay_sec)
        raw = min(self.max_delay_sec, self.base_delay_sec * (2 ** self.attempt))
        jitter = random.uniform(0.0, self.jitter_max_sec) if self.jitter_max_sec > 0 else 0.0
        self.attempt += 1
        return round(raw + jitter, 3)

    def reset(self) -> None:
        self.attempt = 0


class PollHttpError(Exception):
    """Raised when the upstream NBA PlayByPlay endpoint returns 429, 403, or 5xx."""

    def __init__(self, status_code: int, message: str = "", retry_after: Optional[float] = None):
        super().__init__(f"HTTP {status_code}: {message}")
        self.status_code = status_code
        self.retry_after = retry_after


class LiveNbaSniperWorker:
    """
    Standalone polling worker that monitors NBA live play-by-play, validates
    active 5-man court vs bench state to prevent recalculation storms, and
    dispatches substitution / foul events to the internal PropWire FastAPI engine.
    """

    def __init__(
        self,
        *,
        internal_api_base: Optional[str] = None,
        poll_interval_sec: float = 5.0,
        stale_failure_threshold: int = 3,
        proxy_rotator: Optional[ProxyRotator] = None,
        backoff: Optional[ExponentialBackoff] = None,
        pbp_fetcher: Optional[Callable[[str, Optional[str]], dict[str, Any]]] = None,
        http_poster: Optional[Callable[[str, dict[str, Any]], dict[str, Any]]] = None,
    ) -> None:
        self.internal_api_base = (
            internal_api_base
            or os.environ.get("PROPWIRE_INTERNAL_API_URL", "http://localhost:8000")
        ).rstrip("/")
        self.poll_interval_sec = poll_interval_sec
        self.stale_failure_threshold = stale_failure_threshold
        self.proxy_rotator = proxy_rotator or ProxyRotator()
        self.backoff = backoff or ExponentialBackoff(base_delay_sec=5.0, max_delay_sec=40.0)
        self._pbp_fetcher = pbp_fetcher or self._default_pbp_fetcher
        self._http_poster = http_poster or self._default_http_poster

        # Local roster state per (game_id, team): {"on_court": set[str], "bench": set[str]}
        self.roster_state: dict[tuple[str, str], dict[str, set[str]]] = {}
        # Deduplication registry: (game_id, action_key) -> edited_timestamp
        self.processed_actions: dict[tuple[str, str], str] = {}
        # Consecutive failure counter per game_id for the 3-strike Kill Switch
        self.consecutive_failures: dict[str, int] = {}
        self.is_feed_stale: dict[str, bool] = {}

    def seed_roster(
        self,
        game_id: str,
        team: str,
        on_court_ids: list[str],
        bench_ids: list[str],
    ) -> None:
        """Initialize the known 5-man on-court lineup and bench rotation for a team."""
        self.roster_state[(game_id, team.upper())] = {
            "on_court": {str(pid) for pid in on_court_ids},
            "bench": {str(pid) for pid in bench_ids},
        }

    def _default_pbp_fetcher(self, game_id: str, proxy_url: Optional[str]) -> dict[str, Any]:
        """
        Fetch live NBA PlayByPlay JSON via `nba_api.live.nba.endpoints.playbyplay`
        (using rotated proxy), or fall back to NBA CDN liveData endpoint.
        """
        try:
            from nba_api.live.nba.endpoints import playbyplay  # type: ignore

            pbp = playbyplay.PlayByPlay(game_id=game_id, proxy=proxy_url, timeout=4)
            return pbp.get_dict()
        except ImportError:
            pass

        raw_url = f"https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{game_id}.json"
        target_url = self.proxy_rotator.wrap_target_url(raw_url)
        handlers: list[Any] = []
        if proxy_url and target_url == raw_url:
            handlers.append(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
        opener = urllib.request.build_opener(*handlers)
        req = urllib.request.Request(
            target_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Accept": "application/json",
            },
        )
        try:
            with opener.open(req, timeout=4.0) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            retry_hdr = exc.headers.get("Retry-After") if exc.headers else None
            retry_val = float(retry_hdr) if retry_hdr and retry_hdr.isdigit() else None
            raise PollHttpError(exc.code, str(exc.reason), retry_after=retry_val) from exc

    def _default_http_poster(self, endpoint_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.internal_api_base}{endpoint_path}"
        data = json.dumps(payload, default=str).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            return json.loads(resp.read().decode("utf-8"))

    @staticmethod
    def _compute_action_latency_ms(action_time_str: Optional[str], now_dt: datetime) -> float:
        if not action_time_str:
            return 0.0
        try:
            parsed = datetime.fromisoformat(str(action_time_str).replace("Z", "+00:00"))
            return round(max(0.0, (now_dt - parsed).total_seconds() * 1000.0), 2)
        except Exception:
            return 0.0

    def _can_apply_substitution(
        self,
        game_id: str,
        team: str,
        player_out_id: str,
        player_in_id: str,
        is_correction: bool = False,
    ) -> tuple[bool, str]:
        """
        Verify against local roster state that `player_out_id` is on the court
        and `player_in_id` is on the bench. Prevents duplicate recalculation storms
        when `nba_api` repeats an action or desyncs.
        """
        key = (game_id, team.upper())
        if key not in self.roster_state:
            # Auto-initialize if team wasn't pre-seeded
            self.roster_state[key] = {
                "on_court": {player_out_id},
                "bench": {player_in_id},
            }
            return True, "ROSTER_INITIALIZED"

        roster = self.roster_state[key]
        on_court = roster["on_court"]
        bench = roster["bench"]

        if is_correction:
            # Official scorer reversal: allow swap even if previously flipped
            on_court.discard(player_out_id)
            bench.add(player_out_id)
            bench.discard(player_in_id)
            on_court.add(player_in_id)
            return True, "OFFICIAL_SCORER_CORRECTION"

        # If player_in is already on court and player_out is already on bench, skip duplicate!
        if player_in_id in on_court and player_out_id in bench:
            return False, "ALREADY_SWAPPED_ON_COURT"

        if player_out_id not in on_court:
            return False, "PLAYER1_NOT_ON_COURT"

        if bench and player_in_id not in bench:
            return False, "PLAYER2_NOT_ON_BENCH"

        # Valid transition: update local roster state
        on_court.discard(player_out_id)
        bench.add(player_out_id)
        bench.discard(player_in_id)
        on_court.add(player_in_id)
        return True, "VALID_ROSTER_TRANSITION"

    def poll_game_once(
        self,
        game_id: str,
        *,
        now: Optional[datetime] = None,
    ) -> dict[str, Any]:
        """
        Execute a single poll cycle for `game_id`:
        - Uses rotated proxy (`self.proxy_rotator.next_proxy()`).
        - On HTTP 429/403/timeout, increments failure count, computes exponential
          backoff, and trips the 3-strike Stale Kill Switch if failures >= 3.
        - On success, parses `actions`, filters duplicate/desynced events, and
          POSTs valid substitutions/fouls to `/api/sniper/simulate-substitution`.
        """
        now_dt = now or datetime.now(timezone.utc)
        proxy_url = self.proxy_rotator.next_proxy()

        try:
            pbp_data = self._pbp_fetcher(game_id, proxy_url)
        except Exception as exc:
            fails = self.consecutive_failures.get(game_id, 0) + 1
            self.consecutive_failures[game_id] = fails
            retry_after = getattr(exc, "retry_after", None)
            delay_s = self.backoff.next_delay(retry_after=retry_after)
            status_code = getattr(exc, "status_code", 500)

            log_structured(
                logging.WARNING,
                "pbp_poll_failed",
                game_id=game_id,
                status_code=status_code,
                consecutive_failures=fails,
                backoff_delay_sec=delay_s,
                proxy_used=proxy_url,
                error=str(exc),
            )

            stale_dispatched = False
            if fails >= self.stale_failure_threshold:
                self.is_feed_stale[game_id] = True
                log_structured(
                    logging.CRITICAL,
                    "pbp_feed_stale_kill_switch_tripped",
                    game_id=game_id,
                    consecutive_failures=fails,
                    reason="nba_api Live PBP feed down for >= 3 consecutive polls",
                )
                try:
                    self._http_poster(
                        "/api/sniper/feed-stale",
                        {
                            "event_type": "feed_stale",
                            "game_id": game_id,
                            "consecutive_failures": fails,
                            "reason": f"PBP feed failed {fails} consecutive polls ({exc})",
                        },
                    )
                    stale_dispatched = True
                except Exception as post_exc:
                    log_structured(
                        logging.ERROR,
                        "feed_stale_post_error",
                        game_id=game_id,
                        error=str(post_exc),
                    )

            return {
                "status": "error",
                "game_id": game_id,
                "status_code": status_code,
                "consecutive_failures": fails,
                "backoff_delay_sec": delay_s,
                "feed_stale_emitted": stale_dispatched,
                "dispatched_count": 0,
            }

        # Reset failure counter and backoff on clean poll
        self.consecutive_failures[game_id] = 0
        self.is_feed_stale[game_id] = False
        self.backoff.reset()

        actions = (
            pbp_data.get("game", {}).get("actions")
            or pbp_data.get("actions")
            or []
        )

        dispatched_events: list[dict[str, Any]] = []
        skipped_duplicates = 0

        for action in actions:
            action_type = str(action.get("actionType") or "").lower()
            if action_type not in ("substitution", "foul"):
                continue

            action_num = str(action.get("actionNumber") or action.get("orderNumber") or "")
            action_time = str(action.get("timeActual") or action.get("clock") or "")
            edited_ts = str(action.get("edited") or action_time)
            is_correction = bool(action.get("is_correction", False))

            p1_id = str(action.get("PLAYER1_ID") or action.get("player_out_id") or action.get("personId") or "")
            p2_id = str(action.get("PLAYER2_ID") or action.get("player_in_id") or "")
            p3_id = str(action.get("PLAYER3_ID") or "")
            fouls = int(action.get("foulPersonalTotal") or action.get("personal_fouls") or 0)
            team = str(action.get("teamTricode") or action.get("team") or "MIL").upper()

            dedup_id = f"{action_type}:{action_num}:{p1_id}:{p2_id}:{ edited_ts if is_correction else action_time }"
            prev_edited = self.processed_actions.get((game_id, dedup_id))
            if prev_edited is not None and not is_correction:
                skipped_duplicates += 1
                log_structured(
                    logging.INFO,
                    "pbp_duplicate_action_skipped",
                    game_id=game_id,
                    dedup_id=dedup_id,
                    PLAYER1_ID=p1_id,
                    PLAYER2_ID=p2_id,
                )
                continue

            if action_type == "substitution" and p1_id and p2_id:
                allowed, transition_reason = self._can_apply_substitution(
                    game_id=game_id,
                    team=team,
                    player_out_id=p1_id,
                    player_in_id=p2_id,
                    is_correction=is_correction,
                )
                if not allowed:
                    skipped_duplicates += 1
                    log_structured(
                        logging.INFO,
                        "pbp_desync_or_duplicate_roster_skipped",
                        game_id=game_id,
                        team=team,
                        PLAYER1_ID=p1_id,
                        PLAYER2_ID=p2_id,
                        reason=transition_reason,
                    )
                    continue
            else:
                transition_reason = "FOUL_TROUBLE_TRIGGER"

            self.processed_actions[(game_id, dedup_id)] = edited_ts
            dispatch_now = datetime.now(timezone.utc)
            latency_ms = self._compute_action_latency_ms(action_time, now or dispatch_now)

            post_payload = {
                "game_id": game_id,
                "team": team,
                "event_type": "substitution" if action_type == "substitution" else "foul",
                "sub_out_player_id": p1_id,
                "sub_in_player_id": p2_id,
                "PLAYER1_ID": p1_id,
                "PLAYER2_ID": p2_id,
                "PLAYER3_ID": p3_id,
                "foulPersonalTotal": fouls,
                "is_correction": is_correction,
                "action_number": action_num,
                "action_time": action_time,
                "action_to_dispatch_latency_ms": latency_ms,
            }

            api_res = self._http_poster("/api/sniper/simulate-substitution", post_payload)
            log_structured(
                logging.INFO,
                "pbp_event_dispatched",
                game_id=game_id,
                team=team,
                action_type=action_type,
                PLAYER1_ID=p1_id,
                PLAYER2_ID=p2_id,
                PLAYER3_ID=p3_id,
                foulPersonalTotal=fouls,
                transition_reason=transition_reason,
                action_to_dispatch_latency_ms=latency_ms,
                proxy_used=proxy_url,
            )
            dispatched_events.append(api_res)

        return {
            "status": "ok",
            "game_id": game_id,
            "dispatched_count": len(dispatched_events),
            "skipped_duplicates": skipped_duplicates,
            "dispatched_events": dispatched_events,
        }

    async def run_daemon(
        self,
        game_ids: list[str],
        *,
        max_cycles: Optional[int] = None,
    ) -> None:
        """
        Asynchronous standalone worker loop (runs in its own Railway worker process).
        """
        cycle = 0
        log_structured(
            logging.INFO,
            "worker_daemon_started",
            game_ids=game_ids,
            poll_interval_sec=self.poll_interval_sec,
            internal_api_base=self.internal_api_base,
        )
        while max_cycles is None or cycle < max_cycles:
            cycle += 1
            sleep_sec = self.poll_interval_sec
            for gid in game_ids:
                res = self.poll_game_once(gid)
                if res["status"] == "error":
                    sleep_sec = max(sleep_sec, float(res.get("backoff_delay_sec", self.poll_interval_sec)))
            await asyncio.sleep(sleep_sec)


def main() -> None:
    parser = argparse.ArgumentParser(description="PropWire Live NBA Play-by-Play Sniper Worker Daemon")
    parser.add_argument(
        "--games",
        default=os.environ.get("NBA_ACTIVE_GAME_IDS", "2026_nba_mil_bos,2026_nba_gsw_sac"),
        help="Comma-separated active NBA game IDs to monitor",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("NBA_PBP_POLL_SECONDS", "5.0")),
        help="Polling cadence in seconds (default: 5.0)",
    )
    parser.add_argument(
        "--api-url",
        default=os.environ.get("PROPWIRE_INTERNAL_API_URL", "http://localhost:8000"),
        help="Internal FastAPI base URL",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single poll cycle and exit (for healthchecks/tests)",
    )
    args = parser.parse_args()
    game_ids = [g.strip() for g in args.games.split(",") if g.strip()]
    worker = LiveNbaSniperWorker(
        internal_api_base=args.api_url,
        poll_interval_sec=args.interval,
    )
    asyncio.run(worker.run_daemon(game_ids, max_cycles=1 if args.once else None))


if __name__ == "__main__":
    main()
