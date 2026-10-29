from pathlib import Path
import pytest
from src.services.arb_ledger import (
    compute_entry_receipt_hash,
    compute_receipt_hash,
    verify_receipt,
    calculate_clv,
    build_verifiable_receipt,
    ArbLedgerService,
)
from src.agents.persistence import TruthStore


def test_sha256_receipt_hashing_and_tamper_detection():
    data = {
        "alert_id": "alert_test_101",
        "market": "PTS",
        "prop_type": "points",
        "line": 28.5,
        "entry_line": 28.5,
        "entry_odds_book": 1.909091,
        "fair_prob": 0.58,
        "source_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "model_version": "propwire-dist-v2.4",
        "status": "PENDING",
    }
    h1 = compute_entry_receipt_hash(data)
    assert isinstance(h1, str) and len(h1) == 64
    data["entry_receipt_hash"] = h1
    h_full = compute_receipt_hash(data)
    data["receipt_hash"] = h_full

    # Verification passes with untampered data
    res = verify_receipt(data)
    assert res["verified"] is True

    # Tampering with line fails verification
    tampered = dict(data)
    tampered["line"] = 29.5
    tampered_res = verify_receipt(tampered)
    assert tampered_res["verified"] is False


def test_clv_calculation():
    # Entry odds 2.10 (+110) closing at 1.90 (-111) -> CLV = (2.10 - 1.90) / 1.90 = +10.53%
    res = calculate_clv(2.10, 1.90)
    assert res["clv_pct"] == 10.5263
    assert res["clv_ratio"] == 0.105263

    # Negative CLV when price moved against bettor
    res_neg = calculate_clv(1.85, 2.00)
    assert res_neg["clv_pct"] == -7.5000


def test_arb_ledger_service_grading_and_receipt(tmp_path):
    truth = TruthStore(sqlite_path=tmp_path / "test.db")
    ledger = ArbLedgerService(truth_store=truth)

    alert_id = "test_alert_999"
    truth.upsert_arb_history({
        "alert_id": alert_id,
        "player_id": "giannis_1",
        "player_name": "Giannis Antetokounmpo",
        "market": "PTS",
        "side": "OVER",
        "line": 31.5,
        "entry_line": 31.5,
        "entry_odds_book": 1.95,
        "fair_line": 34.2,
        "fair_prob": 0.62,
        "source_hash": "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "status": "PENDING",
    })

    # Grade the alert
    updated = ledger.grade_alert(
        alert_id=alert_id,
        closing_line=32.5,
        closing_odds_book=1.80,
        actual_stat=36.0,
        result="won",
    )
    assert updated is not None
    assert updated["status"] == "GRADED"
    assert updated["clv_pct"] > 0
    assert updated["result"] == "won"

    # Fetch self-contained receipt
    receipt = ledger.get_receipt(alert_id)
    assert receipt is not None
    assert receipt["claim"] == "No LLM in Decision Path — Verified SHA-256 Receipt"
    assert receipt["alert_id"] == alert_id
    assert receipt["verified"] is True
    assert "receipt_hash" in receipt

    # Public ledger contains graded entry
    pub = ledger.get_public_ledger(limit=10)
    assert pub["total_graded_alerts"] >= 1
    assert len(pub["receipts"]) >= 1


def test_api_receipt_and_history_endpoints():
    from fastapi.testclient import TestClient
    from api.main import app

    client = TestClient(app)

    # 1. Test public arb ledger performance endpoint
    res_ledger = client.get("/api/ledger?limit=10")
    assert res_ledger.status_code == 200
    ledger_data = res_ledger.json()
    assert "total_graded_alerts" in ledger_data
    assert "average_clv_beat_pct" in ledger_data
    assert "receipts" in ledger_data

    # 2. Test paginated sniper history endpoint
    res_hist = client.get("/api/sniper/history?limit=10")
    assert res_hist.status_code == 200
    hist_data = res_hist.json()
    assert "total_alerts" in hist_data
    assert "items" in hist_data

    # 3. Test private history requires auth when private_only=True
    res_unauth = client.get("/api/sniper/history?private_only=true")
    assert res_unauth.status_code == 401

    # 4. Authorized request passes
    res_auth = client.get(
        "/api/sniper/history?private_only=true",
        headers={"X-PropWire-API-Key": "pw_quant_live_key"},
    )
    assert res_auth.status_code == 200


