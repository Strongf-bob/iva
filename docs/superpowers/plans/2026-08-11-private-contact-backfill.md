# Private Contact Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and operate a complete, resumable, read-only rebuild of human contact cards from every message in Telegram private human dialogs.

**Architecture:** A dedicated coordinator inventories private dialogs, captures a fixed high-water ID, and consumes the existing oldest-first messages API in bounded chunks. Separate account-scoped state, a verified backup manifest, the existing serialized reducer, and the shared pipeline lock make the workflow resumable and rollback-safe without changing scheduled sync semantics.

**Tech Stack:** TypeScript ESM, Node test runner, Zod, existing Telegram userbot HTTP export, Eve structured analysis, Markdown vault, atomic JSON/card stores.

## Global Constraints

- Telegram access remains GET-only and requires `TELEGRAM_EXPOSED_TOOLS=read-only`.
- Process only `kind=private`; never process bots, groups, or channels in this workflow.
- Never infer meetings or create active tasks from background history.
- Advance a chat cursor only after reducer and question-workbook writes are durable.
- Preserve manual Markdown, owner facts, meetings, tasks, canonical numeric identities, and per-user isolation.
- Backup before live writes; retain the backup after success.
- Any authored `agent/` change requires `npm run build` before runtime verification.

---

### Task 1: Repair the lock regression gate

**Files:**
- Modify: `scripts/review-fixes.test.ts`

**Interfaces:**
- Consumes: `acquireLock(file, timeoutMs): () => void` from `agent/lib/card-store.ts`.
- Produces: a regression test compatible with process-owned stale-lock semantics.

- [x] **Step 1: Reproduce the baseline failure**

Run: `npm test` outside the restricted sandbox.
Expected before correction: exactly the legacy late-release card-lock scenario fails while the live-owner test passes.

- [x] **Step 2: Correct the contradictory test fixture**

Remove the live lock file to represent an already completed external eviction, acquire a successor token, call the old release closure, and assert the successor lock remains.

- [x] **Step 3: Verify the lock contract**

Run: `node --test scripts/review-fixes.test.ts agent/lib/contact-memory-transaction.test.ts && npm run typecheck`
Expected: 10 tests pass and typecheck exits 0.

### Task 2: Add typed durable backfill state and backup manifest

**Files:**
- Create: `scripts/contact-analysis/backfill-state.ts`
- Create: `scripts/contact-analysis/backfill-state.test.ts`

**Interfaces:**
- Produces: `BackfillStateSchema`, `BackfillManifestSchema`, `backfillPaths(root, dataDir, accountId)`, `loadBackfillState`, `saveBackfillState`, `createBackfillBackup`, `verifyBackfillBackup`, and `restoreBackfillBackup`.

- [ ] **Step 1: Write failing schema and lifecycle tests**

Cover a new run, account isolation, private file modes, invalid-state quarantine, backup-before-write, SHA-256 verification, missing-file snapshots, symlink rejection, and restoration after an injected mutation.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `node --test scripts/contact-analysis/backfill-state.test.ts`
Expected: module-not-found failure for `backfill-state.ts`.

- [ ] **Step 3: Implement minimal state and backup storage**

