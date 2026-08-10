# Telegram Rich People Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make person views, relationship briefs, and person-memory update results render as one native Telegram Rich Message through Iva's existing reply lifecycle.

**Architecture:** Extend the existing `rich-post` skill with an embedded renderer mode, then require that mode from the two People skills. Rich Markdown templates always include a table or `<details>` block, so the current `needsRichMessage` detector chooses `sendRichMessage`; no new transport or persistent state is added.

**Tech Stack:** TypeScript ESM, Node.js 24 test runner, Eve skills, Telegram Bot API 10.2 Rich Messages, Markdown.

## Global Constraints

- People remains owner-only and private-bot-only.
- The personal Telegram userbot remains strictly read-only.
- `send_rich.py` must not be called from People workflows.
- The normal Eve reply lifecycle remains authoritative and retains HTML/plain fallback.
- Every memory-derived claim retains an adjacent vault-relative source.
- No callback payload, tracked file, or log receives person data.

---

### Task 1: Lock the rich People response contract with failing tests

**Files:**
- Modify: `scripts/chief-of-staff-skills.test.ts`
- Modify: `scripts/lib/telegram-rich.test.ts`

**Interfaces:**
- Consumes: `needsRichMessage(md: unknown): boolean` from `scripts/lib/telegram-format.ts`.
- Produces: regression assertions for the three People response paths and the embedded renderer contract.

- [ ] **Step 1: Add failing skill-contract assertions**

Add assertions that `person-memory.md` and `relationship-briefing.md` mention
`rich-post`, `embedded renderer mode`, `send_rich.py`, a Markdown table delimiter,
`<details>`, and one-message output. Also assert that `agent/instructions.md` keeps
People workflows on the normal renderer while explicitly requiring Rich Markdown.

```ts
assert.match(skill.body, /rich-post/u);
assert.match(skill.body, /embedded renderer mode/iu);
assert.match(skill.body, /send_rich\.py/u);
assert.match(skill.body, /\|[ \t]*---/u);
assert.match(skill.body, /<details>/u);
assert.match(skill.body, /one (?:normal )?reply/iu);
```

- [ ] **Step 2: Add a representative routing assertion**

Add a person-card fixture containing both a summary table and collapsed evidence,
then prove the existing detector selects the rich transport.

```ts
const personCard = `# 👤 Alice Example

| Field | Current |
|---|---|
| Relationship | Colleague |

<details><summary>Sources</summary>
vault/cards/contacts/alice.md
</details>`;
assert.equal(needsRichMessage(personCard), true, "People rich card");
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --test scripts/chief-of-staff-skills.test.ts scripts/lib/telegram-rich.test.ts
```

Expected: the new skill-contract assertions fail because embedded renderer mode is
not documented yet; existing detector assertions continue to pass.

### Task 2: Implement embedded rich renderer mode for People

**Files:**
- Modify: `agent/skills/rich-post/SKILL.md`
- Modify: `agent/skills/person-memory.md`
- Modify: `agent/skills/relationship-briefing.md`
- Modify: `agent/instructions.md`
- Modify: `agent/channels/telegram.ts`

**Interfaces:**
- Consumes: the existing `message.completed` rich detector and HTML/plain fallback.
- Produces: a single Rich Markdown reply contract for view, supplement, ambiguity,
  missing-contact, and relationship-brief paths.

- [ ] **Step 1: Document embedded renderer mode in `rich-post`**

Add a bounded mode that is selected only when another skill owns the current Eve
reply. It must return Rich Markdown containing a native-rich construct and must not
invoke the standalone script.

```md
## Embedded renderer mode

When another workflow explicitly selects embedded renderer mode, return exactly one
normal assistant reply in Rich Markdown. Include a table, task list, `<details>`, or
block formula so the Telegram channel selects `sendRichMessage`. Do not create a
temporary file and do not call `send_rich.py`; the current Eve turn owns delivery.
```

- [ ] **Step 2: Give `person-memory` exact rich templates**

Require all terminal outcomes to load `rich-post` in embedded renderer mode. View
uses `# 👤`, a two-column table, bounded lists, and collapsed evidence/history.
Supplement results use a result table with `NOOP`, `UPDATE`, or `SUPERSEDE` and the
verified card path. Missing or ambiguous identities use the same single-message
contract without writing.

```md
| Поле | Текущее значение |
|---|---|
| Связь | ... |
| Уверенность | ... |

<details><summary>Источники и история</summary>
...
</details>
```

- [ ] **Step 3: Give `relationship-briefing` the matching rich template**

Preserve its five evidence-backed sections and five-talking-point cap, while adding
a context table and collapsed sources/history. Keep claim-level citations adjacent.

- [ ] **Step 4: Clarify the channel routing contract**

Update the `/person` operational context and root instructions to require exactly
one normal Rich Markdown response using embedded renderer mode, explicitly forbidding
temporary files and `send_rich.py`. Do not alter auth, sanitization, storage, or
callback handling.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test scripts/chief-of-staff-skills.test.ts scripts/lib/telegram-rich.test.ts scripts/telegram-person-memory-routing.test.ts scripts/lib/menu/people.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add agent/skills/rich-post/SKILL.md agent/skills/person-memory.md agent/skills/relationship-briefing.md agent/instructions.md agent/channels/telegram.ts scripts/chief-of-staff-skills.test.ts scripts/lib/telegram-rich.test.ts
git commit -m "feat(people): render memory cards as rich messages" -m "Use the existing Telegram rich-post contract inside People workflows while preserving the normal Eve delivery lifecycle and all owner-only memory safeguards.\n\nAdd regression coverage for native-rich routing and prevent duplicate standalone report sends."
```

### Task 3: Verify, review, document, and publish

**Files:**
- Modify only if audit proves needed: `README.md`, `README.ru.md`

**Interfaces:**
- Consumes: the completed feature diff against fresh `origin/main`.
- Produces: verified PR, protected-main merge, deployed immutable image, and healthy runtime evidence.

- [ ] **Step 1: Run fresh local verification under Node.js 24**

Run:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:coverage
git diff --check origin/main...HEAD
```

Expected: every command exits 0 and the test summary reports zero failures.

- [ ] **Step 2: Run container smoke**

Build the repository `Containerfile` for Linux amd64 and run the focused People and
rich-message tests inside the image. Verify the built Eve output exists.

- [ ] **Step 3: Request independent code review**

Review the complete diff for delivery duplication, rich-format fallback, skill
contradictions, owner-gate regression, prompt-injection handling, and unsupported
Telegram syntax. Reproduce and fix every actionable finding, then rerun affected
checks.

- [ ] **Step 4: Audit README accuracy**

Use `beautify-github-readme` in audit mode. Update README wording only if the People
feature description would otherwise be materially inaccurate; do not redesign
assets.

- [ ] **Step 5: Publish through protected main and verify production**

Push `strongf/telegram-rich-people`, open a ready PR, wait for required `verify`,
merge normally, and follow the repository deploy workflow. Success requires local
`main`, `origin/main`, deployed SHA/image, Iva health, Telegram poller/userbot health,
scheduler health, routing probe, and zero restart counts to agree.