def test_public_verify_landing_page():
    from fastapi.testclient import TestClient
    from api.main import app

    client = TestClient(app)
    # Fully public, zero-auth landing page works for anyone in incognito
    res = client.get("/verify/sub_alert_1")
    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")
    assert "Verified Sniper Receipt" in res.text
    assert "No LLM in Decision Path" in res.text

    # Route at /verify without param also serves the landing page
    res_base = client.get("/verify")
    assert res_base.status_code == 200


def test_stripe_billing_checkout_and_webhook():
    import secrets
    from fastapi.testclient import TestClient
    from api.main import app
    from src.services.billing import verify_stripe_webhook_signature

    client = TestClient(app)
    uid = f"usr_test_{secrets.token_hex(4)}"

    # 1. Create checkout session for $29/mo
    res_checkout = client.post(
        "/api/billing/create-checkout-session",
        json={"plan": "pro_monthly", "user_id": uid, "email": "sharp@example.com"},
    )
    assert res_checkout.status_code == 200
    ch_data = res_checkout.json()
    assert "checkout_url" in ch_data
    assert ch_data["plan"] == "pro_monthly"

    # 2. Check billing status defaults to free observer before payment
    res_status = client.get(f"/api/billing/status?user_id={uid}")
    assert res_status.status_code == 200
    status_data = res_status.json()
    assert status_data["is_pro"] is False
    assert status_data["tier"] == "free"

    # 3. Simulate an idempotent, properly SIGNED Stripe webhook (fail-closed era:
    #    the endpoint refuses unsigned events when STRIPE_WEBHOOK_SECRET is set)
    import hashlib
    import hmac as _hmac
    import json as _json
    import os as _os
    import time as _time

    webhook_payload = {
        "id": "evt_test_001",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": f"cs_test_{uid}",
                "client_reference_id": uid,
                "customer": f"cus_{uid}",
                "subscription": f"sub_{uid}",
                "metadata": {"user_id": uid, "plan": "pro_monthly"},
            }
        },
    }

    secret = "whsec_test_propwire_fail_closed"
    prev_secret = _os.environ.get("STRIPE_WEBHOOK_SECRET")
    try:
        # 3a. Unsigned request with NO configured secret must be REJECTED (fail-closed, 503)
        _os.environ.pop("STRIPE_WEBHOOK_SECRET", None)
        res_unsigned = client.post("/api/billing/webhook", json=webhook_payload)
        assert res_unsigned.status_code == 503, "unsigned webhooks must not unlock PRO"

        # 3b. With a secret configured, a bad/missing signature must be REJECTED (400)
        _os.environ["STRIPE_WEBHOOK_SECRET"] = secret
        res_tampered = client.post(
            "/api/billing/webhook",
            content=_json.dumps(webhook_payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Stripe-Signature": f"t={int(_time.time())},v1={'0' * 64}",
            },
        )
        assert res_tampered.status_code == 400

        # 3c. Correctly signed request is processed
        raw = _json.dumps(webhook_payload).encode()
        ts = int(_time.time())
        computed = _hmac.new(secret.encode(), f"{ts}.".encode() + raw, hashlib.sha256).hexdigest()
        res_webhook = client.post(
            "/api/billing/webhook",
            content=raw,
            headers={
                "Content-Type": "application/json",
                "Stripe-Signature": f"t={ts},v1={computed}",
            },
        )
        assert res_webhook.status_code == 200
        wh_result = res_webhook.json()
        assert wh_result["processed"] is True
    finally:
        if prev_secret is None:
            _os.environ.pop("STRIPE_WEBHOOK_SECRET", None)
        else:
            _os.environ["STRIPE_WEBHOOK_SECRET"] = prev_secret

    # 4. Now user status must be PRO
    res_status_pro = client.get(f"/api/billing/status?user_id={uid}")
    assert res_status_pro.status_code == 200
    pro_data = res_status_pro.json()
    assert pro_data["is_pro"] is True
    assert pro_data["tier"] == "pro"
    assert pro_data["plan"] == "pro_monthly"

    # 5. Customer portal creation
    res_portal = client.post(
        "/api/billing/create-portal-session",
        json={"customer_id": f"cus_{uid}"},
    )
    assert res_portal.status_code == 200
    assert "portal_url" in res_portal.json()
