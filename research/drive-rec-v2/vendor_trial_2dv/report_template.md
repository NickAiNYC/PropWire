# Decision 2D-V — Vendor Trial Acceptance (report wrapper)

This wrapper binds the machine-generated `evidence/TRIAL_REPORT.md` (produced
by `verify_v1_v10.py`) to the human decision record. The generated report
contains: (1) the verified sample table, (2) the coverage and missingness
report, (3) actual API consumption, and (4) the check verdicts — this wrapper
adds what only a human can supply.

## Machine-generated evidence (fill after the real run)

- Trial run date (UTC): ______________________
- Raw acquisition directory: `raw/` — manifest sha256: ______________________
- Evidence directory: `evidence/` — checks_summary overall: ______________________
- Credits: modeled ________ / actual ________ (ledger: `raw/credit_ledger.jsonl`)
- TRIAL_REPORT.md attached: [ ] yes  [ ] no

## Human-supplied sections

### Vendor account and purchase record

- The Odds API plan/tier used: ______________________
- Credits purchased for the trial: ________ ; cost: ________
- Purchase authorization reference (decision/message): ______________________

### V8 — written commercial permission

- Attached in `ATTACHMENT_V8_COMMERCIAL_RIGHTS.md`: [ ] yes [ ] no
- Covers storage of raw quotes: [ ] yes [ ] no
- Covers storage of derived metrics/signals: [ ] yes [ ] no
- Covers commercial display of derived data: [ ] yes [ ] no
- Attribution/retention conditions (if any): ______________________

### Anomalies observed during the run (human review of V6 missingness ledger)

- Books with partial coverage: ______________________
- Players with pulled/missing lines beyond the recorded pattern: ______________________
- Discovery misses (event-id mapping failures): ______________________
- Other: ______________________

## Acceptance decision (Decision 2D-V)

| Item | Verdict |
| --- | --- |
| V1 historical availability (2025 + 2026 receiving props) | PASS / FAIL |
| V2 timestamp integrity | PASS / FAIL |
| V3 market identification | PASS / FAIL |
| V4 sportsbook identity | PASS / FAIL |
| V5 price integrity | PASS / FAIL |
| V6 missingness explicitly recorded | PASS / FAIL |
| V7 settlement reconciliation | PASS / FAIL |
| V8 commercial rights (written permission) | CONFIRMED / PENDING |
| V9 cost reconciliation | PASS / FAIL |
| V10 reproducibility | PASS / FAIL |

**Recommendation:** [ ] PROCEED — authorize the full 392-game acquisition
(~11,760 credits at three observation times / ~15,680 at four snapshots,
plus retries and discovery), subject to a separate purchase authorization.
[ ] BLOCK — resolve the critical failures listed above first; no purchase.

**Sign-off:** reviewer ______________________ date ______________________

> Reminder of the controlling distinction: this trial establishes whether the
> DATA and infrastructure are sound. It does not establish a profitable,
> executable betting strategy; that question belongs to the Decision 2D pilot
> gates E1–E6, and promotion additionally requires Phase B prospective
> validation plus human approval. Model status remains RESEARCH_ONLY either
> way.
