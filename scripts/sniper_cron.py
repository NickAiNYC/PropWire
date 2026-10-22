#!/usr/bin/env python3
"""
PROP·WIRE Autonomous Market Sniper — Server-Side Cron Evaluator
Executes off-browser evaluation of incoming book quotes against execution hurdles.
Handles 3am overnight runs, enforces 15-minute de-duplication per line,
and dispatches webhook alerts without exposing tokens to client-side browsers.

Usage:
    python scripts/sniper_cron.py [--min-edge 0.15] [--webhook https://discord.com/api/webhooks/...]
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
VIEWER_DIR = os.path.join(BASE_DIR, "viewer")
COOLDOWN_FILE = os.path.join(BASE_DIR, "data", "sniper_cooldowns.json")


def load_cooldowns() -> dict:
    if os.path.exists(COOLDOWN_FILE):
        try:
            with open(COOLDOWN_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_cooldowns(data: dict):
    os.makedirs(os.path.dirname(COOLDOWN_FILE), exist_ok=True)
    try:
        with open(COOLDOWN_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as exc:
        sys.stderr.write(f"[WARN] Failed to save cooldowns: {exc}\n")


def dispatch_webhook(webhook_url: str, payload: dict) -> bool:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "PROP-WIRE-Sniper-Cron/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status in (200, 204)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"[ERROR] Webhook dispatch HTTP {e.code}: {e.reason}\n")
        return False
    except Exception as e:
        sys.stderr.write(f"[ERROR] Webhook dispatch exception: {e}\n")
        return False


def main():
    parser = argparse.ArgumentParser(description="Evaluate live odds against Sniper criteria server-side.")
    parser.add_argument("--min-edge", type=float, default=0.15, help="Minimum probability edge (default 0.15)")
    parser.add_argument("--gate-met-only", action="store_true", default=True, help="Require institutional gate met and EV > 0")
    parser.add_argument("--webhook", type=str, default=os.environ.get("SNIPER_WEBHOOK_URL", ""), help="Webhook URL")
    parser.add_argument("--dry-run", action="store_true", help="Print alerts without dispatching webhooks")
    args = parser.parse_args()

    odds_file = os.path.join(VIEWER_DIR, "live_odds_feed.json")
    if not os.path.exists(odds_file):
        print(f"[INFO] No live odds feed found at {odds_file}. Exiting.")
        return 0

    with open(odds_file, "r", encoding="utf-8") as f:
        feed = json.load(f)

    quotes = feed.get("quotes", [])
    now_ms = int(time.time() * 1000)
    cooldowns = load_cooldowns()

    # Clean old cooldowns (> 2 hours)
    cooldowns = {k: v for k, v in cooldowns.items() if now_ms - v < 2 * 3600 * 1000}

    alerts = []
    print(f"[INFO] Evaluating {len(quotes)} quotes with min_edge >= {args.min_edge:.1%}, gate_met_only={args.gate_met_only}")

    snaps_file = os.path.join(VIEWER_DIR, "snapshots_2026_w7.json")
    open_lines = {}
    if os.path.exists(snaps_file):
        try:
            with open(snaps_file, "r", encoding="utf-8") as f:
                snaps = json.load(f)
                for s in snaps:
                    if s.get("quote") and s["quote"].get("line") is not None:
                        open_lines[f"{s.get('player_id')}::{s.get('market')}"] = float(s["quote"]["line"])
        except Exception:
            pass

    for quote in quotes:
        ev = quote.get("evaluation", {})
        edge = float(ev.get("prob_edge", 0.0))
        expected_return = float(ev.get("expected_return", 0.0))
        is_qualified = bool(ev.get("is_qualified", False))

        qualified = not args.gate_met_only or (is_qualified and expected_return > 0)
        if edge >= args.min_edge and qualified:
            k = f"{quote.get('player_id')}::{quote.get('market')}"

            # Volatility Circuit Breaker check (> 1.5σ line drift)
            cur_line = float(quote.get("line", 0.0))
            is_yards = quote.get("market") == "receiving_yards"
            open_line = open_lines.get(k)
            if open_line is not None and open_line > 0:
                drift = round(cur_line - open_line, 1)
                abs_drift = abs(drift)
                drift_pct = abs_drift / open_line
                hurdle = 4.5 if is_yards else 1.0
                if abs_drift >= hurdle or drift_pct >= 0.12:
                    print(f"[CIRCUIT BREAKER HALT] Skipping {quote.get('player_name')} ({k}) — line drifted {drift:+} ({drift_pct:.1%}). Suspected unmodeled news/injury downgrade.")
                    continue

            last_alert = cooldowns.get(k, 0)
            if now_ms - last_alert < 15 * 60 * 1000:
                print(f"[COOLDOWN] Skipping {quote.get('player_name')} ({k}) — alerted within 15 mins")
                continue

            side = ev.get("best_side", "OVER")
            odds_val = quote.get("under_odds" if side == "UNDER" else "over_odds")
            alert_payload = {
                "event": "PROP_WIRE_SNIPER_ALERT",
                "source": "PROP·WIRE Server Cron",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "player_id": quote.get("player_id"),
                "player": quote.get("player_name"),
                "team": quote.get("team"),
                "opponent": quote.get("opponent"),
                "market": quote.get("market"),
                "side": side,
                "line": quote.get("line"),
                "odds": odds_val,
                "edge_pct": round(edge * 100, 1),
                "expected_return": round(expected_return * 100, 1),
                "book": quote.get("book"),
                "review_url": f"https://propwire.vercel.app/?inspect={quote.get('player_id')}&market={quote.get('market')}"
            }
            alerts.append(alert_payload)
            cooldowns[k] = now_ms

            if args.webhook and not args.dry_run:
                success = dispatch_webhook(args.webhook, alert_payload)
                print(f"[DISPATCH] Sent alert for {quote.get('player_name')}: {'OK' if success else 'FAIL'}")
            else:
                print(f"[TRIGGER] {quote.get('player_name')} ({quote.get('team')}) {side} {quote.get('line')} | Edge: +{edge*100:.1f}% | EV: +{expected_return*100:.1f}%")

    save_cooldowns(cooldowns)
    print(f"[COMPLETE] {len(alerts)} alerts triggered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
