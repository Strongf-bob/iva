# Iva Menu Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `/menu` settings panel with an action-first control center and add a safe person-memory view/update workflow.

**Architecture:** Keep the existing out-of-band Telegram menu engine and add small screen modules for user-facing hubs. Reuse existing task, schedule, settings and agent-command paths; route person interpretation and contact-card mutations through a new skill while deterministic TypeScript owns parsing, role gates and handoff integrity.

**Tech Stack:** TypeScript ESM, Node.js 24, Telegram Bot API inline keyboards, Eve skills/tools, Zod, Node test runner.

## Global Constraints

- Personal Telegram userbot operations remain strictly read-only.
- Unified inbox and people intelligence are owner-only in multi-user mode.
- Gmail remains read/draft-only; no email send or Calendar attendee mutation is added.
- Names and notes never appear in callback data and remain bounded untrusted data.
- Contact Markdown is never edited by menu code; mutations use `write_card`.
- Runtime data stays beneath the selected personal root and outside Git.
- Any authored `agent/*` change requires `npm run build` before completion.

---

### Task 1: Action-first root and grouped settings

**Files:**

- Modify: `scripts/lib/menu/root.ts`
- Create: `scripts/lib/menu/settings.ts`
- Create: `scripts/lib/menu/settings-ai.ts`
- Create: `scripts/lib/menu/settings-connections.ts`
- Create: `scripts/lib/menu/settings-personalization.ts`
- Create: `scripts/lib/menu/settings-system.ts`
- Modify: `scripts/lib/menu/index.ts`
- Modify: `scripts/lib/menu/{search,lang,character,core,userbot,gws,skills,status,service}.ts`
- Test: `scripts/lib/menu/root.test.ts`
- Test: `scripts/lib/menu/menu-screens.test.ts`

**Interfaces:**

- Consumes: existing `MenuState` role/personalRoot fields and `MenuContext` navigation helpers.
- Produces: registered screen IDs `set`, `sai`, `scon`, `sper`, and `ssys`; existing screens return to their owning settings group.

- [ ] **Step 1: Write failing root and grouped-navigation tests**

Assert owner rows are exactly Today/Inbox, People/Tasks, Automation/Settings and Close; ordinary users omit Inbox/People; personalized owners omit unsafe legacy personalization. Assert every settings group routes only to allowed existing screens and uses a `set` back target.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/lib/menu/root.test.ts scripts/lib/menu/menu-screens.test.ts`

Expected: FAIL because the action hubs and grouped settings screens do not exist.

- [ ] **Step 3: Implement the root and settings screen modules**

Use fixed callback identifiers only. Register every screen in `SCREENS`, update the callback grammar comment, and change existing screen parent/back targets without changing their functional behavior.

- [ ] **Step 4: Verify GREEN**

Run: `node --test scripts/lib/menu/root.test.ts scripts/lib/menu/menu-screens.test.ts scripts/lib/menu/menu-index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit title: `feat(menu): introduce the action-first control center`

### Task 2: Today, inbox, tasks and automation hubs

**Files:**

- Create: `scripts/lib/menu/handoff.ts`
- Create: `scripts/lib/menu/today.ts`
- Create: `scripts/lib/menu/inbox.ts`
- Create: `scripts/lib/menu/tasks.ts`
- Create: `scripts/lib/menu/automation.ts`
- Modify: `scripts/lib/menu/crons.ts`
- Modify: `scripts/lib/menu/index.ts`
- Test: `scripts/lib/menu/action-hubs.test.ts`
- Test: `scripts/lib/menu/menu-index.test.ts`

**Interfaces:**

- Consumes: `deps.deliver`, `deps.reply`, `flows.end`, `openTaskCount`, user ID, role and personalRoot.
- Produces: `handoffText(st, ctx, text, copy)` and registered screen IDs `td`, `in`, `tsk`, `auto`; model handoffs end the menu before dispatch.

- [ ] **Step 1: Write failing action-hub tests**

Cover zero-token task counts, owner-only inbox rendering from a valid bounded state fixture, honest missing/corrupt inbox states, `/brief`, `/weekly`, `/tasks` and `/task <text>` handoffs, input length bounds, delivery failure copy and Automation → Timers navigation.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/lib/menu/action-hubs.test.ts scripts/lib/menu/menu-index.test.ts`

Expected: FAIL because the action hubs and handoff helper are absent.

- [ ] **Step 3: Implement minimal hub screens and handoff helper**

Read only persisted counts/metadata. Do not execute unified-inbox collection from the menu. Keep every expensive/model action explicit and keep callback data free of user content.

- [ ] **Step 4: Verify GREEN**

Run: `node --test scripts/lib/menu/action-hubs.test.ts scripts/lib/menu/menu-index.test.ts scripts/lib/menu/crons.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit title: `feat(menu): expose daily work and automation hubs`

### Task 3: Person memory view and supplement workflow

**Files:**

