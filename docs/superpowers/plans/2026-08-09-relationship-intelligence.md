# Relationship Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build durable evidence-linked relationship intelligence with private CRM views, meeting dossiers, safe reply drafts, confirmed Google Tasks, and owner-only scheduled reports.

**Architecture:** Extend the validated Telegram contact pipeline with structured relationship observations and reduce them into a versioned, atomic per-user registry. Render readable managed regions into the existing Markdown vault, keep synthesis in focused skills, and place every external mutation behind narrow Google adapters whose policy cannot be bypassed through the generic tool.

**Tech Stack:** TypeScript ESM, Node.js 24, Zod 4, Eve tools/schedules, existing atomic JSON/card stores, `gws` through `execFile`, Node test runner.

## Global Constraints

- Work only on `strongf/relationship-intelligence`; do not merge, push, deploy, or contact external users.
- Do not change `Containerfile` or production deployment plumbing.
- Telegram userbot access remains strictly read-only: no send, reaction, delete, join, invite, mark-read, or other mutation.
- Proactive reports may go only to the owner's private bot chat.
- Gmail may create drafts only; it may never send mail or delete data.
- Calendar event creation must reject attendees; generic Google Tasks access is read-only.
- Detected commitments remain `pending_suggestion` until an item-specific owner confirmation creates a Google Task.
- Runtime state and vault content stay outside Git and under the existing per-user roots.
- New Node.js authored source and tests are TypeScript; no new `.mjs` files.
- Any authored `agent/` change requires `npm run build` before runtime claims.
- Supported verification runtime is Node.js 24; record the sandbox-only baseline separately.

---

## File map

- `scripts/relationship-intelligence/types.ts`: strict persisted and API schemas, stable IDs, lifecycle helpers, CRM time classification.
- `scripts/relationship-intelligence/store.ts`: private paths, locked atomic registry reads and mutations.
- `scripts/relationship-intelligence/reducer.ts`: convert validated Telegram observations into registry records and contact activity.
- `scripts/relationship-intelligence/crm.ts`: render contact CRM regions and the relationship overview without touching handwritten content.
- `scripts/relationship-intelligence/google.ts`: policy-aware `gws` execution, Gmail draft creation, and confirmed/idempotent Google Task creation.
- `scripts/relationship-intelligence/report.ts`: prepare and deliver versioned owner-only daily/weekly report artifacts.
- `agent/tools/relationship_intelligence.ts`: read/query/prepare/confirm/dismiss tool over stored relationship state.
- `agent/tools/gmail_draft.ts`: draft-only Gmail tool with no send/delete operation.
- `agent/skills/relationship-meeting-dossier/SKILL.md`: bounded dossier synthesis procedure.
- `agent/skills/relationship-reply-draft/SKILL.md`: Telegram suggestion or Gmail Draft procedure.
- `agent/skills/relationship-report/SKILL.md`: daily/weekly report composition procedure.
- `agent/schedules/relationship-{daily,weekly}-{prepare,deliver}.ts`: thin Eve schedule spawners.
- Existing contact-analysis, Google tool, schedule paths, memory map, docs, and coverage files change only at their integration seams.

---

### Task 1: Versioned commitment registry

**Goal:** Provide strict durable state and monotonic lifecycle transitions.

**Dependencies:** Existing `agent/lib/json-store.ts` lock and atomic-save primitives.

**Touched files:**

- Create: `scripts/relationship-intelligence/types.ts`
- Create: `scripts/relationship-intelligence/types.test.ts`
- Create: `scripts/relationship-intelligence/store.ts`
- Create: `scripts/relationship-intelligence/store.test.ts`

**Accepted decisions:** JSON is authoritative for lifecycle; Markdown is derived. IDs are stable hashes of normalized content plus canonical evidence.

**Interfaces:**

- Produces `RelationshipEvidenceSchema`, `CommitmentSchema`, `RelationshipRegistrySchema`.
- Produces `commitmentId(input): string`, `classifyCommitment(item, now): { overdue: boolean; forgotten: boolean }`.
- Produces `relationshipPaths(root?, dataDir?): RelationshipPaths`, `loadRegistry(paths)`, and `mutateRegistry(paths, mutation)`.

