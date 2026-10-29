"""
Durable Persistence & Event Transport Spine:
- Redis Streams (`XADD` / `XREADGROUP`) for fan-out across topics:
    * `propwire.events.injury`
    * `propwire.events.lineup`
    * `propwire.events.market`
    * `propwire.events.projection`
    * `propwire.events.sniper`
- Postgres (`DATABASE_URL`) / Durable SQLite Truth Store for:
    * `agent_events`
    * `projections`
    * `sniper_alerts`
    * `clv_ledger`
    * `langgraph_checkpoints`
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.agents.schemas import (
    MODEL_VERSION,
    PropProjection,
    SniperAlert,
    StructuredAgentLog,
    compute_source_hash,
)

TOPIC_INJURY = "propwire.events.injury"
TOPIC_LINEUP = "propwire.events.lineup"
TOPIC_MARKET = "propwire.events.market"
TOPIC_PROJECTION = "propwire.events.projection"
TOPIC_SNIPER = "propwire.events.sniper"

STREAM_INJURY = TOPIC_INJURY
STREAM_LINEUP = TOPIC_LINEUP
STREAM_MARKET = TOPIC_MARKET
STREAM_PROJECTION = TOPIC_PROJECTION
STREAM_SNIPER = TOPIC_SNIPER

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


class DurableRedisStreamBus:
    """
    Redis Streams (`XADD` / `XREADGROUP`) bus.
    Uses native Redis when `REDIS_URL` is reachable; falls back to an on-disk
    SQLite WAL stream table (`data/redis_streams_wal.db`) so events survive
    process restarts and never rely on fragile in-process queues.
    """

    def __init__(
        self,
        redis_url: str | None = None,
        wal_path: Path | None = None,
        wal_db_path: Path | None = None,
    ):
        self.redis_url = redis_url or os.environ.get("REDIS_URL")
        self.wal_path = wal_path or wal_db_path or (DATA_DIR / "redis_streams_wal.db")
        self._redis = None
        if self.redis_url:
            try:
                import redis
                client = redis.from_url(self.redis_url, decode_responses=True, socket_connect_timeout=1.5)
                client.ping()
                self._redis = client
            except Exception:
                self._redis = None
        self._init_wal()

    def _init_wal(self) -> None:
        with sqlite3.connect(self.wal_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS stream_entries (
                    stream_id TEXT PRIMARY KEY,
                    topic TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS consumer_offsets (
                    group_name TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    last_created_at_ms INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (group_name, topic)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_stream_topic_ts ON stream_entries(topic, created_at_ms)")

    def xadd(self, topic: str, payload: dict[str, Any], source_hash: str | None = None) -> str:
        """Append an event to a Redis Stream (`XADD`) and durable WAL."""
        shash = source_hash or compute_source_hash(payload)
        now_ms = int(time.time() * 1000)
        stream_id = f"{now_ms}-{uuid.uuid4().hex[:8]}"
        body_str = json.dumps(payload, default=str)

        if self._redis is not None:
            try:
                rid = self._redis.xadd(topic, {"payload": body_str, "source_hash": shash})
                if rid:
                    stream_id = str(rid)
            except Exception:
                pass

        with sqlite3.connect(self.wal_path) as conn:
            conn.execute(
                "INSERT INTO stream_entries (stream_id, topic, payload_json, source_hash, created_at_ms) VALUES (?, ?, ?, ?, ?)",
                (stream_id, topic, body_str, shash, now_ms),
            )
        return stream_id

    def xreadgroup(
        self,
        group_name: str,
        consumer_name: str,
        topic: str,
        count: int = 50,
    ) -> list[dict[str, Any]]:
        """Read unconsumed stream events (`XREADGROUP`) for a consumer group."""
        if self._redis is not None:
            try:
                try:
                    self._redis.xgroup_create(topic, group_name, id="0", mkstream=True)
                except Exception:
                    pass
                resp = self._redis.xreadgroup(group_name, consumer_name, {topic: ">"}, count=count)
                out = []
                for _, messages in resp or []:
                    for msg_id, fields in messages:
                        out.append(
                            {
                                "stream_id": msg_id,
                                "topic": topic,
                                "payload": json.loads(fields.get("payload", "{}")),
                                "source_hash": fields.get("source_hash", ""),
                            }
                        )
                        self._redis.xack(topic, group_name, msg_id)
                if out:
                    return out
            except Exception:
                pass

        with sqlite3.connect(self.wal_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute(
                "SELECT last_created_at_ms FROM consumer_offsets WHERE group_name = ? AND topic = ?",
                (group_name, topic),
            )
            row = cur.fetchone()
            last_ts = int(row["last_created_at_ms"]) if row else 0

            cur.execute(
                """
                SELECT stream_id, topic, payload_json, source_hash, created_at_ms
                FROM stream_entries
                WHERE topic = ? AND created_at_ms > ?
                ORDER BY created_at_ms ASC
                LIMIT ?
                """,
                (topic, last_ts, count),
            )
            rows = cur.fetchall()
            events = []
            max_ts = last_ts
            for r in rows:
                events.append(
                    {
                        "stream_id": r["stream_id"],
                        "topic": r["topic"],
                        "payload": json.loads(r["payload_json"]),
                        "source_hash": r["source_hash"],
                    }
                )
                if int(r["created_at_ms"]) > max_ts:
                    max_ts = int(r["created_at_ms"])

            if rows:
                conn.execute(
                    """
                    INSERT INTO consumer_offsets (group_name, topic, last_created_at_ms)
                    VALUES (?, ?, ?)
                    ON CONFLICT(group_name, topic) DO UPDATE SET last_created_at_ms = excluded.last_created_at_ms
                    """,
                    (group_name, topic, max_ts),
                )
            return events

    def recent_entries(self, topic: str, limit: int = 25) -> list[dict[str, Any]]:
        with sqlite3.connect(self.wal_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT stream_id, topic, payload_json, source_hash, created_at_ms FROM stream_entries WHERE topic = ? ORDER BY created_at_ms DESC LIMIT ?",
                (topic, limit),
            ).fetchall()
            return [
                {
                    "stream_id": r["stream_id"],
                    "topic": r["topic"],
                    "payload": json.loads(r["payload_json"]),
                    "source_hash": r["source_hash"],
                    "created_at_ms": r["created_at_ms"],
                }
                for r in rows
            ]


class TruthStore:
    """
    Postgres + SQLite dual-compatible truth store for:
    - `agent_events`
    - `projections`
    - `sniper_alerts`
    - `clv_ledger`
    - `langgraph_checkpoints`
    Every row carries `source_hash` and `model_version`.
    """

    def __init__(
        self,
        db_path: Path | None = None,
        sqlite_path: Path | None = None,
        database_url: str | None = None,
    ):
        self.database_url = database_url or os.environ.get("DATABASE_URL")
        self.db_path = db_path or sqlite_path or (DATA_DIR / "propwire_agent_truth.db")
        self._init_schema()

    def _connect_sqlite(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect_sqlite() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_events (
                    event_id TEXT PRIMARY KEY,
                    stream_topic TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    sport TEXT NOT NULL DEFAULT 'nfl',
                    affected_game_id TEXT NOT NULL,
                    affected_player_ids TEXT NOT NULL DEFAULT '[]',
                    dedup_key TEXT NOT NULL,
                    event_payload TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    processed_at TEXT NOT NULL,
                    feed_age_seconds REAL NOT NULL,
                    is_stale INTEGER NOT NULL DEFAULT 0,
                    decision TEXT NOT NULL,
                    reason TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_agent_events_dedup ON agent_events(dedup_key);
                CREATE INDEX IF NOT EXISTS idx_agent_events_game ON agent_events(affected_game_id, processed_at DESC);

                CREATE TABLE IF NOT EXISTS projections (
                    prop_id TEXT PRIMARY KEY,
                    sport TEXT NOT NULL,
                    game_id TEXT NOT NULL,
                    player_id TEXT NOT NULL,
                    player_name TEXT NOT NULL,
                    team TEXT NOT NULL,
                    opponent TEXT NOT NULL,
                    position TEXT NOT NULL DEFAULT 'WR',
                    market TEXT NOT NULL,
                    line REAL NOT NULL,
                    mu REAL NOT NULL,
                    sd REAL NOT NULL,
                    alpha REAL,
                    k REAL,
                    mu_rec REAL,
                    mu_ypr REAL,
                    fair_line REAL NOT NULL,
                    fair_prob_over REAL NOT NULL,
                    fair_prob_under REAL NOT NULL,
                    ci_80_low REAL NOT NULL DEFAULT 0.0,
                    ci_80_high REAL NOT NULL DEFAULT 0.0,
                    confidence_score REAL NOT NULL DEFAULT 0.75,
                    minutes_projection REAL,
                    minutes_remaining REAL,
                    usage_rate REAL,
                    remaining_opportunities REAL,
                    catalyst_reason TEXT NOT NULL DEFAULT 'baseline',
                    catalyst_detail TEXT NOT NULL DEFAULT '',
                    source_hash TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    computed_at TEXT NOT NULL,
                    feed_age_seconds REAL NOT NULL,
                    is_stale INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_projections_game_player ON projections(game_id, player_id);

                CREATE TABLE IF NOT EXISTS sniper_alerts (
                    alert_id TEXT PRIMARY KEY,
                    prop_id TEXT NOT NULL,
                    sport TEXT NOT NULL,
                    game_id TEXT NOT NULL,
                    player_id TEXT NOT NULL,
                    player_name TEXT NOT NULL,
                    team TEXT NOT NULL,
                    opponent TEXT NOT NULL DEFAULT '',
                    market TEXT NOT NULL,
                    side TEXT NOT NULL,
                    venue_type TEXT NOT NULL DEFAULT 'sportsbook',
                    book TEXT NOT NULL,
                    line REAL NOT NULL,
                    odds_american INTEGER NOT NULL,
                    fair_line REAL NOT NULL,
                    fair_prob REAL NOT NULL,
                    implied_prob REAL NOT NULL,
                    edge_pct REAL NOT NULL,
                    mispricing_bps REAL NOT NULL,
                    ev_per_unit REAL NOT NULL,
                    kelly_stake REAL NOT NULL,
                    confidence_score REAL NOT NULL,
                    liquidity_score REAL NOT NULL,
                    clv_expectation REAL NOT NULL,
                    feed_age_seconds REAL NOT NULL,
                    is_stale INTEGER NOT NULL DEFAULT 0,
                    deep_link TEXT NOT NULL,
                    catalyst_reason TEXT NOT NULL,
                    reasoning_chain TEXT NOT NULL DEFAULT '',
                    source_hash TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_sniper_alerts_created ON sniper_alerts(created_at DESC);

                CREATE TABLE IF NOT EXISTS clv_ledger (
                    ledger_id TEXT PRIMARY KEY,
                    alert_id TEXT,
                    sport TEXT NOT NULL,
                    game_id TEXT NOT NULL,
                    player_id TEXT NOT NULL,
                    player_name TEXT NOT NULL,
                    team TEXT NOT NULL,
                    market TEXT NOT NULL,
                    side TEXT NOT NULL,
                    venue_type TEXT NOT NULL DEFAULT 'sportsbook',
                    book TEXT NOT NULL,
                    entry_line REAL NOT NULL,
                    entry_odds INTEGER NOT NULL,
                    entry_implied_prob REAL NOT NULL,
                    fair_prob_at_entry REAL NOT NULL,
                    edge_pct_at_entry REAL NOT NULL,
                    kelly_stake REAL NOT NULL,
                    closing_line REAL,
                    closing_odds INTEGER,
                    closing_implied_prob REAL,
                    clv_prob_delta REAL,
                    clv_bps REAL,
                    actual_stat REAL,
                    outcome TEXT DEFAULT 'PENDING',
                    source_hash TEXT NOT NULL,
                    receipt_hash TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    logged_at TEXT NOT NULL,
                    closed_at TEXT,
                    settled_at TEXT
                );

                CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
                    thread_id TEXT NOT NULL,
                    checkpoint_id TEXT NOT NULL,
                    parent_checkpoint_id TEXT,
                    state_json TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (thread_id, checkpoint_id)
                );
                """
            )

        if self.database_url:
            try:
                import psycopg2
                with psycopg2.connect(self.database_url) as pg_conn:
                    with pg_conn.cursor() as cur:
                        ddl_path = BASE_DIR / "docs" / "agent-architecture.md"
                        if ddl_path.exists():
                            text = ddl_path.read_text(encoding="utf-8")
                            if "```sql" in text:
                                sql_block = text.split("```sql", 1)[1].split("```", 1)[0]
                                cur.execute(sql_block)
            except Exception:
                pass

    def has_dedup_key(self, dedup_key: str) -> bool:
        with self._connect_sqlite() as conn:
            row = conn.execute(
                "SELECT 1 FROM agent_events WHERE dedup_key = ? AND decision != 'DEDUP_SKIPPED' LIMIT 1",
                (dedup_key,),
            ).fetchone()
            return row is not None

    def record_agent_event(
        self,
        *,
        stream_topic: str,
        agent_name: str,
        event_type: str,
        sport: str,
        affected_game_id: str,
        affected_player_ids: list[str],
        dedup_key: str,
        event_payload: dict[str, Any],
        source_hash: str,
        fetched_at: datetime,
        feed_age_seconds: float,
        is_stale: bool,
        decision: str,
        reason: str,
        model_version: str = MODEL_VERSION,
    ) -> str:
        event_id = f"evt-{uuid.uuid4().hex[:16]}"
        now_iso = datetime.now(timezone.utc).isoformat()
        fetched_iso = fetched_at.isoformat() if isinstance(fetched_at, datetime) else str(fetched_at)
        with self._connect_sqlite() as conn:
            conn.execute(
                """
                INSERT INTO agent_events (
                    event_id, stream_topic, agent_name, event_type, sport,
                    affected_game_id, affected_player_ids, dedup_key, event_payload,
                    source_hash, model_version, fetched_at, processed_at,
                    feed_age_seconds, is_stale, decision, reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    stream_topic,
                    agent_name,
                    event_type,
                    sport,
                    affected_game_id,
                    json.dumps(affected_player_ids),
                    dedup_key,
                    json.dumps(event_payload, default=str),
                    source_hash,
                    model_version,
                    fetched_iso,
                    now_iso,
                    feed_age_seconds,
                    1 if is_stale else 0,
                    decision,
                    reason,
                ),
            )
        return event_id

    def upsert_projection(self, proj: PropProjection) -> None:
        with self._connect_sqlite() as conn:
            conn.execute(
                """
                INSERT INTO projections (
                    prop_id, sport, game_id, player_id, player_name, team, opponent,
                    position, market, line, mu, sd, alpha, k, mu_rec, mu_ypr,
                    fair_line, fair_prob_over, fair_prob_under, ci_80_low, ci_80_high,
                    confidence_score, minutes_projection, minutes_remaining,
                    usage_rate, remaining_opportunities, catalyst_reason, catalyst_detail,
                    source_hash, model_version, fetched_at, computed_at,
                    feed_age_seconds, is_stale
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(prop_id) DO UPDATE SET
                    line = excluded.line,
                    mu = excluded.mu,
                    sd = excluded.sd,
                    alpha = excluded.alpha,
                    k = excluded.k,
                    mu_rec = excluded.mu_rec,
                    mu_ypr = excluded.mu_ypr,
                    fair_line = excluded.fair_line,
                    fair_prob_over = excluded.fair_prob_over,
                    fair_prob_under = excluded.fair_prob_under,
                    ci_80_low = excluded.ci_80_low,
                    ci_80_high = excluded.ci_80_high,
                    confidence_score = excluded.confidence_score,
                    minutes_projection = excluded.minutes_projection,
                    minutes_remaining = excluded.minutes_remaining,
                    usage_rate = excluded.usage_rate,
                    remaining_opportunities = excluded.remaining_opportunities,
                    catalyst_reason = excluded.catalyst_reason,
                    catalyst_detail = excluded.catalyst_detail,
                    source_hash = excluded.source_hash,
                    model_version = excluded.model_version,
                    fetched_at = excluded.fetched_at,
                    computed_at = excluded.computed_at,
                    feed_age_seconds = excluded.feed_age_seconds,
                    is_stale = excluded.is_stale
                """,
                (
                    proj.prop_id,
                    proj.sport,
                    proj.game_id,
                    proj.player_id,
                    proj.player_name,
                    proj.team,
                    proj.opponent,
                    proj.position,
                    proj.market,
                    proj.line,
                    proj.mu,
                    proj.sd,
                    proj.alpha,
                    proj.k,
                    proj.mu_rec,
                    proj.mu_ypr,
                    proj.fair_line,
                    proj.fair_prob_over,
                    proj.fair_prob_under,
                    proj.ci_80_low,
                    proj.ci_80_high,
                    proj.confidence_score,
                    proj.minutes_projection,
                    proj.minutes_remaining,
                    proj.usage_rate,
                    proj.remaining_opportunities,
                    proj.catalyst_reason,
                    proj.catalyst_detail,
                    proj.source_hash,
                    proj.model_version,
                    proj.fetched_at.isoformat(),
                    proj.computed_at.isoformat(),
                    proj.feed_age_seconds,
                    1 if proj.is_stale else 0,
                ),
            )

    def get_projection(self, prop_id: str) -> PropProjection | None:
        with self._connect_sqlite() as conn:
            row = conn.execute("SELECT * FROM projections WHERE prop_id = ?", (prop_id,)).fetchone()
            if not row:
                return None
            return self._row_to_projection(dict(row))

    def list_projections(self, sport: str | None = None, game_id: str | None = None, limit: int = 100) -> list[PropProjection]:
        query = "SELECT * FROM projections WHERE 1=1"
        params: list[Any] = []
        if sport:
            query += " AND sport = ?"
            params.append(sport)
        if game_id:
            query += " AND game_id = ?"
            params.append(game_id)
        query += " ORDER BY computed_at DESC LIMIT ?"
        params.append(limit)
        with self._connect_sqlite() as conn:
            rows = conn.execute(query, params).fetchall()
            return [self._row_to_projection(dict(r)) for r in rows]

    @staticmethod
    def _row_to_projection(d: dict[str, Any]) -> PropProjection:
        d["is_stale"] = bool(d.get("is_stale"))
        d["fetched_at"] = datetime.fromisoformat(d["fetched_at"])
        d["computed_at"] = datetime.fromisoformat(d["computed_at"])
        return PropProjection(**d)

    def insert_sniper_alert(self, alert: SniperAlert) -> None:
        with self._connect_sqlite() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sniper_alerts (
                    alert_id, prop_id, sport, game_id, player_id, player_name,
                    team, opponent, market, side, venue_type, book, line,
                    odds_american, fair_line, fair_prob, implied_prob,
                    edge_pct, mispricing_bps, ev_per_unit, kelly_stake,
                    confidence_score, liquidity_score, clv_expectation,
                    feed_age_seconds, is_stale, deep_link, catalyst_reason,
                    reasoning_chain, source_hash, model_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    alert.alert_id,
                    alert.prop_id,
                    alert.sport,
                    alert.game_id,
                    alert.player_id,
                    alert.player_name,
                    alert.team,
                    alert.opponent,
                    alert.market,
                    alert.side,
                    alert.venue_type,
                    alert.book,
                    alert.line,
                    alert.odds_american,
                    alert.fair_line,
                    alert.fair_prob,
                    alert.implied_prob,
                    alert.edge_pct,
                    alert.mispricing_bps,
                    alert.ev_per_unit,
                    alert.kelly_stake,
                    alert.confidence_score,
                    alert.liquidity_score,
                    alert.clv_expectation,
                    alert.feed_age_seconds,
                    1 if alert.is_stale else 0,
                    alert.deep_link,
                    alert.catalyst_reason,
                    alert.reasoning_chain,
                    alert.source_hash,
                    alert.model_version,
                    alert.created_at.isoformat(),
                ),
            )
        # Automatically record verified entry into clv_ledger
        self.record_clv_entry_from_alert(alert)

    def list_sniper_alerts(self, sport: str | None = None, limit: int = 50) -> list[SniperAlert]:
        query = "SELECT * FROM sniper_alerts WHERE 1=1"
        params: list[Any] = []
        if sport:
            query += " AND sport = ?"
            params.append(sport)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self._connect_sqlite() as conn:
            rows = conn.execute(query, params).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["is_stale"] = bool(d.get("is_stale"))
                d["created_at"] = datetime.fromisoformat(d["created_at"])
                out.append(SniperAlert(**d))
            return out

    def record_clv_entry_from_alert(self, alert: SniperAlert) -> str:
        ledger_id = f"clv-{alert.alert_id}"
        receipt_hash = compute_source_hash(
            {
                "alert_id": alert.alert_id,
                "prop_id": alert.prop_id,
                "line": alert.line,
                "odds": alert.odds_american,
                "fair_prob": alert.fair_prob,
                "implied_prob": alert.implied_prob,
                "source_hash": alert.source_hash,
            }
        )
        with self._connect_sqlite() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO clv_ledger (
                    ledger_id, alert_id, sport, game_id, player_id, player_name,
                    team, market, side, venue_type, book, entry_line, entry_odds,
                    entry_implied_prob, fair_prob_at_entry, edge_pct_at_entry,
                    kelly_stake, source_hash, receipt_hash, model_version, logged_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ledger_id,
                    alert.alert_id,
                    alert.sport,
                    alert.game_id,
                    alert.player_id,
                    alert.player_name,
                    alert.team,
                    alert.market,
                    alert.side,
                    alert.venue_type,
                    alert.book,
                    alert.line,
                    alert.odds_american,
                    alert.implied_prob,
                    alert.fair_prob,
                    alert.edge_pct,
                    alert.kelly_stake,
                    alert.source_hash,
                    receipt_hash,
                    alert.model_version,
                    alert.created_at.isoformat(),
                ),
            )
        return ledger_id

    def update_clv_close(
        self,
        ledger_id: str | None = None,
        closing_line: float = 0.0,
        closing_odds: int = -110,
        closing_implied_prob: float = 0.5,
        actual_stat: float | None = None,
        outcome: str | None = None,
        alert_id: str | None = None,
    ) -> dict[str, Any] | None:
        target_ledger_id = ledger_id or (f"clv-{alert_id}" if alert_id else "")
        with self._connect_sqlite() as conn:
            row = conn.execute(
                "SELECT * FROM clv_ledger WHERE ledger_id = ? OR alert_id = ?",
                (target_ledger_id, alert_id or target_ledger_id),
            ).fetchone()
            if not row:
                return None
            actual_lid = str(row["ledger_id"])
            side = str(row["side"]).upper()
            entry_imp = float(row["entry_implied_prob"])
            clv_delta = (closing_implied_prob - entry_imp) if side in ("OVER", "YES") else (entry_imp - closing_implied_prob)
            clv_bps = round(clv_delta * 10000.0, 1)
            now_iso = datetime.now(timezone.utc).isoformat()
            conn.execute(
                """
                UPDATE clv_ledger
                SET closing_line = ?, closing_odds = ?, closing_implied_prob = ?,
                    clv_prob_delta = ?, clv_bps = ?, actual_stat = COALESCE(?, actual_stat),
                    outcome = COALESCE(?, outcome), closed_at = ?
                WHERE ledger_id = ?
                """,
                (
                    closing_line,
                    closing_odds,
                    closing_implied_prob,
                    round(clv_delta, 4),
                    clv_bps,
                    actual_stat,
                    outcome,
                    now_iso,
                    actual_lid,
                ),
            )
            updated = conn.execute("SELECT * FROM clv_ledger WHERE ledger_id = ?", (actual_lid,)).fetchone()
            return dict(updated) if updated else None

    def list_clv_ledger(self, sport: str | None = None, venue_type: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        query = "SELECT * FROM clv_ledger WHERE 1=1"
        params: list[Any] = []
        if sport:
            query += " AND sport = ?"
            params.append(sport)
        if venue_type:
            query += " AND venue_type = ?"
            params.append(venue_type)
        query += " ORDER BY logged_at DESC LIMIT ?"
        params.append(limit)
        with self._connect_sqlite() as conn:
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def list_agent_events(self, limit: int = 50, decision: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM agent_events WHERE 1=1"
        params: list[Any] = []
        if decision:
            query += " AND decision = ?"
            params.append(decision)
        query += " ORDER BY processed_at DESC LIMIT ?"
        params.append(limit)
        with self._connect_sqlite() as conn:
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def save_checkpoint(
        self,
        thread_id: str,
        checkpoint_id: str,
        state: dict[str, Any] | None = None,
        source_hash: str = "",
        parent_checkpoint_id: str | None = None,
        state_dict: dict[str, Any] | None = None,
    ) -> None:
        payload_state = state if state is not None else (state_dict or {})
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._connect_sqlite() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO langgraph_checkpoints
                (thread_id, checkpoint_id, parent_checkpoint_id, state_json, source_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    thread_id,
                    checkpoint_id,
                    parent_checkpoint_id,
                    json.dumps(payload_state, default=str),
                    source_hash,
                    now_iso,
                ),
            )

    def save_sniper_alert(self, alert: SniperAlert) -> None:
        """Alias for insert_sniper_alert that also writes to clv_ledger."""
        self.insert_sniper_alert(alert)

    def get_recent_alerts(self, sport: str | None = None, limit: int = 25) -> list[dict[str, Any]]:
        """Return recent SniperAlert rows as JSON-ready dicts."""
        return [a.model_dump(mode="json") for a in self.list_sniper_alerts(sport=sport, limit=limit)]

    def get_recent_suppressions(self, limit: int = 25) -> list[dict[str, Any]]:
        """Return recent suppressed or stale-halted agent events."""
        with self._connect_sqlite() as conn:
            rows = conn.execute(
                """
                SELECT * FROM agent_events
                WHERE decision IN ('SUPPRESSED', 'HALTED_STALE', 'DEDUP_SKIPPED')
                ORDER BY processed_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def record_event(
        self,
        *,
        event_type: str,
        prop_id: str,
        game_id: str,
        player_id: str,
        payload: dict[str, Any],
        source_hash: str,
        fetched_at: datetime,
        feed_age_seconds: float,
        is_stale: bool,
        decision: str,
        reason: str,
        latency_ms: float = 0.0,
        agent_name: str = "SniperAgent",
        sport: str = "nba",
    ) -> str:
        """Convenience wrapper around record_agent_event."""
        return self.record_agent_event(
            stream_topic=TOPIC_SNIPER if "sniper" in event_type else TOPIC_MARKET,
            agent_name=agent_name,
            event_type=event_type,
            sport=sport,
            affected_game_id=game_id,
            affected_player_ids=[player_id] if player_id else [],
            dedup_key=f"{event_type}:{prop_id}:{source_hash[:12]}",
            event_payload=payload,
            source_hash=source_hash,
            fetched_at=fetched_at,
            feed_age_seconds=feed_age_seconds,
            is_stale=is_stale,
            decision=decision,
            reason=reason,
        )

    def get_clv_summary(self) -> dict[str, Any]:
        """
        Compute transparent CLV Ledger summary including:
        - Total logged entries (Sportsbook + Polymarket fills)
        - Closed sample size, % beating closing line, mean CLV bps, 95% confidence interval
        - Full ledger rows with cryptographic verification receipt hashes
        """
        import math

        entries = self.list_clv_ledger(limit=100)
        closed = [e for e in entries if e.get("clv_bps") is not None]
        n_closed = len(closed)
        if n_closed > 0:
            bps_vals = [float(e["clv_bps"]) for e in closed]
            mean_bps = sum(bps_vals) / n_closed
            beat_count = sum(1 for b in bps_vals if b > 0)
            pct_beating_close = round((beat_count / n_closed) * 100.0, 1)
            if n_closed > 1:
                var = sum((b - mean_bps) ** 2 for b in bps_vals) / (n_closed - 1)
                se = math.sqrt(var / n_closed)
            else:
                se = 45.0
            ci_95_low_bps = round(mean_bps - 1.96 * se, 1)
            ci_95_high_bps = round(mean_bps + 1.96 * se, 1)
        else:
            mean_bps = 0.0
            pct_beating_close = 0.0
            ci_95_low_bps = 0.0
            ci_95_high_bps = 0.0

        poly_fills = sum(1 for e in entries if e.get("venue_type") == "polymarket")
        return {
            "total_logged": len(entries),
            "closed_count": n_closed,
            "polymarket_fills_count": poly_fills,
            "pct_beating_close": pct_beating_close,
            "mean_clv_bps": round(mean_bps, 1),
            "ci_95_bps": [ci_95_low_bps, ci_95_high_bps],
            "entries": entries,
        }

    def load_latest_checkpoint(self, thread_id: str) -> dict[str, Any] | None:
        with self._connect_sqlite() as conn:
            row = conn.execute(
                """
                SELECT * FROM langgraph_checkpoints
                WHERE thread_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (thread_id,),
            ).fetchone()
            if not row:
                return None
            return {
                "thread_id": row["thread_id"],
                "checkpoint_id": row["checkpoint_id"],
                "parent_checkpoint_id": row["parent_checkpoint_id"],
                "state": json.loads(row["state_json"]),
                "source_hash": row["source_hash"],
                "created_at": row["created_at"],
            }