- Create: `scripts/lib/menu/people.ts`
- Modify: `scripts/lib/menu/index.ts`
- Modify: `agent/lib/i18n.ts`
- Modify: `agent/lib/i18n.test.ts`
- Modify: `agent/channels/telegram.ts`
- Create: `agent/skills/person-memory.md`
- Modify: `agent/instructions.md`
- Modify: `agent/instructions/10-map.md`
- Test: `scripts/lib/menu/people.test.ts`
- Test: `scripts/person-memory.test.ts`
- Modify: `scripts/chief-of-staff-skills.test.ts`

**Interfaces:**

- Consumes: menu text intake, existing `memory_search`, `read_file`, `write_card`, inbound sanitization and Telegram auth/routing.
- Produces: public `/person <name>` view route; internal strict `/person_update <json>` route; skill modes `view` and `supplement`.

- [ ] **Step 1: Write failing menu flow tests**

Cover name capture, two-step supplement capture, callback-data privacy, 1–160 code-point names, 1–2000 code-point notes, Back cancellation, `/person` lookup handoff, `/brief` preparation handoff and strict JSON update handoff.

- [ ] **Step 2: Verify menu RED**

Run: `node --test scripts/lib/menu/people.test.ts`

Expected: FAIL because the People screen is absent.

- [ ] **Step 3: Implement the People menu screen**

Store bounded user input only in the in-memory menu state. Serialize the internal update object with `JSON.stringify`; never place either field in `callback_data`.

- [ ] **Step 4: Write failing command and skill contract tests**

Assert `/person` accepts one bounded subject, `/person_update` accepts only strict `{name,note}` JSON, malformed/oversized payloads are rejected, both fields pass through inbound sanitization as adjacent untrusted data, view mode forbids writes, supplement mode resolves exactly one contact and uses only `write_card` with explicit UPDATE/SUPERSEDE rules.

- [ ] **Step 5: Verify command/skill RED**

Run: `node --test agent/lib/i18n.test.ts scripts/person-memory.test.ts scripts/chief-of-staff-skills.test.ts`

Expected: FAIL because the parser, routing and skill are absent.

- [ ] **Step 6: Implement parser, Telegram routing and skill**

Expose `/person` in the supported command catalog. Keep `/person_update` internal and absent from `COMMANDS`. Reuse existing auth, daily logging, typing and injection-warning behavior before handing control to the skill.

- [ ] **Step 7: Verify GREEN**

Run: `node --test scripts/lib/menu/people.test.ts agent/lib/i18n.test.ts scripts/person-memory.test.ts scripts/chief-of-staff-skills.test.ts scripts/telegram-security-routing.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Commit title: `feat(people): add safe person memory workflows`

### Task 4: Command discoverability and documentation

**Files:**

- Modify: `agent/lib/i18n.ts`
- Modify: `agent/lib/i18n.test.ts`
- Modify: `docs/menu.md`
- Modify: `docs/cli.md`
- Modify: `README.md`
- Modify: `README.ru.md`

**Interfaces:**

- Consumes: the single bilingual `COMMANDS` catalog.
- Produces: an explicit `telegramMenu` visibility property; complete `/help`; concise public Telegram command menu.

- [ ] **Step 1: Write failing command visibility tests**

Assert `/help` retains every supported command while `botCommands()` returns only menu, brief, person, tasks, weekly, new, stop and help in stable order.

- [ ] **Step 2: Verify RED**

Run: `node --test agent/lib/i18n.test.ts`

Expected: FAIL because command visibility is not represented.

- [ ] **Step 3: Implement catalog filtering and update affected docs**

Document the six hubs, person view/supplement flow, role restrictions and zero-token versus model-backed actions. Keep README changes limited to the newly discoverable product capability.

- [ ] **Step 4: Verify GREEN and documentation consistency**

Run: `node --test agent/lib/i18n.test.ts scripts/lib/menu/*.test.ts scripts/chief-of-staff-skills.test.ts scripts/person-memory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit title: `docs(menu): document the control center workflows`

### Task 5: Full verification, review and publication

**Files:**

- Review: complete diff from fresh `origin/main`
- Update only if needed: files with reproducible review findings

**Interfaces:**

- Consumes: completed feature branch.
- Produces: reviewed, verified branch and protected-main PR/release evidence.

- [ ] **Step 1: Run fresh project checks**

Run: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `git diff --check`, focused menu/person tests, `npm test`, release/deploy contract tests and the relevant container smoke under Node 24.

Expected: all supported-environment checks pass; any local sandbox/Node 26 baseline failures are reproduced against unmodified `origin/main` before classification.

- [ ] **Step 2: Request independent code review**

Review role gates, callback/input bounds, prompt-injection separation, contact identity ambiguity, write-card-only mutation, personal-root isolation, stale menu behavior and command discoverability. Fix every reproducible actionable finding with TDD and repeat review.

- [ ] **Step 3: Audit README accuracy**

Use `beautify-github-readme` in audit mode. Keep only evidence-backed documentation changes required by the new menu and person workflow.

- [ ] **Step 4: Publish through protected main**

Push `strongf/menu-control-center`, create an English ready PR, wait for required `verify`, fix CI failures, merge normally, follow the repository release/deploy path and verify local main, origin/main, deployed immutable SHA and Telegram/runtime health agree.

Expected: no branch-protection bypass, no restart loop and exact-SHA production evidence.