Use strict Zod schemas, `saveJsonAtomic`, relative vault paths only, `lstat`/`realpath` containment, mode `0700` for directories and `0600` for files. The per-chat record is `{chatId,title,highWaterId,committedThrough,contextSummary,processedMessages,status,lastErrorCode}`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test scripts/contact-analysis/backfill-state.test.ts`
Expected: all state and backup tests pass.

### Task 3: Build the oldest-first private backfill coordinator

**Files:**
- Create: `scripts/contact-analysis/backfill.ts`
- Create: `scripts/contact-analysis/backfill.test.ts`
- Modify: `scripts/contact-analysis/analyzer.ts`

**Interfaces:**
- Consumes: `TelegramAnalysisClient.messages`, `messageWindow`, `analyzePage`, `reduceBatch`, `updateQuestionWorkbook`, and Task 2 state functions.
- Produces: `runPrivateContactBackfill(options): Promise<PrivateBackfillReport>` and `boundedMessageChunks(messages,maxChars)`.

- [ ] **Step 1: Write failing traversal tests**

Use fake dialogs containing private, bot, group, and channel entries. Assert only private IDs are analyzed; pages `[1..200]`, `[201..400]`, and `[401]` are reduced in chronological order; every message appears once; and the captured high-water mark excludes later arrivals.

- [ ] **Step 2: Write failing recovery tests**

Inject failure before and after reduction. Assert the cursor remains before an uncommitted page, replay is idempotent, completed chats are skipped on resume, and another account cannot reuse state.

- [ ] **Step 3: Run focused tests and observe RED**

Run: `node --test scripts/contact-analysis/backfill.test.ts`
Expected: module-not-found or missing-export failures.

- [ ] **Step 4: Implement bounded chronological chunks**

Reuse the existing character budget and keep whole messages. Reject a non-advancing API cursor, an out-of-order page, a message past high-water after slicing, or a client without the `messages` capability. Track oversized single-message chunks explicitly without dropping their evidence identity.

- [ ] **Step 5: Implement the resumable coordinator**

Inventory all dialog pages, filter `kind=private`, capture high-water with `messageWindow(chatId,0,1)`, create and verify the backup, then process each chat sequentially while allowing up to three chats concurrently. Serialize reducers exactly as ordinary sync does and persist state after each committed chunk.

- [ ] **Step 6: Verify GREEN and shared behavior**

Run: `node --test scripts/contact-analysis/backfill.test.ts scripts/contact-analysis/coordinator.test.ts scripts/contact-analysis/analyzer.test.ts`
Expected: all tests pass with zero skipped backfill messages.

### Task 4: Expose dry-run, run, status, and rollback commands

**Files:**
- Modify: `scripts/contact-analysis.ts`
- Modify: `scripts/contact-analysis-cli.test.ts`
- Modify: `agent/skills/telegram-userbot/SKILL.md`

**Interfaces:**
- Consumes: `runPrivateContactBackfill` and Task 2 state/restore functions.
- Produces CLI modes `rebuild-private --dry-run`, `rebuild-private`, `rebuild-status --json`, and `rebuild-rollback`.

- [ ] **Step 1: Write failing CLI tests**

Assert read-only gating, shared lock location, dry-run with no model/vault writes, explicit backup directory, bounded secret-free reports, resume behavior, refusal to start over an active run, and hash-verified rollback.

- [ ] **Step 2: Run CLI tests and observe RED**

Run: `node --test scripts/contact-analysis-cli.test.ts`
Expected: usage failures for the new modes.

- [ ] **Step 3: Implement CLI routing and human-safe skill instructions**

Keep existing `sync` and `status` output backward compatible. The Telegram skill documents the one-time sequence: dry-run, backup-backed apply, status, then ordinary sync.

- [ ] **Step 4: Verify GREEN**

Run: `node --test scripts/contact-analysis-cli.test.ts scripts/telegram-userbot-skill.test.ts`
Expected: all tests pass.

### Task 5: Verify the complete local change and review it

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: release-ready diff with fresh evidence.

- [ ] **Step 1: Run focused tests and coverage policy**

Run all contact-analysis, contact-memory, CLI, userbot export, and coverage-policy tests.
Expected: zero failures.

- [ ] **Step 2: Run static and build gates**

Run: `npm run typecheck`, focused ESLint, Prettier check, and `npm run build`.
Expected: every command exits 0.

- [ ] **Step 3: Run the full suite outside restricted sandbox**

Run: `npm test`.
Expected: all non-skipped tests pass.

- [ ] **Step 4: Apply `requesting-code-review` and resolve every material finding**

Review identity, pagination, crash boundaries, backup containment, manual-data preservation, output leakage, and backward compatibility. Re-run affected gates after each fix.

- [ ] **Step 5: Commit the implementation**

Create Conventional Commits with descriptive bodies and included verification evidence.

### Task 6: Publish, deploy, and execute the live migration

**Files:**
- Audit: `README.md` through `beautify-github-readme` audit mode; edit only if documented behavior changed.
- No tracked live data files.

**Interfaces:**
- Consumes: verified commits and repository production workflow.
- Produces: merged protected-main SHA, matching healthy deployment, retained backup, and completed live report.

- [ ] **Step 1: Push the feature branch and open a PR**

Use the configured `Strongf-bob/iva` repository, base `main`, and wait for required `verify`.

- [ ] **Step 2: Merge and verify publication**

Confirm the merge commit on `origin/main`; do not equate PR status with deployment.

- [ ] **Step 3: Verify immutable deployment**

Confirm deployment SHA equals `origin/main` and Telegram, userbot, poller, owner worker, and runtime health are green with zero unexpected restarts.

- [ ] **Step 4: Run live dry-run and preserve evidence**

Record private-chat count, existing card count, expected backup path, and zero mutations.

- [ ] **Step 5: Run backup-backed live backfill and monitor to terminal state**

Resume transient failures from checkpoints. Do not restart Telegram login. Stop on invalid backup, authorization loss, non-advancing cursor, or persistent model/schema failure.

- [ ] **Step 6: Validate live cards and incremental handoff**

Require zero failed chats and skipped messages, unique Telegram person IDs, valid card metadata, preserved manual sections/meetings/tasks, reconciled links, and a subsequent ordinary sync that processes only post-high-water messages.

- [ ] **Step 7: Complete the persistent goal**

Re-read the completion contract and full task thread, run fresh evidence checks, report token/time usage, and mark the goal complete only if no required work remains.
