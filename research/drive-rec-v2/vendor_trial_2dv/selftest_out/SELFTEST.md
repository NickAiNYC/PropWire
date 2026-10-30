# Decision 2D-V Harness Self-Test — SYNTHETIC, no vendor data

**Overall: PASS** (15 tests)

| test | status | detail |
| --- | --- | --- |
| T1_fixture_determinism | **PASS** | regeneration byte-identical (fff4494aea63…) |
| T2_clean_run | **PASS** | verdicts match expected: {"V1": "PASS", "V2": "PASS", "V3": "PASS", "V4": "PASS", "V5": "PASS", "V6": "PASS", "V7": "PASS", "V8": "PENDING_MANUAL", "V9": "PASS", "V10": "PASS", "overall": "BLOCKED_PENDING_MANUAL"} |
| T3_fault_sensitivity | **PASS** | all 9 injected faults caught by their target checks |
| T3b_fault_details | **PASS** | V7 reports exactly the 2 injected settlement faults (got 2) |
| T3c_fault_details | **PASS** | V3 catches the F8 provenance fault: SYN25_G02: discovery_timestamp_utc missing or invalid (None) (owner requirement: record the discovery timestamp) |
| T3d_fault_details | **PASS** | V9 catches F9 (unestablished row) and F7 (actual 25 != modeled 10) |
| T4_tamper_detection | **PASS** | flipped byte in SYN25_G01__T-15m.json -> V10 FAIL |
| T5_verifier_determinism | **PASS** | 11 evidence JSONs byte-identical on re-run |
| T6_synthetic_refusal | **PASS** | decision_2d.quotes.validate_quotes: REFUSED (fail-closed intact) |
| T7_quarantine_guards | **PASS** | G1 refit lock / G2 sample freeze / G3 confinement hold |
| T8_credential_safety | **PASS** | REAL mode without ODDS_API_KEY refuses to run (key never accepted from files/arguments/chat) |
| T9_credit_fail_closed | **PASS** | response without usage headers -> ABORT PARTIAL (1 unestablished ledger row(s); reason: historical_event_odds/SYN26_G08@T-15m: x-requests-used missing on non-retryable …) |
| T10_budget_cap_all_kinds | **PASS** | cap=25 -> abort PARTIAL pre-request after 2 quote pulls (measured 20 credits, running max 20 <= 25; reason: budget guard (pre-request): measured spend 20 + modeled 10 >…) |
| T11_event_map_required | **PASS** | acquisition without event_id_map.json refuses to run (verified historical event IDs required first) |
| T12_discover_tool | **PASS** | discover_event_ids.py refuses REAL mode without ODDS_API_KEY; offline --selftest passes |

Fault-injection coverage (fixtures/faulted): F1->V2, F2->V3, F3->V4, F4->V5, F5->V6 (ledgered), F6->V7 (x2), F7->V9, F8->V3 (event-map provenance), F9->V9 (meter fail-closed); tamper->V10.

No vendor request was made; no credits were consumed; no API key exists in this environment.