**DoD:** Strict schema, corrupt-state fail-closed, private modes, serialization, atomicity, stable IDs, and terminal-state monotonicity are proven.

**Checks:** `node --test scripts/relationship-intelligence/types.test.ts scripts/relationship-intelligence/store.test.ts`

- [ ] **Step 1: Write failing schema and lifecycle tests**

```ts
test("stable IDs bind normalized content to exact evidence", () => {
  const evidence = [
    {
      source: "telegram",
      sourceId: "telegram:message:44:9",
      observedAt: "2026-08-09T10:00:00Z",
    },
  ];
  assert.equal(
    commitmentId({ text: " Send report ", evidence }),
    commitmentId({ text: "send report", evidence }),
  );
  assert.notEqual(
    commitmentId({ text: "send report", evidence }),
    commitmentId({
      text: "send report",
      evidence: [{ ...evidence[0], sourceId: "telegram:message:44:10" }],
    }),
  );
});

test("terminal commitments never return to pending", () => {
  assert.throws(
    () =>
      transitionCommitment(
        fixture({ status: "dismissed" }),
        "pending_suggestion",
        NOW,
      ),
    /terminal/u,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/relationship-intelligence/types.test.ts`
Expected: FAIL because the module/functions do not exist.

- [ ] **Step 3: Implement strict schemas, stable IDs, and time classification**

