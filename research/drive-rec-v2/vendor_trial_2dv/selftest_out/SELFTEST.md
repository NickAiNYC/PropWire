# Decision 2D-V Harness Self-Test — SYNTHETIC, no vendor data

**Overall: PASS** (9 tests)

| test | status | detail |
| --- | --- | --- |
| T1_fixture_determinism | **PASS** | regeneration byte-identical (1de4f7a59f54…) |
| T2_clean_run | **PASS** | verdicts match expected: {"V1": "PASS", "V2": "PASS", "V3": "PASS", "V4": "PASS", "V5": "PASS", "V6": "PASS", "V7": "PASS", "V8": "PENDING_MANUAL", "V9": "PASS", "V10": "PASS", "overall": "BLOCKED_PENDING_MANUAL"} |
| T3_fault_sensitivity | **PASS** | all 7 injected faults caught by their target checks |
| T3b_fault_details | **PASS** | V7 reports exactly the 2 injected settlement faults (got 2) |
| T4_tamper_detection | **PASS** | flipped byte in SYN25_G01__T-15m.json -> V10 FAIL |
| T5_verifier_determinism | **PASS** | 11 evidence JSONs byte-identical on re-run |
| T6_synthetic_refusal | **PASS** | decision_2d.quotes.validate_quotes: REFUSED (fail-closed intact) |
| T7_quarantine_guards | **PASS** | G1 refit lock / G2 sample freeze / G3 confinement hold |
| T8_credential_safety | **PASS** | REAL mode without ODDS_API_KEY refuses to run (key never accepted from files/arguments/chat) |

Fault-injection coverage (fixtures/faulted): F1->V2, F2->V3, F3->V4, F4->V5, F5->V6 (ledgered), F6->V7 (x2), F7->V9; tamper->V10.

No vendor request was made; no credits were consumed; no API key exists in this environment.
