# Iva Chief-of-Staff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Application implementation remains in the main agent; fresh subagents are used only for the skill pressure scenarios and final review.

**Goal:** Add source-backed daily attention, relationship preparation, and weekly review workflows to Iva through three narrow skills and the `/brief` and `/weekly` Telegram commands.

**Architecture:** Keep `tasks`, `memory_search`, `read_file`, vault cards, and Telegram contact evidence as the only sources of truth. Add judgment as Markdown skills, and add only a thin command classifier to the existing bilingual command module; no new database, index, service, external package, or write-capable workflow is introduced.

**Tech Stack:** TypeScript ESM, Node 24 native test runner, Eve Markdown skills, existing Telegram channel, existing vault tools.

## Global Constraints

- All new Node.js source and tests are TypeScript; this feature does not add `.mjs` files.
- Skills contain no executable code and never send messages, create tasks, or mutate external services.
- Every material brief item cites a vault-relative path; Telegram evidence identifiers already in cards are preserved verbatim.
- Current compiled truth wins over `History`; inferred and ambiguous material is labelled.
- The live vault, `data/`, credentials, userbot session, and original dirty checkout are never touched.
- `agent/` changes require `npm run build` before runtime claims.
- Commands and output are bilingual where the existing command surface is bilingual.
- Use the bundled Node 24 runtime at `/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` for verification.
- Finish boundary is local: no push, PR, merge, deployment, or external credential setup.

---

### Task 1: Source-backed daily attention skill

**Goal:** Teach Iva to produce a bounded, evidence-backed daily attention brief from tasks and recent memory.

**Dependencies:** Existing `tasks`, `memory_search`, `read_file`, `glob`, MAP rules, and current date instruction.

**Touched files:**

- Create: `agent/skills/chief-of-staff-today.md`
- Create: `scripts/chief-of-staff-skills.test.ts`

**Accepted decisions:** Flat bundled skill; seven action bullets maximum; no mutations; an empty source produces an explicit unavailable/empty statement.

**DoD:** The skill is discoverable for daily focus/attention requests, gathers tasks and minimal recent memory, labels uncertainty, cites evidence, and handles empty tasks/vault without invention.

**Checks:** Focused Node test passes; baseline and skill-present pressure scenarios show the evidence and empty-state failures corrected.

- [ ] **Step 1: Run the RED pressure scenario without the skill**

Use a fresh inspection subagent with this exact scenario and record its response in the task log:

```text
You are evaluating Iva before a chief-of-staff skill exists. The user asks:
"Что сегодня требует моего внимания?" Open tasks contain one overdue high task.
Memory search returns one current EXTRACTED commitment with a vault path, one
INFERRED blocker, and one superseded decision. Produce the answer you would give.
Do not assume any unavailable skill instructions.
```

RED is established when the response omits source paths, treats inference as
fact, includes the superseded decision, or produces an unbounded generic plan.

- [ ] **Step 2: Write the failing contract test**

Create `scripts/chief-of-staff-skills.test.ts` with a helper that reads a named
skill, parses its frontmatter, and tests `chief-of-staff-today` for:

```ts
assert.equal(frontmatter.name, "chief-of-staff-today");
assert.match(frontmatter.description, /^Use when /u);
assert.match(body, /tasks/u);
assert.match(body, /memory_search/u);
assert.match(body, /read_file/u);
assert.match(body, /EXTRACTED/u);
assert.match(body, /INFERRED/u);
assert.match(body, /superseded/u);
assert.match(body, /vault-relative/u);
assert.match(body, /seven|7/u);
assert.match(body, /do not (?:create|modify|send)/iu);
```

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
node --test scripts/chief-of-staff-skills.test.ts
```

Expected: FAIL because `agent/skills/chief-of-staff-today.md` does not exist.

- [ ] **Step 4: Write the minimal skill**

Create `agent/skills/chief-of-staff-today.md` with:

```yaml
---
name: chief-of-staff-today
description: Use when the user asks what needs attention today, requests a chief-of-staff brief, daily focus, priorities, blockers, promises, or unresolved decisions.
---
```

The body must define this ordered recipe:

1. call `tasks` with `action="list"`;
2. use `glob` for the latest available daily summary and `memory_search` for
   current commitments, blockers, and unresolved decisions;
3. open no more than three memory hits with `read_file`;
4. exclude superseded/history truth, label `INFERRED` and ambiguity;
5. produce overdue/today, important context, and one focus section with at most
   seven action bullets;
6. append `[Источник: <vault-relative-path>]` to each memory-derived claim and
   preserve `telegram:message:*` evidence;
7. state empty/unavailable sources and never invent or perform a mutation.

- [ ] **Step 5: Verify GREEN and run the skill-present scenario**

Run the focused test again. Then run the same pressure scenario with the full
new skill body supplied to a fresh inspection subagent. GREEN requires source
paths, uncertainty labels, omission of superseded truth, and bounded output.

- [ ] **Step 6: Commit the daily skill**

```bash
git add agent/skills/chief-of-staff-today.md scripts/chief-of-staff-skills.test.ts
git commit -m "feat(skills): add source-backed daily attention brief" -m "Teach Iva to combine open tasks with current vault evidence while preserving confidence, provenance, and empty-state behavior. The workflow remains read-only and bounded so daily prioritization does not create tasks or external actions implicitly."
```

---

### Task 2: Relationship briefing skill

**Goal:** Prepare a concise, source-backed brief for a named person without silently merging ambiguous identities or contacting anyone.

**Dependencies:** Task 1 test helper, `memory_search`, `read_file`, wikilinks, and Telegram graph evidence.

**Touched files:**

- Create: `agent/skills/relationship-briefing.md`
- Modify: `scripts/chief-of-staff-skills.test.ts`

**Accepted decisions:** Contact card first; at most three linked supporting cards; ambiguity stops synthesis; maximum five talking points.

**DoD:** The skill resolves a person conservatively, surfaces relationship context, commitments, risks, and talking points with exact evidence, and never sends or edits anything.

**Checks:** Focused contract test and RED/GREEN pressure scenarios pass.

- [ ] **Step 1: Run the RED pressure scenario without the skill**

```text
The user says "подготовь меня к разговору с Сашей". Memory search returns two
active contact cards named Sasha, one project card linked to only the second,
and an INFERRED communication-style observation. Produce the response without
assuming a relationship-briefing skill.
```

RED is established if the response silently chooses one Sasha, claims the
inferred style as fact, reads an unbounded set, or omits source paths.

- [ ] **Step 2: Add the failing relationship contract**

Assert the future skill's `name`, trigger-only description, use of
`memory_search` and `read_file`, candidate handling for ambiguous identities,
three-card read bound, five talking-point bound, confidence handling, inline
source paths, Telegram evidence preservation, and no send/task/write behavior.

- [ ] **Step 3: Verify RED**

Run the focused test and expect missing-file failure for
`agent/skills/relationship-briefing.md`.

- [ ] **Step 4: Write the minimal relationship skill**

Use frontmatter:

```yaml
---
name: relationship-briefing
description: Use when the user wants to prepare for a meeting, call, negotiation, reply, or conversation with a named person, or asks what matters about that relationship.
---
```

The body must specify conservative identity resolution, contact-card-first
retrieval, at most three linked supporting reads, current-vs-history and
confidence rules, the five output sections from the design, inline sources, and
a hard no-side-effect boundary.

- [ ] **Step 5: Verify GREEN and re-run the scenario**

The fresh skill-present response must list both Sasha candidates and stop before
inventing a merged briefing.

- [ ] **Step 6: Commit the relationship skill**

```bash
git add agent/skills/relationship-briefing.md scripts/chief-of-staff-skills.test.ts
git commit -m "feat(skills): add evidence-bound relationship briefing" -m "Prepare conversations from the canonical contact graph and linked vault context while preserving identity ambiguity, confidence, and Telegram evidence. The skill is deliberately read-only and cannot send messages or create follow-up tasks."
```

---

### Task 3: Weekly review skill

**Goal:** Turn the most recent week of summaries, tasks, decisions, and commitments into a forward-looking review.

**Dependencies:** Task 1 test helper, daily summaries, task list, decision/contact/project cards.

**Touched files:**

- Create: `agent/skills/weekly-review.md`
- Modify: `scripts/chief-of-staff-skills.test.ts`

**Accepted decisions:** Most recent seven available daily summaries; 1–2 means light review; zero means honest empty result; priority order is conflicts, overdue items, open commitments, then themes.

**DoD:** Weekly review exposes themes, decision arcs, commitments, and three next-week priorities with sources and no fabricated coverage.

**Checks:** Focused contract test and RED/GREEN pressure scenarios pass.

- [ ] **Step 1: Run the RED pressure scenario without the skill**

```text
The user asks for a weekly review. Only two daily summaries exist. They contain
one conflicting decision with two dated sources and one overdue commitment.
Tasks also contain unrelated low-priority items. Produce the response without
assuming a weekly-review skill.
```

RED is established if the response pretends the week is complete, hides the
conflict, prioritizes unrelated low tasks, or omits evidence.

- [ ] **Step 2: Add the failing weekly contract**

Assert frontmatter and requirements for seven available summaries, light/empty
week handling, tasks, `memory_search`, decision classifications, priority order,
three next-week items, inline sources, uncertainty, and no side effects.

- [ ] **Step 3: Verify RED**

Run the focused test and expect missing-file failure for
`agent/skills/weekly-review.md`.

- [ ] **Step 4: Write the minimal weekly skill**

Use frontmatter:

```yaml
---
name: weekly-review
description: Use when the user asks for a weekly review, week recap, recurring themes, decision changes, stale commitments, blockers, or priorities for next week.
---
```

The body must implement the accepted source window, decision states `STABLE`,
`NEW`, `CONFLICTING`, `CHANGED`, priority order, evidence format, and light/empty
week behavior.

- [ ] **Step 5: Verify GREEN and re-run the scenario**

The response must say it is a light review, show the conflicting decision before
the overdue commitment, cite both, and ignore unrelated low-priority noise.

- [ ] **Step 6: Commit the weekly skill**

```bash
git add agent/skills/weekly-review.md scripts/chief-of-staff-skills.test.ts
git commit -m "feat(skills): add forward-looking weekly review" -m "Synthesize recent summaries, decision changes, and commitments into a bounded review that prioritizes conflicts and overdue work. Sparse and empty weeks are reported honestly and every material finding remains traceable to the vault."
```

---

### Task 4: Telegram command routing

**Goal:** Expose the skills through `/brief`, `/brief <person>`, and `/weekly` while preserving the existing command and security flow.

**Dependencies:** Tasks 1–3.

**Touched files:**

- Modify: `agent/lib/i18n.ts`
- Modify: `agent/lib/i18n.test.ts`
- Modify: `agent/channels/telegram.ts`
- Modify: `scripts/chief-of-staff-skills.test.ts`

**Accepted decisions:** Command parsing stays pure in `i18n.ts`; `/brief` argument is preserved after command token removal; Telegram uses the pure result to build one narrow model context.

**DoD:** Help and Telegram command menus list both commands; command classifier selects exact skill and preserves Unicode person text; channel uses the classifier without bypassing existing auth/transcript behavior.

**Checks:** i18n tests, skill/route contract tests, typecheck.

- [ ] **Step 1: Write failing command tests**

Extend the command expectation with `brief` and `weekly`. Add tests for a new
pure export with this interface:

```ts
export type ChiefOfStaffCommand =
  | { skill: "chief-of-staff-today"; subject: null }
  | { skill: "relationship-briefing"; subject: string }
  | { skill: "weekly-review"; subject: null };

