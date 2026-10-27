# Testing

## Test Strategy

Node's built-in test runner provides domain, adapter, feed-health, rendering, migration, and execution-boundary coverage. `npm run check:production` is the release gate: syntax-check production browser files, run the full suite, and verify cache/security/deployment invariants. Python tests remain a required CI gap until dependencies are locked and installed there.

## Safety Net Map

| Module | Pinned behaviors | Test files | Gaps |
|---|---|---|---|
| `viewer/app.js` | Quote verification, stale-feed failure, entitlement, execution confirmation, immutable ledger shape, sport rendering | `test/*.test.mjs`, `test/*.snapshot.mjs` | Browser E2E and assistive-technology flows |
| `viewer/sw.js` | Market data excluded from cache; release version matches HTML | `test/commercial-readiness.test.mjs` | Real offline-browser integration |
| `vercel.json` | Security headers and no-store data policy | `test/commercial-readiness.test.mjs` | Headers must also be probed after deployment |
| `api/main.py` | Fail-closed entitlement markers, CORS allowlist, header-only admin secret | `test/commercial-readiness.test.mjs` | FastAPI integration tests need Python dependencies |

## Characterization Backlog

- [ ] Add Playwright keyboard, touch, offline, and stale-to-fresh transition tests (high risk, P1).
- [ ] Add FastAPI tests for auth unavailable/invalid/active, readiness, CORS, and admin endpoints (high risk, P0).
- [ ] Exercise settlement concurrency against the selected durable datastore (high risk, P0).

## CI Gates

- `npm ci`
- `npm run check:production`
- Vercel preview build
- Post-deploy header and feed-cache probe (to add)
- Python compile and test suite (to add after lockfile/tooling decision)