```ts
export const CommitmentStatusSchema = z.enum([
  "pending_suggestion",
  "confirmed_task",
  "completed",
  "dismissed",
]);
export const RelationshipRegistrySchema = z.strictObject({
  schema: z.literal("iva-relationship-commitments/v1"),
  revision: z.int().nonnegative(),
  commitments: z.array(CommitmentSchema),
  contacts: z.record(CanonicalUserIdSchema, ContactActivitySchema),
});
export function commitmentId(
  input: Pick<Commitment, "text" | "evidence">,
): string {
  return `RI-${createHash("sha256")
    .update(
      canonicalJson({
        text: normalize(input.text),
        evidence: sortedEvidence(input.evidence),
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;
}
```

- [ ] **Step 4: Write failing persistence tests**

```ts
test("concurrent mutations serialize and keep 0600 state", async () => {
  const paths = relationshipPaths(root, "data");
  await Promise.all([
    mutateRegistry(paths, add(A)),
    mutateRegistry(paths, add(B)),
  ]);
  assert.deepEqual(
    (await loadRegistry(paths)).commitments.map((item) => item.id).sort(),
    [A.id, B.id],
  );
  assert.equal((await stat(paths.registry)).mode & 0o777, 0o600);
});

test("corrupt state fails closed without overwrite", async () => {
  await writeFile(paths.registry, "broken");
  await assert.rejects(
    () => mutateRegistry(paths, add(A)),
    /invalid relationship registry/u,
  );
  assert.equal(await readFile(paths.registry, "utf8"), "broken");
});
```

- [ ] **Step 5: Implement the private locked store**

Use `resolve(root, dataDir, "relationship-intelligence")`, reject escaped paths, create the directory as `0700`, acquire `${registry}.lock`, parse strictly, increment `revision` once per changed mutation, save with `saveJsonAtomic`, and `chmod` the result to `0600`.

- [ ] **Step 6: Run Task 1 checks and commit**

Expected: all Task 1 tests PASS.

Commit:

```text
feat(relationships): add durable commitment registry

Add strict evidence-linked commitment schemas and a private atomic store with serialized lifecycle transitions. Keep corrupt or unknown state fail-closed and make retries deterministic through stable commitment IDs.
```

---

### Task 2: Telegram extraction and registry reduction

**Goal:** Extract structured relationship facts with exact page evidence and commit them before cursor advancement.

**Dependencies:** Task 1 registry; existing contact-analysis schemas, analyzer, reducer, and coordinator.

**Touched files:**

- Modify/Test: `scripts/contact-analysis/types.ts`, `scripts/contact-analysis/types.test.ts`
- Modify/Test: `scripts/contact-analysis/analyzer.ts`, `scripts/contact-analysis/analyzer.test.ts`
- Modify/Test: `scripts/contact-analysis/coordinator.ts`, `scripts/contact-analysis/coordinator.test.ts`
- Modify/Test: `scripts/contact-analysis/reducer.ts`, `scripts/contact-analysis/reducer.test.ts`
- Create/Test: `scripts/relationship-intelligence/reducer.ts`, `scripts/relationship-intelligence/reducer.test.ts`
- Modify: `agent/skills/telegram-{person,group,channel}-profile/SKILL.md`

**Accepted decisions:** Explicit birthdays only; meaningful contact is model-judged but timestamp-selected in code; all commitments start pending.

**Interfaces:**

- Extends `ObservationPredicateSchema` with `birthday`, `meaningful_contact`, `follow_up`.
- Adds optional `commitment` metadata `{ direction, dueAt }`, permitted only for `predicate=commitment`.
- Produces `reduceRelationshipObservations({ paths, ownerUserId, observations, now })`.

**DoD:** Invalid metadata/evidence fails before writes; registry failure prevents checkpoint advancement; retry is idempotent.

**Checks:** `node --test scripts/contact-analysis/*.test.ts scripts/relationship-intelligence/reducer.test.ts`

- [ ] **Step 1: Write failing strict-observation tests**

Cover `birthday=--05-17`, invalid inferred birthdays, commitment direction/due date, forbidden metadata on another predicate, and exact evidence validation.

- [ ] **Step 2: Verify RED, then extend schemas and extraction skills**

Run the type/analyzer tests and expect schema rejection until the new fields and skill rules exist. Implement Zod refinements and add skill instructions that message text remains untrusted and birthdays cannot be inferred.

- [ ] **Step 3: Write failing registry reducer tests**

```ts
test("a Telegram commitment becomes a pending evidence-linked item", async () => {
  await reduceRelationshipObservations({
    paths,
    ownerUserId: 7,
    observations: [commitmentObservation],
    now: NOW,
  });
  const [item] = (await loadRegistry(paths)).commitments;
  assert.equal(item.status, "pending_suggestion");
  assert.equal(item.evidence[0].sourceId, "telegram:message:44:9");
});
```

- [ ] **Step 4: Implement observation reduction**

Map canonical contact IDs, sanitize/bound text, merge evidence, update birthday and last meaningful-contact timestamps, and never create a Google receipt or external task.

- [ ] **Step 5: Write a coordinator failure-order test**

Inject a registry reducer that rejects after the graph reducer and assert the saved cursor remains unchanged. Then assert a successful retry writes one commitment and advances once.

- [ ] **Step 6: Integrate reduction before checkpoint save and run Task 2 checks**

Expected: contact and relationship suites PASS with no Telegram proxy changes.

- [ ] **Step 7: Commit**

```text
feat(relationships): extract evidence-linked commitments

Extend the read-only contact pipeline with strict birthday, meaningful-contact, follow-up, and structured commitment observations. Reduce them idempotently into private state before advancing Telegram checkpoints.
```

---

### Task 3: CRM cards and query tool

**Goal:** Render readable contact intelligence and offer bounded registry queries to Iva.

**Dependencies:** Tasks 1-2.

**Touched files:**

- Create/Test: `scripts/relationship-intelligence/crm.ts`, `scripts/relationship-intelligence/crm.test.ts`
- Create/Test: `agent/tools/relationship_intelligence.ts`, `scripts/relationship-intelligence-tool.test.ts`
- Modify/Test: `scripts/contact-analysis/coordinator.ts`, `scripts/contact-analysis/coordinator.test.ts`

**Accepted decisions:** Numeric contact paths remain stable; CRM uses a distinct managed region; overview is `cards/notes/relationship-crm.md`.

**Interfaces:**

- Produces `renderRelationshipCrm({ vault, registry, now }): Promise<{ writtenFiles: string[] }>`.
- Tool actions initially expose `list`, `get`, `prepare_google_task`, `confirm_google_task`, `dismiss`; mutation implementations land in Task 4.

**DoD:** Cards show birthday, meaningful contact, promises, overdue and forgotten follow-ups; rendering is deterministic and preserves handwritten content.

**Checks:** `node --test scripts/relationship-intelligence/crm.test.ts scripts/relationship-intelligence-tool.test.ts scripts/contact-analysis/coordinator.test.ts`

- [ ] **Step 1: Write failing CRM rendering tests**

Create handwritten contact/overview fixtures, render at fixed `now`, and assert the managed region contains upcoming birthday, last meaningful contact, both promise directions, overdue and 30-day forgotten classifications while manual text remains.

- [ ] **Step 2: Implement safe managed-region rendering**

Use separate `<!-- iva:relationship-crm:start -->` markers, stable sorting, escaped inline values, canonical evidence IDs, and atomic writes under ordered card locks.

- [ ] **Step 3: Write failing bounded-query tool tests**

Assert list filters only enum statuses/classifications, get requires exact `RI-...`, non-owner mutation actions reject, and returned excerpts/arrays are bounded.

- [ ] **Step 4: Implement the read/query surface and integrate rendering**

After registry reduction succeeds, rebuild only affected contact cards plus the overview before saving the Telegram cursor.

- [ ] **Step 5: Run checks and commit**

```text
feat(relationships): render private contact CRM views

Add managed contact and overview views for birthdays, meaningful contact, promises, overdue items, and forgotten follow-ups. Preserve handwritten vault content and expose only bounded per-user queries to the agent.
```

---

### Task 4: Google policy, Gmail drafts, and confirmed Tasks

**Goal:** Enforce the shared Google policy and implement narrow, idempotent external actions.

**Dependencies:** Task 1 store and Task 3 relationship tool.

**Touched files:**

- Modify/Test: `agent/tools/google_workspace.ts`, `scripts/google-workspace-tool.test.ts`
- Create/Test: `scripts/relationship-intelligence/google.ts`, `scripts/relationship-intelligence/google.test.ts`
- Create/Test: `agent/tools/gmail_draft.ts`, `scripts/gmail-draft-tool.test.ts`
- Modify/Test: `agent/tools/relationship_intelligence.ts`, `scripts/relationship-intelligence-tool.test.ts`
- Modify: `agent/skills/google-workspace.md`

**Accepted decisions:** Generic Tasks is read-only; Gmail only reads/creates drafts; Calendar create rejects attendees; task content comes only from stored commitments.

**Interfaces:**

- Produces `validateGoogleWorkspaceArgs(args)` with verb-level policy.
- Produces `createGmailDraft(input, deps)` and `prepareTaskConfirmation(id, now)`.
- Produces `confirmGoogleTask({ id, phrase, role, now }, deps)` with lookup-before-insert idempotency.

**DoD:** No generic bypass; exact unexpired phrase and owner role required; API failures stay pending; retries reuse the task marker.

**Checks:** `node --test scripts/google-workspace-tool.test.ts scripts/relationship-intelligence/google.test.ts scripts/gmail-draft-tool.test.ts scripts/relationship-intelligence-tool.test.ts`

- [ ] **Step 1: Write failing generic-policy tests**

Reject Gmail `+send`, `+reply`, messages send/trash/delete; Tasks insert/patch/delete; Drive delete/trash/permission mutation; Calendar event JSON with attendees. Accept Gmail draft create, Calendar attendee-free insert, Tasks list/get, and Docs/Sheets/Drive artifact creation.

- [ ] **Step 2: Implement verb-aware validation before `execFile`**

Parse helper and Discovery command shapes without shell evaluation. Parse `--json` as JSON for Calendar event creation and reject any own `attendees` property, including an empty array.

- [ ] **Step 3: Write failing Gmail draft tests and implement the draft-only adapter**

The tool schema accepts recipient, subject, and body, builds RFC 2822 bytes, base64url-encodes them, and calls Gmail Drafts create. It exposes no action enum and therefore no send/delete path.

- [ ] **Step 4: Write failing confirmation tests**

Cover owner-only prepare, exact phrase, wrong/expired phrase, stored-content derivation, pending state on API failure, successful receipt, existing Google task marker reuse, and repeated confirmation returning the same receipt.

- [ ] **Step 5: Implement prepare/confirm through the relationship tool**

Persist only a hash of the challenge, use a 15-minute expiry, derive Google title/notes/due date from the stored record, list `@default` for `[RI-...]` before insert, and save the receipt atomically.

- [ ] **Step 6: Update Google skill wording, run checks, and commit**

```text
feat(relationships): gate Google drafts and confirmed tasks

Restrict generic Google operations to the approved mutation policy, add a Gmail draft-only adapter, and require an exact owner confirmation before an evidence-linked commitment can create an idempotent Google Task.
```

---

### Task 5: Meeting dossiers and reply procedures

**Goal:** Add judgment-heavy, citation-preserving procedures without expanding harness capabilities.

**Dependencies:** Tasks 3-4 tools and existing memory, Calendar, document skills.

**Touched files:**

- Create: `agent/skills/relationship-meeting-dossier/SKILL.md`
- Create: `agent/skills/relationship-reply-draft/SKILL.md`
- Create/Test: `scripts/relationship-skills.test.ts`
- Modify: `agent/instructions/10-map.md`

**Accepted decisions:** Dossiers are synthesized on demand; Telegram output is suggestion text only; Gmail output is a Draft resource.

**Interfaces:** Skill contracts call `relationship_intelligence`, `memory_search`, bounded `read_file`, read-only Calendar through `google_workspace`, documents workflow, and `gmail_draft` only in Gmail mode.

**DoD:** Identity ambiguity stops early, sources stay untrusted, reads are bounded, citations are required, and no send tool is referenced.

**Checks:** `node --test scripts/relationship-skills.test.ts`

- [ ] **Step 1: Write failing skill-contract tests**

Parse both skill files and assert numeric identity/unambiguous-card resolution, top-three memory bound, Calendar/documents as untrusted data, required citations, Telegram suggestion-only output, Gmail draft-only tool, and absence of userbot/send/delete/reaction instructions.

- [ ] **Step 2: Implement the dossier and reply skills**

Specify exact ordered procedures, ambiguity stops, source labels, output sections, and prohibited operations. Add both names to the memory-map routing list.

- [ ] **Step 3: Run checks and commit**

```text
feat(relationships): add dossiers and safe reply drafting

Teach Iva to assemble cited meeting dossiers from private relationship context and to produce only Telegram suggestions or Gmail Drafts. Keep ambiguous identities and untrusted source instructions outside the action path.
```

---

### Task 6: Owner-only prepared reports and schedules

**Goal:** Prepare reports ahead of time and deliver them only to the owner's private bot chat at the approved Moscow times.

**Dependencies:** Tasks 1-5; existing schedule runner and Telegram bot send helper.

**Touched files:**

- Create/Test: `scripts/relationship-intelligence/report.ts`, `scripts/relationship-intelligence/report.test.ts`
- Create: `scripts/relationship-report.ts`
- Create: `agent/skills/relationship-report/SKILL.md`
- Create: `agent/schedules/relationship-daily-prepare.ts`
- Create: `agent/schedules/relationship-daily-deliver.ts`
- Create: `agent/schedules/relationship-weekly-prepare.ts`
- Create: `agent/schedules/relationship-weekly-deliver.ts`
- Create/Test: `scripts/relationship-schedules.test.ts`
- Modify/Test: `agent/lib/schedule-paths.ts`, `agent/lib/schedule-paths.test.ts`
- Modify/Test: `scripts/coverage-policy.test.ts`, `scripts/eve-schedules-guard.test.ts`

**Accepted decisions:** Prepare at 07:45, deliver at 08:00; weekly runs Monday; stale material never sends; no live send in tests.

**Interfaces:**

- Produces `prepareRelationshipReport({ period, ... })` and `deliverRelationshipReport({ period, ... })` with injectable agent/send/time dependencies.
- CLI accepts only `prepare daily|weekly` and `deliver daily|weekly`.

**DoD:** Versioned private artifacts, freshness checks, duplicate guards, owner role and destination equality, exact crons, and failure status are proven.

**Checks:** `node --test scripts/relationship-intelligence/report.test.ts scripts/relationship-schedules.test.ts agent/lib/schedule-paths.test.ts scripts/eve-schedules-guard.test.ts`

- [ ] **Step 1: Write failing report lifecycle tests**

Assert preparation writes `0600` artifacts with period/date/schema; delivery rejects missing/stale/wrong-period/already-delivered artifacts; failed sends remain undelivered; successful sends mark the exact artifact.

- [ ] **Step 2: Implement report preparation and owner-private delivery**

Use the relationship-report skill through Eve for synthesis. In multi-user mode require `ASSISTANT_ROLE=owner`, a canonical `ASSISTANT_USER_ID`, and a destination equal to that ID before calling the bot send helper.

- [ ] **Step 3: Write failing schedule contract tests**

Assert crons are `45 7 * * *`, `0 8 * * *`, `45 7 * * 1`, and `0 8 * * 1`; each schedule calls the shared runner with its exact action/period and owner-only guard.

- [ ] **Step 4: Implement thin schedules and CLI entrypoint**

Schedules contain no report logic. Path definitions reuse personal root/data/status contracts and a relationship-specific lock.

- [ ] **Step 5: Update coverage inventories, run checks, and commit**

```text
feat(relationships): schedule owner-only relationship reports

Prepare daily and weekly relationship material before its delivery slot and send only fresh artifacts to the owner's private bot chat. Add deterministic schedule, isolation, freshness, and retry coverage.
```

---

### Task 7: Documentation, fresh verification, and review

**Goal:** Prove every completion-contract item, update only affected docs, and leave a clean local branch.

**Dependencies:** Tasks 1-6 complete.

**Touched files:**

- Modify: `docs/memory.md`, `docs/userbot.md`, `docs/configuration.md`, `docs/extending.md`
- Modify: `README.md`, `README.ru.md` only if the product/setup story is inaccurate without the change
- Modify: `docs/superpowers/plans/2026-08-09-relationship-intelligence.md` checkboxes
- Review all changed files; no production files.

**Accepted decisions:** No README visual redesign; no deployment claims; known sandbox baseline remains separate.

**DoD:** Requirement-to-evidence audit is complete, reviewer findings are resolved or documented, commits are conventional/multiline, and `git status` is clean.

**Checks:**

```bash
node --test scripts/relationship-intelligence/*.test.ts scripts/contact-analysis/*.test.ts scripts/google-workspace-tool.test.ts scripts/gmail-draft-tool.test.ts scripts/relationship-intelligence-tool.test.ts scripts/relationship-skills.test.ts scripts/relationship-schedules.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:security
/Users/strongf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=4
git diff --check
git status --short --branch
```

- [ ] **Step 1: Update affected documentation and plan checkboxes**

Document the registry path/privacy, CRM fields, pending/confirmation lifecycle, dossier/draft behavior, Google restrictions, owner-only schedules, rebuild requirement, and local-only verification boundary.

- [ ] **Step 2: Run focused tests and fix only feature-caused failures using systematic debugging**

Expected: all focused feature/contact/Google/schedule tests PASS.

- [ ] **Step 3: Run typecheck, lint, formatting, authored build, and security suite**

Expected: all commands exit 0. Agent runtime claims are forbidden until `npm run build` succeeds.

- [ ] **Step 4: Run the full supported-runtime suite and compare to baseline**

Expected: no new failures relative to the recorded baseline of 14 sandbox-only failures (8 process-group/bash, 5 local-listen, 1 local health CLI) and 961 passes before feature work. Any changed failure set must be investigated.

- [ ] **Step 5: Invoke requesting-code-review and resolve findings**

Review scope: `origin/main..HEAD`, with special attention to user data paths, Google bypasses, confirmation idempotency, Telegram read-only invariants, cursor ordering, managed Markdown, and schedule destination isolation.

- [ ] **Step 6: Run the entire verification set fresh after review changes**

Record exact pass/fail counts and command outputs; stale pre-review evidence is not sufficient.

- [ ] **Step 7: Commit final docs/review changes and audit the branch**

```text
docs(relationships): document private relationship workflows

Document relationship CRM, commitment confirmation, meeting dossier, safe drafting, and owner-only report behavior. Record the supported local verification boundary without making deployment or live-account claims.
```

Verify `git diff origin/main...HEAD -- Containerfile deploy/` is empty, no secret/runtime paths are indexed, all commits have multiline Conventional Commit messages, and `git status --short` is empty.
