# Iva Menu Control Center Design

**Date:** 2026-08-10

**Status:** approved by the user

## Goal

Turn `/menu` from a flat technical settings panel into Iva's action-first control
center, and add a safe people workflow that lets the user inspect what Iva knows
about a named person and explicitly supplement that person's contact card.

## Existing foundations

The Telegram bridge already owns an out-of-band, zero-token inline menu with
per-user state, bounded text intake, stale-state recovery and role-aware roots.
Existing commands and skills already cover daily briefs, weekly reviews, tasks,
relationship briefings, unified inbox judgment, Google Workspace, reminders,
contact analysis and relationship intelligence. Contact cards are stored under
the private vault and are safely mutated through `write_card`.

The feature reorganizes and exposes these capabilities. It does not introduce a
web dashboard, another database, another Telegram client, or direct mutation of
provider data.

## Information architecture

The owner root contains six action-oriented destinations:

```text
Iva

[Today]       [Inbox]
[People]      [Tasks]
[Automation]  [Settings]
[Close]
```

The ordinary-user root contains only personal capabilities:

```text
Iva

[Today]       [Tasks]
[Automation]  [Settings]
[Close]
```

Owner-only Telegram contact intelligence, unified inbox and host administration
must never be exposed to ordinary users. A personalized owner retains access to
the owner destinations while each screen resolves its data from the owner's
personal root.

### Today

The screen offers explicit actions for the existing daily attention brief and
weekly review. It shows the open-task count from local state without invoking the
model. Creating a fresh brief is an intentional handoff to the agent and closes
the menu flow before the model turn begins.

### Inbox

The owner-only screen explains the read-only Telegram/Gmail/Calendar sources and
offers an explicit private inbox review handoff. It never sends Telegram messages,
sends email, marks provider items read, or creates tasks. Gmail reply work remains
draft-only under the existing Google policy.

### People

The owner-only screen has three actions:

1. **What do we know?** asks for a person's name and invokes `/person <name>`.
2. **Supplement a person** asks first for the name and then for the user-provided
   fact or correction. It invokes an internal, validated person-update route.
3. **Prepare for a conversation** asks for a name and invokes the existing
   `/brief <name>` workflow.

Names and supplements are untrusted user data. They are length-bounded, kept out
of callback data, sanitized by the Telegram channel and placed in adjacent data
context rather than interpolated into trusted instructions.

The `person-memory` skill resolves identity with `memory_search`, reads only the
smallest sufficient set of contact/supporting cards, and preserves ambiguity. A
view operation is strictly read-only. A supplement uses `write_card` only after
one contact identity is resolved:

- `UPDATE` appends a compatible user-provided fact;
- `SUPERSEDE` is used only for an explicit correction and preserves the old value
  in history;
- no match or multiple matches produces candidates and no write;
- the skill never silently merges two people or invents missing fields.

The response distinguishes `EXTRACTED`, `INFERRED` and `AMBIGUOUS` material and
cites every opened vault-relative path. User-provided additions are described as
such rather than attributed to Telegram analysis.

### Tasks

The screen shows the open-task count and launches existing task-list and task-add
flows. A text entered for a new task is handed to the existing `/task` route. It
does not choose a destination or bypass the normal task tool.

### Automation

The screen presents human-facing entry points for reminders and schedules and
links to the existing detailed timers screen. This release does not add a second
scheduler or direct toggle semantics for persisted schedule formats.

### Settings

The current technical screens move behind four stable groups:

- **AI:** model, thinking and search;
- **Connections:** Google and owner-only personal userbot;
- **Personalization:** language, character and memory where the current runtime
  supports their existing safe paths;
- **System:** status, usage/skills and owner maintenance.

Existing screens retain their current behavior, restart rules and secret intake.

## Telegram commands

`/menu` is renamed in copy from "settings menu" to "main menu". A new
`/person <name>` command provides deterministic routing to `person-memory` view
mode. The internal update form is accepted only through a strict parser and is
not advertised in Telegram's command list.

The public Telegram command menu prioritizes common actions while `/help` retains
the complete supported catalog. This requires an explicit visibility flag in the
command catalog rather than duplicating command definitions.

## Interaction and failure behavior

- Every input screen offers a visible Back/Cancel path.
- Commands cancel an outstanding menu text intake as they do today.
- Input is bounded before delivery; blank or oversized input is rejected inline.
- A model handoff ends the menu state and confirms that Iva is working.
- Busy-agent or delivery failure produces an honest retry message and never
  claims that a card changed.
- Stale navigation self-heals; stale data actions remain rejected.
- Menu navigation and local counts consume no model tokens.

Telegram inline keyboards use labeled emoji because Telegram provides no custom
SVG icon surface. Buttons remain text-labeled, two per row at most, and navigation
depth remains predictable.

## Security and privacy

- The personal Telegram userbot remains strictly read-only.
- Unified inbox and people intelligence remain owner-only in multi-user mode.
- Gmail remains read/draft-only; Calendar has no attendee mutation.
- Person data stays in the private vault; runtime state stays outside Git.
- Callback payloads contain only fixed screen/action identifiers, never names or
  notes.
- Contact writes use `write_card`; menu code never edits card Markdown directly.
- Existing allowlist, private-chat, tenant-routing and prompt-injection gates stay
  in front of all new routes.

## Testing

Contract tests cover root visibility by role, grouped settings navigation,
action-screen callback routes, bounded person/task text intake, internal handoff
payloads, command catalog visibility, person route sanitization, skill ambiguity,
read-only view behavior and guarded `write_card` updates. Existing menu, Telegram,
auth, task, userbot and relationship suites remain green.

Because authored files under `agent/` change, verification must include
`npm run build`, typecheck, lint, format check, focused tests and the complete test
suite under the repository's supported Node 24 environment.

## Completion contract

The feature is complete when the six-hub owner menu and restricted user menu are
implemented, every destination is reachable, `/person` can inspect a single
resolved contact, explicit supplements safely update only that contact through
`write_card`, documentation is accurate, review has no actionable findings, and
the protected-main publication path has fresh verification evidence.

Out of scope: a web dashboard, direct Telegram-userbot writes, Gmail sends,
automatic contact-card correction, a new database, a second scheduler, or changes
to the current contact-analysis model pipeline.
