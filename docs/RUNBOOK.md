# PropStein Runbook — decisions and operations

Decisions are recorded here with their rationale and, where applicable, their
executable procedure. "Recorded" is not "done": each section states its own
status.

## Production safety defaults

- **Fail closed.** Missing authentication, entitlement, provenance, or
  verification configuration disables the protected operation. Local bypasses
  must be explicit, narrowly scoped, and off by default. Never place fallback
  credentials in source.
- **A green build is not a freshness check.** Unit tests validate application
  behavior; scheduled workflows, deployment targeting, live endpoint auth, and
  feed freshness require their own recorded verification.

## Vercel project topology (merge gate active)

- `propstein` is the production project and publishes `viewer/` from repository
  root using the root `vercel.json`.
- `propstein-github` is currently an unintended duplicate Git integration. Its
  PR check is advisory and does **not** validate the production project.
- Do not merge a Vercel-affecting PR until the duplicate Git integration is
  disconnected/archived in Vercel and the `propstein` project has produced the
  required preview/check. Do not promote or copy deployments between these two
  projects; they have independent settings and rollback histories.
- After merge, production deployment must originate from `propstein` and be
  verified against the merged Git SHA before the change is called live.

---

## D1 — `.venv` history rewrite (status: PROCEDURE WRITTEN, awaiting merge + authorization)

**Problem.** `.venv/` (10,817 files) is tracked in `main`'s history (measured:
`git ls-tree -r 421dda9 --name-only | grep -c '^\.venv/'` → 10817; pack
`git count-objects -vH` → size-pack 98.96 MiB). It merged into shared history
with PR #2. Every additional merge raises the eventual rewrite cost.

**Sequencing decision — Option A: hotfix merge → rewrite → freeze.**

Chosen over "rewrite first → hotfix rebases" because:

1. The hotfix content is production-urgent and already audited; rebasing it
   only adds risk and a one-cycle delay.
2. The rewrite is a single atomic operation over ALL history — it captures
   the hotfix commits at zero extra cost (hotfix files are small).
3. The freeze window (merge → rewrite) is hours, not weeks, and is governed
   by the rule below.

**FREEZE RULE (binding):** between the hotfix merge and the completed rewrite
+ force-push, NO new PRs open and NO new branches are pushed. Any work started
in that window rebases afterwards at its author's cost.

### Prerequisites (hard gates — do not skip)

- [ ] Hotfix PR merged; `origin/main` contains it.
- [ ] **Secrets scan of full history is CLEAN** (if it is not, this operation
  becomes URGENT and additionally requires a GitHub Support ticket for
  server-side purge — see "Limits" below):
  ```bash
  # from a fresh full clone; requires gitleaks or trufflehog, or use the
  # grep fallback below for the known patterns
  git clone https://github.com/NickAiNYC/propstein.git d1-scratch && cd d1-scratch
