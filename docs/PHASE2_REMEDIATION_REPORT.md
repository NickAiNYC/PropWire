# Phase 2 Remediation Report — v2 (post-audit)

**STATUS: LOCAL-ONLY. NOT PUSHED. CI HAS NOT RUN.** (audit M11 — this header
is the report's first sentence on purpose.) The sandbox has no GitHub
credentials: the Phase 1 PAT was revoked as the security directive required,
and the push command fails with `could not read Username` — the honest
failure, reported as such. Transfer artifacts exist: a git bundle and a
16-patch series (see §8). Every "green" number below is a **local claim**;
CI must re-run it against the pushed SHA before merge.

## 0. Audit disposition (item-by-item)

| Item | Disposition | Commit / evidence |
|---|---|---|
| **B1** fixture real names | FIXED — all 24 fixture players are `Player A`…`Player X` (stable ids `fx-nba-player-a…x`, deterministic slate-order mapping); teams/positions/stats/odds/tie-pairs unchanged; probe row keeps its descriptive name; policy documented in MULTISPORT.md §2; `fetch_nba.py` selftest mock renamed to "Test Player" | `5a5b09e` |
| **B2** parity by omission | FIXED both ways. (a) Sandbox implements `getElementById` against the shipped page's ids (static inventory + innerHTML-injected ids), harness mirrors `init()`; chrome content IS captured in the render goldens — enumerated delta: exactly 10 gained registry entries per render golden, pure additions, zero changes to existing entries. (b) `dom_access_log.json` golden pins every `getElementById` call/resolution for the NFL flow; allowlist assertion fails on any non-chrome element. Parity set: 8 → 10 goldens. | `1d0fcb0`, `a600193` |
| **B3** 375px overflow | FIXED, not deferred. Empirical element-level measurement with ancestor-clip detection: the chip strip is an internal scroller (never the leak); the leak was `.pw-topbar-right` (`flex-shrink:0 !important`, all-nowrap children) whose right edge equalled scrollWidth 463 exactly. Cluster now shrinks; injury pill degrades to dot+ellipsis. Re-measured: NFL + NBA fit at 375px and 390px (`scrollWidth == clientWidth`). Root cause + fix recorded in MULTISPORT.md §6. | `6b47691` |
| **B4** modal parallel path | FIXED — all detail copy (market label, model spec, distribution, sample note, scope note, venue environment incl. dome/wind + dome flag) moved verbatim into `nfl.js detail{}`; `app.js` calls `adapter.detail.*` unconditionally with sport-neutral placeholders only. Proof: `test/snapshots/nfl/detail_modal.json` captured from the PRE-refactor code (`1d0fcb0`) reproduces byte-identically after the re-hook. The Phase 1 adapter claim now holds for the modal. | `1d0fcb0`, `c7e2fa2` |
| **H5** receipt-verified tie-break | REPLACED — new chain: EV/unit desc → edge desc → model confidence (narrower adapter interval) → sample size (`games_prior` desc, neutral when absent) → name. `verified` still gates actionable classification and renders in the book cell; it can no longer rank plays (test proves a verified receipt cannot reorder a tie). MULTISPORT.md §5 documents why. | `4c0a55f` |
| **H6** edgeGate fix location | DECIDED: Phase 1 is already merged (verified: `main` = `1ea8990`, the PR #1 merge commit; `refs/pull/1/head` = `5cc0196`), so a backport branch would dangle. The fix (commit `83714bd`) rides the Phase 2 PR; `main` carries the live crash only until this PR merges. Recorded in MULTISPORT.md §7; stated in the PR body. Merge this PR promptly. | documented |
| **H7** branch stack | DOCUMENTED — actual verified topology in MULTISPORT.md §7: `main 1ea8990` (true merge of `bdc229f`+`5cc0196`; `git diff main 5cc0196` is empty) ← `phase/2-nba` (16 commits). No rebase needed; merge is clean. Stale remote branch `propwire-ui-redesign` (Oct 20, −243k lines) flagged for deletion. | documented |
| **H8** NBA distribution choice | DOCUMENTED — MULTISPORT.md §2 "Markets and the distribution choice": normal-approx is inherited v1 scaffolding; 3PM (low-mean discrete, right-skewed) and PRA (correlated sum) require discrete/correlated treatment in the Phase 4 calibration pass. | documented |
| **H9** uncalibrated badge | CONFIRMED NOW RENDERS — `sportCalibrationBadge()` sources the breaker config's `sports[id].calibrated` (adapter fallback); every rendered NBA row (table + cards) shows an `UNCALIBRATED` pill; NFL renders no element. Badge insertion is byte-neutral for calibrated sports (parity goldens pass with zero snapshot updates). | `8e8513b` |
| **H10** +28 tests enumerated | DONE — see §2. Original Phase 2: 28 added across 6 new files, 0 modified. Remediation: 2 added, 4 modified (enumerated by name). | §2 |
| **H11** CI not run / local-only | STATED in this header; CI evidence for Phase 1 exists (run 40063252959 branch, run 40063281580 post-merge, both success). Phase 2 CI runs only after push. | this report |
| **M11** header | This header. | — |
| **M12** parity claim completed | Stated precisely in MULTISPORT.md §1 blockquote: NFL JS data path byte-identical across 10 goldens; NFL UX adds switcher/chrome/banner by design, captured as an earned whitelist and pinned by the access-log allowlist. | `a600193` |
| **M13** cross-midnight PT | ADDED — explicit `etDateKey` vectors: 10:30pm PST (Jan) and PDT (Jul) tips → next-day ET slate key. | `6b47691` |
| **M14** MULTISPORT coverage | Verified all five: add-a-third-sport checklist (§8), adapter contract (§1), fixture provenance policy incl. naming (§2), distribution rationale (§2), 375px decision (§6). Plus new §7 branch topology. | `ab86b70` |
| **M15** FIXTURE banner copy | FIXED — banner now reads "Sample data for demonstration — not actionable, not a research record. Synthetic values; not sportsbook quotes." One line, always visible. Test asserts the full copy. | `8e8513b` |
| **M16** NFL feed stale in production | ACKNOWLEDGED as a product reality: with the frozen clock the NFL page shows `ODDS STALE` + `NEWS FEED STALE` — that is the honest state of the live NFL feeds (odds 8.5h old vs 6h limit at capture). This is the feed-health system working, not a Phase 2 defect. Either the feed pipeline refreshes before release, or the STALE banner is the truthful greeting. The banner content is now pinned in the parity goldens, so it cannot silently regress. | goldens + this section |

## 1. Verified state (machine-checkable)

- Branch `phase/2-nba`, tip `2cd9f7f`, 16 commits over `propwire/main`
  (`1ea8990`), 81 files changed, +4,381/−258.
- Local suite: **83/83 pass** (`npm test` = `node --test`), including the
  10-snapshot NFL parity harness, after every commit in this series.
- `node --check` clean on every touched JS file; `py_compile` + `--selftest`
  clean on `scripts/fetch_nba.py`; zero new dependencies (`package.json`
  untouched); root `app.js` rebranded (strings only) with the CI suite green
  — the CI-loaded root file is string-rebranded, not refactored.
- Remote verification performed this session: `propwire/main` = `1ea8990`;
  `phase/1-adapter` remote = `5cc0196`; `refs/pull/1/head` = `5cc0196`;
  CI success on both `phase/1-adapter@5cc0196` (run 40063252959) and
  `main@1ea8990` (run 40063281580); `phase/2-nba` absent from the remote.

## 2. Test enumeration (H10)

**Original Phase 2 (53 → 81), all ADDED, zero modified:**
`nba-integration.test.mjs` (6: adapter contract, market hooks, feed
schema/provenance, slate keying/DST, breaker block, copy compliance),
`sport-switcher.test.mjs` (5: defaultId resolution, model:null boot, NBA
boot integration, switchToSport no-ops, NFL boot unchanged),
`render-robustness.test.mjs` (2: anti-tout gate copy, fallback gate),
`top-plays.test.mjs` (5: EV order, tie-break, incomplete-input gate,
verified tie-break [since replaced], NFL picks-file verbatim),
`feed-health.test.mjs` (7), `fetch-nba-script.test.mjs` (3).

**Remediation round (81 → 83):**
- ADDED: `uncalibrated-badge.test.mjs` — "NBA rows render the UNCALIBRATED
  badge in table and card views"; "NFL rows render NO uncalibrated badge".
- MODIFIED (name, reason): `top-plays.test.mjs` — tie-break test replaced
  (confidence decides; H5) and verified tie-break test replaced (sample
  size/name; verified ignored; H5); `nba-integration.test.mjs` — slate
  keying test extended with cross-midnight PT vectors (M13);
  `feed-health.test.mjs` — fixture banner test asserts the full honest copy
  (M15); `nfl-parity.snapshot.mjs` — the parity test now mirrors `init()`,
  captures `detail_modal.json` + `dom_access_log.json`, and asserts the DOM
  allowlist (B2). B1 renaming touched data references inside
  `top-plays.test.mjs`/`sport-switcher.test.mjs` before the H5 rewrite
  (mechanical, semantics unchanged in that commit).

## 3. Evidence infrastructure status (v3 TASK 2/3 boundary)

`docs/EDGE_GATE.md` is committed (preregistered gates: N=600 per sport,
N=300 descriptive checkpoint, mean CLV ≥ +1.0pp, one-sided α=0.0125 per
attempt, game-clustered deterministic bootstrap seed 20261024, closing-source
independence, unevaluable reason codes, no cross-sport pooling, retirement on
second failure, required harness fixtures §10). The Phase 1.5 implementation
(immutable candidate ledger, independent closes, cluster bootstrap runner,
fail-closed authorization) does NOT exist yet and is the hard prerequisite
before NBA evaluation data collection and before the free beta. Provider
status unchanged: balldontlie gated fail-closed (exit 2/3 semantics),
fixtures flagged `_fixture:true`, `verified:false` everywhere.

## 4. What is developed vs deployed

Developed (this branch, unpushed): everything in §0–§3. Deployed: nothing
from this branch. Production (`main` @ `1ea8990` via Vercel) still shows the
pre-Phase-2 viewer with a stale NFL feed (M16). The `propwire-ui-redesign`
and `ui/header-style-refresh` work (root paper frontend, deploy-target flip)
is separate, unmerged, and intentionally untouched here.

## 5. Remaining blockers

1. **Push credentials** — a fresh PAT (revoked-then-rotated, never logged) or
   a user-run push from the bundle/patches (§8). No Phase 2 CI before that.
2. **Phase 1.5** — evidence infrastructure before NBA eval data or beta (v3
   dependency order).
3. **Binary brand assets** — `propwire-logo-full.png` (and icon PNGs) still
   carry the old wordmark pixels; pages now use the text-corrected SVG
   lockup. Regenerate PNGs from the SVG when a raster is next needed.
4. **M16 feed refresh** — decide: refresh the NFL feed pipeline or ship with
   the honest STALE banner.

## 6. Not verified (honest list)

Real-device touch/swipe behavior; real-device 375px rendering (emulator
only); balldontlie live fetch (needs a paid key); CI execution on this
branch; browser ledger writes at scale (unit + parity covered); UFC
vendor coverage (Phase 3 gate, untouched here).

## 7. Suggested PR body (paste on open)

Title: `Phase 2: NBA adapter (research fixtures) + Phase 2 audit remediation`

Body: 16 commits = 7 original Phase 2 + 9 audit-remediation commits (B1–B4,
H5, H9, M13/M15, docs, brand). Includes the `riskPolicy.edgeGate` crash fix
Phase 1 merged without (`83714bd`) — do not release `main` without merging
this. 83/83 local (CI must re-run); NFL parity 10/10 goldens byte-identical
with the earned chrome whitelist documented in `test/nfl-parity.snapshot.mjs`
and `docs/MULTISPORT.md` §1/§7. See `docs/PHASE2_REMEDIATION_REPORT.md` and
`docs/EDGE_GATE.md`.

## 8. Transfer artifacts (sandbox → GitHub)

- Bundle: `download/phase2/propwire-phase2-nba.bundle` —
  `git bundle verify … && git fetch phase2.bundle phase/2-nba:phase/2-nba`
  inside any clone of NickAiNYC/PropWire, then push.
- Patches: `download/phase2/patches/0001…0016-*.patch` —
  `git am` on a branch cut from `main @ 1ea8990`.
- Or: paste a fresh PAT in chat and the push + PR open happen from here.
