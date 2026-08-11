# Human-First Contact Memory Implementation Plan

> **Execution:** Follow `executing-plans` task by task. Use `test-driven-development` for each behavior change and `verification-before-completion` before reporting success.

**Goal:** Replace machine-first Telegram graph cards with readable person/group/channel memory, add explicit meeting capture and person-linked obligations, and keep normal Iva replies free of internal metadata.

**Architecture:** Keep Telegram numeric IDs and the per-user vault as identity and isolation boundaries. Add a shared deterministic contact-memory module that parses legacy reducer state, renders human-first Markdown, calculates age, and atomically coordinates person cards with a Markdown task registry. Interpretation remains in skills and model calls; schemas and reducers own validation, idempotency, conflicts, dates, and storage.

**Tech stack:** TypeScript ESM, Zod 4, Node test runner, existing Eve tool/schedule discovery, Markdown vault storage.

---

### Task 1: Define the typed contact-memory domain

- [x] Add failing tests in `agent/lib/contact-memory.test.ts` for full and partial birthdays, age around the birthday boundary, safe internal-record serialization, stable record IDs, and allowed profile fields.
- [x] Add `agent/lib/contact-memory.ts` with Zod schemas for profile facts, explicit meetings, person-linked tasks, corrections, and deletion requests.
- [x] Implement deterministic date parsing, age calculation in a supplied IANA timezone, stable hashing, and HTML-comment-safe JSON metadata.
- [x] Run `node --test agent/lib/contact-memory.test.ts` and confirm green.

### Task 2: Render and migrate human-first cards

- [x] Replace reducer expectations in `scripts/contact-analysis/reducer.test.ts` with readable person/group/channel sections, compact adjacent metadata, preserved manual prose, idempotency, supersession archive, and legacy Base64 migration cases.
- [x] Extend `scripts/contact-analysis/types.test.ts` for the approved profile predicates and forbidden sensitive predicates.
- [x] Extend `scripts/contact-analysis/types.ts` with bounded predicates for birthday, city, timezone, phone, email, education, employer, interest, important date, gift idea, and interesting fact.
- [x] Refactor `scripts/contact-analysis/reducer.ts` to parse both legacy and current managed state, render canonical Russian sections, omit empty sections, retain stable links, and write current metadata without Base64.
- [x] Keep meetings out of background analysis and preserve unsupported/manual content.
- [x] Run `node --test scripts/contact-analysis/types.test.ts scripts/contact-analysis/reducer.test.ts` and confirm green.

### Task 3: Add the person-linked task registry

- [x] Add failing tests in `agent/lib/people-task-store.test.ts` for open/done/cancelled transitions, due-date sections, reciprocal person links, deduplication, ambiguous completion, and preservation of manual prose.
- [x] Add `agent/lib/people-task-store.ts` as the sole writer/parser for `vault/tasks/people.md`, using stable hidden task markers, locks, and atomic writes.
- [x] Generate `Открытые дела` in person cards from active registry records without duplicating task status.
- [x] Implement deterministic reconciliation that completes only a single exact open match and otherwise returns a clarification result.
- [x] Run `node --test agent/lib/people-task-store.test.ts` and confirm green.

### Task 4: Add the contact-memory tool and explicit meeting flow

- [x] Add failing tool tests in `scripts/contact-memory-tool.test.ts` for existing-card identity resolution, explicit meeting append, durable fact merge, task creation, clean result payloads, idempotent replay, correction, and scoped deletion.
- [x] Add `agent/tools/contact_memory.ts` with actions `get`, `update_profile`, `record_meeting`, `complete_task`, `cancel_task`, and `delete_record`.
- [x] Require explicit `ownerReported: true` for meetings, use canonical numeric identity before writes, and make multi-file updates recoverable under a transaction lock.
- [x] Return only natural-language change summaries and sanitized profile content; never return raw comments, YAML, Telegram coordinates, confidence enums, or internal IDs.
- [x] Run `node --test scripts/contact-memory-tool.test.ts` and confirm green.

### Task 5: Teach extraction, retrieval, and nightly reconciliation

- [x] Add/adjust analyzer tests for the expanded predicate set and birthday safeguards.
- [x] Update `agent/skills/telegram-person-profile/SKILL.md`, `telegram-group-profile/SKILL.md`, and `telegram-channel-profile/SKILL.md` to extract only supported durable fields and preserve the meeting boundary.
- [x] Update `agent/instructions/10-map.md` to route person lookup and meeting reports through `contact_memory`, calculate age through the deterministic tool result, and enforce the clean-output contract.
- [x] Update the daily rollup instructions/prompt so person-linked commitments and explicit completion statements are reconciled through `contact_memory`, with ambiguity left open.
- [x] Add a clean-output regression test that rejects internal markers, IDs, YAML, and confidence enums in normal tool results and instruction examples.
- [x] Run the focused analyzer, instruction, and rollup tests.

### Task 6: Migration and failure-safe maintenance

- [x] Add `scripts/contact-memory/migrate.ts` and tests for dry-run inventory, legacy card conversion, idempotent rerun, recoverable backup outside tracked paths, and fail-closed malformed metadata.
- [x] Add `scripts/contact-memory/reconcile.ts` and tests to repair task sections/links and deduplicate stable records without inventing facts.
- [x] Wire reconciliation into the existing daily memory path after successful rollup processing, preserving per-user vault/data isolation and old-install compatibility.
- [x] Document operator-facing migration and rollback in the design spec implementation notes without exposing internals in normal assistant replies.
- [x] Run focused migration/reconciliation tests.

### Task 7: Fresh verification and review

- [x] Run Prettier on changed files and `npm run format:check`.
- [x] Run all focused contact-memory/contact-analysis tests.
- [x] Run `npm run typecheck` and focused ESLint on every changed TypeScript file.
- [x] Run `npm test` and `npm run test:coverage`.
- [x] Run `npm run build` because authored files under `agent/` changed.
- [x] Inspect generated sample person, group, channel, and task Markdown manually for readability and metadata leakage.
- [x] Apply `requesting-code-review`, fix substantiated findings, and rerun affected checks.
- [x] Commit locally with a Conventional Commit message and a verification body; do not push or deploy without separate authorization.
