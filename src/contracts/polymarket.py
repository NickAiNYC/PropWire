"""Contract for the mixed odds feed after CLOB player-prop ingestion."""
from __future__ import annotations

import math
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PolymarketQuote(BaseModel):
    model_config = ConfigDict(extra="allow")

    quote_id: str = Field(min_length=1)
    book: str = Field(min_length=1)
    player_id: str = Field(min_length=1)
    market: str = Field(min_length=1)
    line: float = Field(gt=0, lt=300)
    over_odds: int
    under_odds: int
    observed_at: datetime
    over_token_id: str = Field(min_length=1)
    under_token_id: str = Field(min_length=1)
    over_ask_price: float = Field(gt=0, lt=1)
    under_ask_price: float = Field(gt=0, lt=1)
    over_ask_depth_usd: float = Field(gt=0)
    under_ask_depth_usd: float = Field(gt=0)
    liquidity_usd: float = Field(gt=0)
    source_url: str = Field(min_length=1)
    content_hash: str = Field(min_length=64, max_length=64)

    @model_validator(mode="after")
    def check_book(self):
        if self.book != "Polymarket" or self.over_token_id == self.under_token_id:
            raise ValueError("invalid Polymarket outcome tokens")
        if not all(math.isfinite(n) for n in (self.line, self.over_ask_price,
                                              self.under_ask_price, self.over_ask_depth_usd,
                                              self.under_ask_depth_usd, self.liquidity_usd)):
            raise ValueError("non-finite price or depth")
        if self.observed_at.tzinfo is None:
            raise ValueError("observed_at must include timezone")
        if self.liquidity_usd > min(self.over_ask_depth_usd, self.under_ask_depth_usd):
            raise ValueError("liquidity exceeds executable depth")
        if any(abs(odds) < 100 for odds in (self.over_odds, self.under_odds)):
            raise ValueError("invalid American odds")
        return self


class PolymarketMergedFeed(BaseModel):
    model_config = ConfigDict(extra="allow")

    feed_status: str = Field(min_length=1)
    updated_at: datetime
    quotes: list[dict]
    total_quotes: int = Field(ge=0)
    polymarket_quotes_count: int = Field(gt=0)
    verified_books_count: int = Field(default=0, ge=0)
    verified_quotes_count: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def check_quotes(self):
        if self.total_quotes != len(self.quotes):
            raise ValueError("total_quotes mismatch")
        polymarket = [q for q in self.quotes if q.get("book") == "Polymarket"]
        if len(polymarket) != self.polymarket_quotes_count:
            raise ValueError("polymarket_quotes_count mismatch")
        # A local content hash records what we saw; it cannot verify an
        # independently executable provider price. This publisher has no
        # independent receipt check, so the mixed feed must remain unverified.
        if self.feed_status != "LIVE_POLYMARKET_CLOB_UNVERIFIED":
            raise ValueError("Polymarket feed must identify unverified CLOB observations")
        if self.verified_books_count or self.verified_quotes_count:
            raise ValueError("unverified Polymarket feed cannot claim verified counts")
        for quote in polymarket:
            PolymarketQuote.model_validate(quote)
            if quote.get("verified") is True or str((quote.get("evaluation") or {}).get("status", "")).upper() == "VERIFIED":
                raise ValueError("Polymarket observation cannot claim independent verification")
        return self
