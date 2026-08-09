# Iva Current Ahead Branches Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate every user-approved local branch that was ahead of `origin/main` on 2026-08-09, repair integration defects, publish through protected `main`, and verify the deployed runtime.

**Architecture:** Work only in a fresh integration worktree based on the fetched `origin/main`. Merge the older userbot/contact stack in dependency order, then merge the four independently verified product packages, preserving current safety contracts when resolving overlap. Review and verify the combined result before publishing it through a PR and the repository deployment path.

**Tech Stack:** Git worktrees and merge commits, TypeScript ESM, Node.js test runner, Python userbot sidecar tests, Podman/Docker production image, GitHub protected branch workflows.

## Global Constraints

- Integrate exactly the 14 named local branches; exclude unrelated remote-only refs.
- Preserve a strictly read-only personal Telegram userbot and owner-private bot delivery.
- Gmail can create drafts only; Calendar, Tasks, Docs, Sheets, and Drive creation follows the approved tools.
- Preserve per-user isolation and keep credentials, vaults, sessions, attachments, and runtime data outside Git.
- Never use an `ours` merge to hide unresolved behavior; a zero-content merge requires patch-equivalence or supersession evidence.
- Do not publish until full combined-state review and fresh verification succeed.
- Protected `main` is updated only through a PR with required checks; production success requires deployed SHA and runtime health evidence.

---

### Task 1: Establish immutable integration baseline

**Files:**
- Create: `docs/superpowers/plans/2026-08-09-integrate-current-ahead-branches.md`
- Inspect: `package.json`, `.github/workflows/*`, `deploy/container/*`

**Interfaces:**
- Consumes: fetched `origin/main` at `54aea1cc003a4a2337d86c1aa8780e206f05f847` and the 14 recorded branch SHAs.
- Produces: clean worktree `strongf/integrate-current-ahead-branches`, dependency evidence, and reproducible baseline results.

- [ ] **Step 1: Verify worktree provenance and cleanliness**

Run: `git status --short --branch && git rev-parse HEAD origin/main && git diff --check`

Expected: clean integration branch; `HEAD` equals the fetched `origin/main`; no whitespace errors.

- [ ] **Step 2: Install the exact locked dependencies**

Run: `npm ci`

Expected: exit 0 without modifying tracked lockfiles.

- [ ] **Step 3: Run the baseline verification**

Run: `npm run typecheck && npm run lint && npm test`

Expected: exit 0, or a precisely reproducible upstream baseline failure recorded before any merge.

- [ ] **Step 4: Record branch ancestry and patch-equivalence evidence**

Run for every scoped branch: `git rev-list --left-right --count origin/main...<branch>`, `git cherry origin/main <branch>`, and `git diff --stat origin/main...<branch>`.

Expected: an auditable decision for real merge, already-contained branch, or proven supersession.

### Task 2: Integrate the existing userbot and contact stack

**Files:**
- Merge and resolve: `services/telegram-userbot/*`, `deploy/container/*`, `scripts/production/*`, `scripts/contact-analysis/*`, `agent/skills/telegram-*`, related docs and tests.

**Interfaces:**
- Consumes: Task 1 baseline and existing owner-only/read-only gateway contracts.
- Produces: one combined userbot/contact implementation that retains onboarding, proxy, health, analysis export, locking, local-day history, and chief-of-staff behavior.

- [ ] **Step 1: Merge the phone onboarding and follow-up fixes**

Merge in semantic order: `strongf/feat-userbot-phone-login`, `strongf/fix-userbot-qr-auth`, `strongf/fix-userbot-qr-delivery`, `strongf/fix-userbot-health-no-proxy`, `strongf/fix-userbot-vpn-proxy`, `strongf/container-userbot-readonly`.

Expected: every merge is explicit; conflicts preserve private owner authentication, read-only registry, proxy behavior, and deploy rollback correctness.

- [ ] **Step 2: Merge contact analysis and routing work**

Merge in semantic order: `strongf/fix-contact-analysis-sidecar-url`, `strongf/fix-contact-analysis-lock`, `strongf/fix-telegram-chat-history-timezone`, `strongf/feat-chief-of-staff`.

Expected: bounded single-call analysis, writable lock state, full local-day queries, and source-backed briefings coexist without duplicated or reverted code.

- [ ] **Step 3: Run focused verification for the combined stack**

Run the matching `services/telegram-userbot/test_*.py`, contact-analysis tests, Telegram skill/routing tests, production release-contract tests, typecheck, and build.

Expected: all focused checks pass before product-package merges begin.

### Task 3: Integrate the four verified product packages

**Files:**
- Merge and resolve: `Containerfile`, `agent/tools/*`, `agent/schedules/*`, `agent/skills/*`, `scripts/lib/*`, `scripts/relationship-intelligence/*`, `scripts/unified-inbox/*`, `scripts/proactive/*`, docs and coverage inventory.

