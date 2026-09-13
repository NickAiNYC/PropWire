"""
Deployment surface: FastAPI on Railway.

NOT Vercel. Vercel's serverless functions have a hard execution ceiling and a
cold-start penalty that a statsmodels GLM fit will blow through, and the
filesystem is ephemeral so your CLV log evaporates. Railway (or Fly, or a
small VPS) gives you a persistent process, a real disk, and a cron. Use
Vercel for the marketing page if you want one.

The weekly job runs on a schedule, writes picks to disk, and the API serves
them. Model fitting never happens inside a request.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from agent import clv_report  # noqa: E402

app = FastAPI(title="Receiving Props Agent", version="0.1.0")

PICKS_PATH = os.environ.get("PICKS_PATH", "/data/current_picks.json")
LOG_PATH = os.environ.get("PICKS_LOG", "/data/picks_log.jsonl")


# ---------------------------------------------------------------------------
# Entitlement. Whop is the storefront; Stripe is the processor behind it.
# Verify server-side on every request - a client-side check is not a paywall.
# ---------------------------------------------------------------------------

def verify_entitlement(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization.split(" ", 1)[1]

    import requests
    key = os.environ.get("WHOP_API_KEY")
    if not key:
        raise HTTPException(500, "WHOP_API_KEY not configured")
    r = requests.get(
        "https://api.whop.com/api/v2/memberships",
        headers={"Authorization": f"Bearer {key}"},
        params={"membership_id": token}, timeout=10)
    if r.status_code != 200:
        raise HTTPException(401, "could not verify membership")
    m = r.json()
    if m.get("status") not in ("active", "trialing", "completed"):
        raise HTTPException(403, "membership not active")
    return m


@app.get("/health")
def health():
    return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}


@app.get("/picks")
def picks(authorization: str | None = Header(default=None)):
    verify_entitlement(authorization)
    if not os.path.exists(PICKS_PATH):
        return JSONResponse({"picks": [], "note": "no slate generated yet"})
    with open(PICKS_PATH) as f:
        data = json.load(f)

    # Every response ships the track record alongside the picks. If the CLV
    # report says the edge is not distinguishable from zero, the customer sees
    # that in the same payload as the pick. This is not a concession - it is
    # the only version of this product that is defensible.
    data["performance"] = clv_report(LOG_PATH) if os.path.exists(LOG_PATH) else \
        {"status": "insufficient history"}
    data["disclaimer"] = (
        "Statistical estimates for entertainment and research. Not financial "
        "advice. No outcome is guaranteed. Past performance does not predict "
        "future results. 21+ where legal. If gambling is causing harm, call "
        "1-800-GAMBLER."
    )
    return data


@app.get("/performance")
def performance():
    """Public and unauthenticated on purpose. A pick service that hides its
    record behind the paywall is asking to be taken on faith."""
    return clv_report(LOG_PATH) if os.path.exists(LOG_PATH) else \
        {"status": "insufficient history"}


@app.post("/webhooks/stripe")
async def stripe_webhook(request_body: dict):
    """Whop handles subscription lifecycle. Wire this only if you bill Stripe
    directly - and read docs/PAYMENTS.md first, because sports-pick sellers
    are a restricted category and getting this wrong freezes your balance."""
    return {"received": True}
