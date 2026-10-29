"""
Agent 2: LineupAndSubstitutionAgent

Inputs:
  - SportsDataIO confirmed lineups + depth charts + injuries
  - NBA live play-by-play with substitution flags (`is_substitution`, `is_foul`)
    via `nba_api` Live PlayByPlay / Apify NBA Play-by-Play Scraper.

Cadence: 15-30s during live games; subscribes to play-by-play stream.
Output event: `lineup.substitution` or `lineup.foul_trouble` -> Redis Stream (`propwire.events.lineup`).
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from src.agents.persistence import TOPIC_LINEUP, DurableRedisStreamBus, TruthStore
from src.agents.schemas import (
    InjuryBeneficiary,
    LineupEventPayload,
    StructuredAgentLog,
    compute_dedup_hash,
    compute_source_hash,
)
from src.agents.stale_kill_switch import StaleKillSwitch

logger = logging.getLogger("propwire.agent.lineup")


class LineupAndSubstitutionAgent:
    """
    Processes live play-by-play substitution and foul-trouble events plus
    pregame confirmed starter lineups; emits `lineup.substitution` or
    `lineup.foul_trouble` to `propwire.events.lineup`.
    """

    AGENT_NAME = "LineupAndSubstitutionAgent"

    def __init__(
        self,
        stream_bus: DurableRedisStreamBus,
        truth_store: TruthStore,
        kill_switch: StaleKillSwitch | None = None,
    ):
        self.stream_bus = stream_bus
        self.truth_store = truth_store
        self.kill_switch = kill_switch or StaleKillSwitch()

    @staticmethod
    def is_foul_trouble(period: int, personal_fouls: int) -> bool:
        """
        Deterministic NBA foul trouble rule:
        - Q1: >= 2 personal fouls
        - Q2: >= 3 personal fouls
        - Q3: >= 4 personal fouls
        - Q4: >= 5 personal fouls
        """
        if period == 1 and personal_fouls >= 2:
            return True
        if period == 2 and personal_fouls >= 3:
            return True
        if period == 3 and personal_fouls >= 4:
            return True
        if period >= 4 and personal_fouls >= 5:
            return True
        return False

    def ingest_play_by_play(
        self,
        raw_pbp: dict[str, Any],
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        t0 = time.perf_counter()
        source_hash = raw_pbp.get("source_hash") or compute_source_hash(raw_pbp)
        fetched_at = raw_pbp.get("fetched_at")
        if isinstance(fetched_at, str):
            fetched_at = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
        elif not isinstance(fetched_at, datetime):
            fetched_at = datetime.now(timezone.utc)

        period = int(raw_pbp.get("period", 1))
        personal_fouls = int(raw_pbp.get("personal_fouls", 0))
        is_foul = bool(raw_pbp.get("is_foul", False)) or self.is_foul_trouble(period, personal_fouls)
        is_sub = bool(raw_pbp.get("is_substitution", False))

        if is_foul and self.is_foul_trouble(period, personal_fouls):
            sub_type = "foul_trouble"
            event_type = "lineup.foul_trouble"
            min_delta = float(raw_pbp.get("minutes_projection_delta", -4.5))
        elif raw_pbp.get("sub_type") == "confirmed_starter":
            sub_type = "confirmed_starter"
            event_type = "lineup.substitution"
            min_delta = float(raw_pbp.get("minutes_projection_delta", 6.0))
        else:
            sub_type = "substitution"
            event_type = "lineup.substitution"
            min_delta = float(raw_pbp.get("minutes_projection_delta", 0.0))

        beneficiaries_raw = raw_pbp.get("beneficiaries") or []
        beneficiaries = [
            b if isinstance(b, InjuryBeneficiary) else InjuryBeneficiary(**b)
            for b in beneficiaries_raw
        ]

        payload = LineupEventPayload(
            sport=raw_pbp.get("sport", "nba"),
            game_id=raw_pbp["game_id"],
            player_id=raw_pbp["player_id"],
            player_name=raw_pbp.get("player_name", raw_pbp["player_id"]),
            team=raw_pbp.get("team", "UNK"),
            opponent=raw_pbp.get("opponent", "UNK"),
            sub_type=sub_type,  # type: ignore[arg-type]
            is_substitution=is_sub,
            is_foul=is_foul,
            personal_fouls=personal_fouls,
            period=period,
            clock_remaining_minutes=float(raw_pbp.get("clock_remaining_minutes", max(0.0, (4 - period) * 12.0 + 6.0))),
            minutes_projection_delta=min_delta,
            usage_rate_delta=float(raw_pbp.get("usage_rate_delta", 0.0)),
            remaining_opportunities_delta=float(raw_pbp.get("remaining_opportunities_delta", 0.0)),
            beneficiaries=beneficiaries,
            is_live=bool(raw_pbp.get("is_live", True)),
            source_hash=source_hash,
            fetched_at=fetched_at,
        )

        is_stale, age_s, _, stale_reason = self.kill_switch.evaluate(
            agent_name=self.AGENT_NAME,
            event_type=event_type,
            prop_id=f"{payload.game_id}::{payload.player_id}",
            feed_type="lineup",
            fetched_at=payload.fetched_at,
            source_hash=source_hash,
            is_live=payload.is_live,
            now=now,
        )

        affected_ids = [payload.player_id] + [b.player_id for b in payload.beneficiaries]
        dedup_key = compute_dedup_hash(
            payload.game_id,
            payload.player_id,
            sub_type,
            str(period),
            str(personal_fouls),
            f"{payload.clock_remaining_minutes:.1f}",
        )
        decision = "HALTED_STALE" if is_stale else "INGESTED"
        event_dict = {
            "event_type": event_type,
            "payload": payload.model_dump(mode="json"),
            "affected_player_ids": affected_ids,
            "affected_game_id": payload.game_id,
            "dedup_key": dedup_key,
            "source_hash": source_hash,
            "fetched_at": payload.fetched_at.isoformat(),
            "feed_age_seconds": age_s,
            "is_stale": is_stale,
        }

        stream_id = self.stream_bus.xadd(TOPIC_LINEUP, event_dict, source_hash=source_hash)
        self.truth_store.record_agent_event(
            stream_topic=TOPIC_LINEUP,
            agent_name=self.AGENT_NAME,
            event_type=event_type,
            sport=payload.sport,
            affected_game_id=payload.game_id,
            affected_player_ids=affected_ids,
            dedup_key=dedup_key,
            event_payload=payload.model_dump(mode="json"),
            source_hash=source_hash,
            fetched_at=payload.fetched_at,
            feed_age_seconds=age_s,
            is_stale=is_stale,
            decision=decision,
            reason=stale_reason,
        )

        latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        logger.info(
            StructuredAgentLog(
                agent=self.AGENT_NAME,
                event_type=event_type,
                prop_id=f"{payload.game_id}::{payload.player_id}",
                latency_ms=latency_ms,
                decision=decision,
                reason=stale_reason,
                source_hash=source_hash,
                feed_age_seconds=age_s,
                is_stale=is_stale,
            ).model_dump_json()
        )

        return {
            "emitted": True,
            "stream_id": stream_id,
            "event_type": event_type,
            "decision": decision,
            "source_hash": source_hash,
            "feed_age_seconds": age_s,
            "is_stale": is_stale,
            "payload": payload,
            "affected_player_ids": affected_ids,
        }