export function chiefOfStaffCommand(text: string): ChiefOfStaffCommand | null;
```

Required cases: `/brief`, `/brief@iva_bot`, `/brief  Александра Петрова `,
`/weekly`, `/weekly unexpected`, ordinary text, and `/briefing`.

- [ ] **Step 2: Verify RED**

```bash
node --test agent/lib/i18n.test.ts scripts/chief-of-staff-skills.test.ts
```

Expected: missing export and command catalog mismatch.

- [ ] **Step 3: Implement the pure classifier and command metadata**

Add `brief` with `<person>`/`<человек>` optional help hint and `weekly` to
`COMMANDS`. Parse only exact command tokens, strip an optional bot suffix, trim
the remaining subject, reject arguments to `/weekly`, and return the union above.

- [ ] **Step 4: Route in Telegram**

Import `chiefOfStaffCommand` in `agent/channels/telegram.ts`. Inside the existing
slash-command block, append the command to daily history, start typing, and return
one translated context:

```text
Load the chief-of-staff-today skill and assemble today's attention brief.
Load the relationship-briefing skill and prepare me for a conversation with: <subject>
Load the weekly-review skill and assemble my weekly review.
```

Do not interpolate the subject into shell, paths, or tool parameters; it remains
plain model context and passes through the existing inbound sanitizer.

- [ ] **Step 5: Add route-source assertions and verify GREEN**

The contract test checks that `telegram.ts` imports and calls
`chiefOfStaffCommand`, and contains all three exact skill names. Run focused tests
and `npm run typecheck` with Node 24.

- [ ] **Step 6: Commit routing**

```bash
git add agent/lib/i18n.ts agent/lib/i18n.test.ts agent/channels/telegram.ts scripts/chief-of-staff-skills.test.ts
git commit -m "feat(telegram): route chief-of-staff commands" -m "Expose daily attention, relationship preparation, and weekly review through the existing bilingual Telegram command surface. Parsing remains exact and side-effect-free, while the channel keeps the established authorization, transcript, and safety path."
```

---

### Task 5: Instructions and user documentation

**Goal:** Make natural-language discovery and user-facing command documentation accurate.

**Dependencies:** Task 4 command names and skill behavior.

**Touched files:**

- Modify: `agent/instructions.md`
- Modify: `agent/instructions/10-map.md`
- Modify: `docs/cli.md`
- Modify: `docs/use-cases.md`
- Modify: `docs/ru/use-cases.md`
- Modify: `docs/extending.md`
- Modify if the audit proves necessary: `README.md`
- Modify if the audit proves necessary: `README.ru.md`

**Accepted decisions:** Document outcomes and safety boundaries; do not repeat full skill bodies or redesign README assets.

**DoD:** Iva reaches for the three skills on matching natural-language requests; command docs are bilingual and accurate; use cases explain evidence and no-send behavior.

**Checks:** Contract test sees all skills in MAP; docs links resolve; formatting check passes.

- [ ] **Step 1: Add failing instruction assertions**

Extend the contract test to require all three skill names in
`agent/instructions.md` and `agent/instructions/10-map.md`.

- [ ] **Step 2: Verify RED**

Run the focused test and confirm the instruction assertions fail.

- [ ] **Step 3: Update instructions and docs minimally**

Add one routing bullet per workflow, add `/brief [person]` and `/weekly` to the
command list, list the three skills in MAP, and update CLI/use-case docs. Keep
claims limited to implemented read-only behavior.

- [ ] **Step 4: Audit root README accuracy**

Use `beautify-github-readme` in audit mode because this branch may later become
the default branch. Change root README files only if the feature list or command
story would otherwise be materially incomplete.

- [ ] **Step 5: Verify and commit documentation**

```bash
npm run format:check
node --test scripts/chief-of-staff-skills.test.ts agent/lib/i18n.test.ts
git add agent/instructions.md agent/instructions/10-map.md docs/cli.md docs/use-cases.md docs/ru/use-cases.md docs/extending.md README.md README.ru.md
git commit -m "docs(chief-of-staff): document briefing workflows" -m "Document how daily attention, relationship preparation, and weekly review use existing tasks and vault evidence. Clarify their read-only boundary and make the new commands and natural-language triggers discoverable."
```

Stage only files that actually changed.

---

### Task 6: Fresh verification and review

**Goal:** Prove the feature works within the local finish boundary and separate feature evidence from known baseline failures.

**Dependencies:** Tasks 1–5 complete.

**Touched files:** None unless verification exposes a defect, in which case return to RED before editing.

**Accepted decisions:** No production or live-vault smoke; build output is disposable; baseline failures are reported, not flattened.

**DoD:** All focused checks are green, build succeeds, diff contains no secrets/private data, original checkout is untouched, and an independent review finds no blocking issue.

**Checks:** Commands below plus diff review.

- [ ] **Step 1: Run fresh focused verification under Node 24**

```bash
PATH='/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' npm run typecheck
PATH='/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' npm run lint
PATH='/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' npm run format:check
PATH='/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' node --test scripts/chief-of-staff-skills.test.ts agent/lib/i18n.test.ts
PATH='/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' npm run build
```

- [ ] **Step 2: Run repository tests and compare baseline**

Run `npm test` with the same PATH. Re-run listener tests outside the filesystem
sandbox only if EPERM is the sole failure and execution authorization permits.
Report feature failures separately from the recorded platform and existing
coverage-inventory baseline.

- [ ] **Step 3: Inspect protected state and diff**

```bash
git diff --check
git status --short
git diff --stat 9036adb..HEAD
git diff 9036adb..HEAD -- . ':!docs/superpowers/plans/*' ':!docs/superpowers/specs/*'
git ls-files '.env*' 'data/**' 'attachments/**' 'vault/**'
```

Expected: no indexed private runtime files or credentials; original checkout
changes are absent from this worktree diff.

- [ ] **Step 4: Request independent code review**

Use `requesting-code-review` and a bounded review subagent for spec compliance,
skill behavior, routing correctness, regressions, and documentation accuracy.
Fix every blocking finding through a new failing test.

- [ ] **Step 5: Completion audit**

Re-read the design completion contract, run all evidence commands fresh, inspect
the active goal, and mark it complete only when every in-scope item has evidence.
Report that push/PR/deploy remain unperformed because the authorized finish
boundary is local.