**Interfaces:**
- Consumes: Task 2 combined userbot/contact stack.
- Produces: container scheduler and Google runtime, relationship registry, unified read-only inbox, and proactive exact-time owner reviews in one coherent runtime.

- [ ] **Step 1: Merge `strongf/container-foundation`**

Expected: pinned `gws`, per-user OAuth HOME, durable scheduler, and container Maintenance survive all deploy/userbot overlap.

- [ ] **Step 2: Merge `strongf/relationship-intelligence`**

Expected: evidence-linked commitments and CRM, owner-confirmed Google Tasks, Gmail drafts, dossiers, and private reports reuse the final Google/userbot contracts.

- [ ] **Step 3: Merge `strongf/unified-inbox`**

Expected: Telegram/Gmail/Calendar collection stays read-only, cursors remain monotonic, evidence remains bounded, and state stays private.

- [ ] **Step 4: Merge `strongf/proactive-reviews`**

Expected: preparation precedes 08:00 Europe/Moscow delivery, weekly delivery is Monday 08:00, retries are idempotent, and owner action versions prevent replay.

- [ ] **Step 5: Reconcile shared schedule, coverage, docs, and tool contracts**

Run: `npm run typecheck`, focused Google/scheduler/relationship/inbox/proactive tests, and `npm run build`.

Expected: the combined API compiles and focused behavioral tests pass.

### Task 4: Review and repair the combined diff

**Files:**
- Modify only files implicated by reproducible combined-state findings.
- Test each fix in the nearest existing `*.test.ts` or Python sidecar test file.

**Interfaces:**
- Consumes: full `origin/main...HEAD` diff from Tasks 2-3.
- Produces: reviewed integration with no open Critical or Important findings.

- [ ] **Step 1: Request independent code review**

Provide the reviewer exact base/head SHAs, this plan, the 14-branch scope, and safety contracts. Require concrete file/line findings and reproduction paths.

- [ ] **Step 2: Reproduce every actionable finding**

Run the narrow failing test or construct a regression test. Reject only findings disproved by code and fresh evidence.

- [ ] **Step 3: Fix through red-green TDD**

For each confirmed defect: add a failing test, run it red, implement the smallest compatible fix, run it green, and rerun the affected focused suite.

- [ ] **Step 4: Repeat review**

Expected: independent reviewer reports GO with no unresolved Critical or Important issues.

### Task 5: Verify release candidate and README accuracy

**Files:**
- Audit: `README.md`, `README.ru.md`, README assets, `docs/*`.
- Modify only when the integrated product/setup/architecture requires it.

**Interfaces:**
- Consumes: reviewed final integration SHA.
- Produces: immutable release candidate with fresh local and container evidence.

- [ ] **Step 1: Run README audit mode**

Use `beautify-github-readme` in audit mode against the finished branch. Validate links/assets if changes are necessary.

- [ ] **Step 2: Run complete verification**

Run: `npm run build`, `npm run typecheck`, lint/format checks, all focused tests, full `npm test`, Python sidecar tests, `git diff --check`, and coverage policy checks.

Expected: all checks pass, with exact totals recorded from the final SHA.

- [ ] **Step 3: Build and smoke the production image**

Run repository-native production Compose validation, immutable image build, and smoke checks for Eve, Telegram bot, read-only userbot, `gws`, scheduler, and required container utilities.

Expected: final image passes every release gate without secrets in logs or tracked files.

### Task 6: Publish through protected main and verify production

**Files:**
- No unreviewed source changes; only review/CI fixes return to Tasks 4-5.

**Interfaces:**
- Consumes: verified release candidate commit.
- Produces: merged protected-main PR and production deployment matching `origin/main`.

- [ ] **Step 1: Commit and push the integration branch**

Use Conventional Commit titles and multiline English bodies describing changes, rationale, and verification. Push `strongf/integrate-current-ahead-branches` without rewriting history.

- [ ] **Step 2: Create and monitor the PR**

Create a professional PR with Summary, Changes, Motivation, Testing, and Notes. Wait for required `verify`; diagnose and fix failures instead of bypassing branch protection.

- [ ] **Step 3: Merge and verify Git state**

Expected: PR merged normally; local `main` and `origin/main` resolve to the same merge SHA with zero ahead/behind.

- [ ] **Step 4: Verify deployment and runtime**

Follow the repository deployment path. Confirm deployed immutable SHA/image equals `origin/main`; validate Docker/Eve/Telegram/userbot/scheduler health and zero restart loops.

- [ ] **Step 5: Disable the heartbeat after success**

Disable automation `iva` only after all publication and production evidence is recorded.
