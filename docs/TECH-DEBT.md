# Technical Debt

## Debt Ledger

| Item | Location | Type | Risk | Effort | Priority | Status |
|---|---|---|---|---|---|---|
| Signed user session and subject-bound entitlement | `api/main.py` | security | Critical | Medium | P0 | Open |
| Durable transactional ledger | API/ledger | data integrity | Critical | Large | P0 | Open |
| Production error and feed-age monitoring | frontend/API | operability | High | Medium | P0 | Open |
| Python dependency lock and CI test job | `requirements.txt`, CI | reproducibility | High | Medium | P1 | Open |
| Browser E2E/accessibility regression suite | viewer | quality | Medium | Medium | P1 | Open |
| Duplicate root/public/viewer assets | repository | maintainability | Medium | Medium | P1 | Open |
| Monolithic browser application | `viewer/app.js` | maintainability | Medium | Large | P2 | Open |

## Smell Inventory

| Smell | Location | Refactoring | Status |
|---|---|---|---|
| Multiple divergent deployment copies | root, `public/`, `viewer/` | Establish Single Source of Truth | Ticketed |
| Large IIFE mixing state, rendering, and policy | `viewer/app.js` | Extract Module behind characterization tests | Ticketed |

## Sprout / Wrap Register

Commercial readiness assertions were added beside the legacy suite in `test/commercial-readiness.test.mjs`; fold them into a dedicated deployment integration layer when browser/API integration tests exist.

## Debt Budget & Broken-Windows Policy

Reserve at least 15% of each release for reliability/security debt. P0 trust, auth, stale-data, or ledger defects block release. Every TODO that affects a trust claim must have an owner and priority here.

## Adopted Conventions

- Production configuration fails closed.
- Live decision data is network-only; offline mode is research-shell only.
- Secrets travel in headers, never URLs.
- Browser origins are allowlisted explicitly.
- Production source files, not historical duplicates, are syntax-checked in CI.
