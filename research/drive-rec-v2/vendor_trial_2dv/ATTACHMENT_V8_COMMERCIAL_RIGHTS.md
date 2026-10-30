# ATTACHMENT V8 — Written Commercial Permission (MANUAL EVIDENCE)

> This attachment is the ONLY acceptable form of evidence for check V8
> (commercial rights). It must be completed by the project owner with the
> vendor's WRITTEN permission covering the three intended uses: (a) storing
> raw quotes, (b) storing derived metrics/signals, (c) displaying derived
> data in a commercial product. A trial run cannot reach PASS while this
> attachment is unfilled; absence leaves the trial BLOCKED_PENDING_MANUAL,
> which also blocks the full 392-game acquisition (Decision 2D review,
> 2026-10-30, acceptance rule).

status: PENDING

## Vendor

- Vendor: The Odds API (primary) / SportsDataIO (secondary)
- Plan / agreement reference: [PLAN OR AGREEMENT REFERENCE]
- Date of written permission: [DATE]
- Permission received via: [EMAIL / PORTAL / CONTRACT ATTACHMENT]

## Written permission text

[PASTE THE VENDOR'S WRITTEN PERMISSION VERBATIM, INCLUDING ANY SCOPE,
RETENTION, ATTRIBUTION, OR REDISTRIBUTION CONDITIONS]

## Scope confirmation checklist (each must be covered by the text above)

- [ ] Storing raw historical quote responses: covered / NOT covered
- [ ] Storing derived metrics, signals, and backtest results: covered / NOT covered
- [ ] Displaying derived data in a commercial product: covered / NOT covered
- [ ] Attribution requirements recorded (if any): [REQUIREMENTS]
- [ ] Retention limits recorded (if any): [LIMITS]

## Sign-off

- Recorded by: [NAME]
- Date recorded: [DATE]
- Notes: [NOTES]

---

## Instructions

1. Obtain the vendor's written permission through their sales/support channel.
   Never paste API keys, account numbers, or credentials here — permission
   text only.
2. Replace every `[BRACKETED]` placeholder above.
3. Change `status: PENDING` to `status: CONFIRMED` ONLY when all three scope
   items are covered in writing.
4. Re-run: `python3 verify_v1_v10.py --data-dir raw --stats auto`
   (check V8 then reads this file; leftover placeholders keep it
   PENDING_MANUAL even if `status: CONFIRMED` was set).
