# Telegram Contact Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Application implementation stays in the primary session; project policy does not permit implementation delegation.

**Goal:** Build an automatic, resumable, read-only Telegram pipeline that analyzes every accessible text chat with three concurrent chat workers and materializes a source-backed people/group/channel graph in Iva's existing Markdown vault.

**Execution status:** Implemented and verified locally on 2026-08-08. The unchecked steps below are retained as the original execution runbook; live-account validation, commit, push and deployment remain outside the completed local boundary.

**Architecture:** The sole Telethon session owner exposes three bounded bearer-authenticated read endpoints. A TypeScript coordinator fetches chronological pages, calls the configured Iva model with one of three skill prompts and a strict Zod output schema, then serializes validated observations through one vault reducer. Markdown cards and reciprocal wikilinks are the durable graph; private atomic checkpoint files make the import incremental and crash-resumable.

**Tech Stack:** TypeScript ESM, Node.js 24, Zod 4, AI SDK 7 structured streaming, Eve schedules, Python 3, Telethon, Starlette, Markdown/Obsidian wikilinks, existing Iva card/frontmatter/JSON-store utilities.

## Global Constraints

- Process the complete accessible text history on first import; chunking must never sample or omit messages.
- Run exactly three chats concurrently; pages inside one chat stay chronological and sequential.
- Telegram access is read-only. No send, reply, forward, reaction, join, invite or delete operation may be reachable from the pipeline.
- Canonical identities are `telegram:user:<user_id>`, `telegram:chat:<chat_id>` and `telegram:message:<chat_id>:<message_id>`.
- Names and usernames are mutable attributes, never identity keys.
- Every material observation requires bounded message evidence and one of `EXTRACTED`, `INFERRED` or `AMBIGUOUS`.
- Owner self-statements, external claims and model inferences remain separate; imported data never edits `CORE.md`.
- Voice/video content is counted but not transcribed or analyzed.
- Runtime state stays under `ASSISTANT_DATA_DIR/contact-analysis/`, outside Git, with `0600` files and `0700` directories.
- New Node.js source and tests are TypeScript; no new `.mjs` entrypoint is allowed.
- Any authored `agent/` change requires `npm run build` before runtime verification.
- Do not commit, push or deploy without separate user authorization.
- The clean-main baseline recorded before feature writes is 829 passing, 3 failing and 4 skipped tests under local Node 26.3.0; the three known failures are `scripts/lib/custom-layer.test.ts` public-build fallback and two `scripts/repair-shell.test.ts` cases.

---

## File Map

### New production files

- `services/telegram-userbot/analysis_export.py` — normalize and paginate authorized-account, dialog and message data from the proxy's existing Telethon client.
- `scripts/contact-analysis/types.ts` — canonical Zod schemas and shared TypeScript types.
- `scripts/contact-analysis/state.ts` — private account-namespaced job state, locking and atomic checkpoints.
- `scripts/contact-analysis/telegram-client.ts` — loopback bearer client for the three read-only proxy endpoints.
- `scripts/contact-analysis/model.ts` — reusable provider model plus structured streaming call.
- `scripts/contact-analysis/analyzer.ts` — skill selection, chronological chunk analysis and evidence validation.
- `scripts/contact-analysis/reducer.ts` — single-writer Markdown card merge, temporal facts and reciprocal wikilinks.
- `scripts/contact-analysis/coordinator.ts` — dialog inventory, three-chat worker pool, retries, reduction and reporting.
- `scripts/contact-analysis.ts` — `sync` and `status` command entrypoint.
- `agent/schedules/telegram-contact-sync.ts` — thin 15-minute automatic trigger.
- `agent/skills/telegram-person-profile/SKILL.md` — private-dialog/person extraction procedure.
- `agent/skills/telegram-group-profile/SKILL.md` — group extraction procedure.
- `agent/skills/telegram-channel-profile/SKILL.md` — channel extraction procedure.

### Modified production files

- `services/telegram-userbot/serve.py` — register the read routes behind existing bearer and connection middleware.
- `agent/provider.ts` and `agent/agent.ts` — expose and reuse one text-model factory for root Iva and contact analysis.
- `agent/lib/schedule-paths.ts` — define the contact-analysis command, lock, timeout and guard interval.
- `agent/skills/telegram-userbot/SKILL.md` — start the pipeline immediately after successful authorization.
- `agent/instructions/10-map.md` — name the three new skills and owner/contact graph paths.
- `scripts/coverage-policy.test.ts` — update the exact authored TypeScript inventory after adding nine production `.ts` paths.
- `docs/userbot.md`, `docs/memory.md`, `docs/extending.md`, `README.md` and `README.ru.md` — document the automatic read-only graph and its privacy boundary.

### New tests

- `services/telegram-userbot/test_analysis_export.py`
- `scripts/contact-analysis/types.test.ts`
- `scripts/contact-analysis/state.test.ts`
- `scripts/contact-analysis/telegram-client.test.ts`
- `scripts/contact-analysis/model.test.ts`
- `scripts/contact-analysis/analyzer.test.ts`
- `scripts/contact-analysis/reducer.test.ts`
- `scripts/contact-analysis/coordinator.test.ts`
- `scripts/contact-analysis-entrypoint.test.ts`
- `agent/schedules/telegram-contact-sync.test.ts`

---

### Task 1: Normalize Telegram read data inside the sole session owner

**Files:**

- Create: `services/telegram-userbot/analysis_export.py`
- Create: `services/telegram-userbot/test_analysis_export.py`
- Modify: `services/telegram-userbot/serve.py`

**Interfaces:**

- Consumes: the existing live Telethon client created once in `serve.py`.
- Produces:
  - `async account_payload(client) -> dict`
  - `async dialogs_payload(client, offset: int, limit: int) -> dict`
  - `async messages_payload(client, chat_id: int, after_id: int, limit: int) -> dict`
  - GET `/analysis/v1/account`
  - GET `/analysis/v1/dialogs?offset=<n>&limit=<1..100>`
  - GET `/analysis/v1/messages?chat_id=<id>&after_id=<id>&limit=<1..200>`

- [ ] **Step 1: Write failing normalization and pagination tests**

Use fake async Telethon objects. Assert that dialogs classify `private`, `group`, `channel` and
`bot`; messages are oldest-first and expose only bounded fields:

```python
class FakeMessage:
    id = 12
    sender_id = 44
    date = datetime(2026, 8, 7, tzinfo=timezone.utc)
    raw_text = "hello @owner"
    reply_to_msg_id = 9
    voice = None
    video_note = None
    photo = None
    document = None

self.assertEqual(
    payload["messages"][0],
    {
        "id": 12,
        "senderId": 44,
        "timestamp": "2026-08-07T00:00:00+00:00",
        "text": "hello @owner",
        "replyToMessageId": 9,
        "mentionedUserIds": [],
        "mentionedUsernames": ["owner"],
        "mediaKind": None,
    },
)
```

- [ ] **Step 2: Run the Python test and confirm RED**

Run: `python3 -m unittest services/telegram-userbot/test_analysis_export.py -v`

Expected: import failure for `analysis_export`.

- [ ] **Step 3: Implement bounded pure helpers**

Implement constants and validation without filesystem or shell inputs:

```python
MAX_DIALOG_LIMIT = 100
MAX_MESSAGE_LIMIT = 200

def bounded_int(raw: str, *, name: str, minimum: int, maximum: int) -> int:
    if not re.fullmatch(r"-?\d+", raw):
        raise ValueError(f"{name} must be an integer")
    value = int(raw)
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} out of range")
    return value
```

Use `client.iter_dialogs(limit=offset + limit)` and slice the normalized result for deterministic
pagination. Use `client.iter_messages(chat_id, min_id=after_id, reverse=True, limit=limit)` so pages
are chronological. Extract explicit `MessageEntityMentionName.user_id` and textual
`MessageEntityMention` usernames; do not resolve a plain name to a user.

- [ ] **Step 4: Register routes behind existing middleware**

Add Starlette route handlers before `mcp.streamable_http_app()` is served. Return 400 for invalid
parameters, 409 when unauthorized and sanitized 502 for Telethon failures. The existing
`BearerAuthMiddleware` must remain outermost, so unauthenticated requests fail before touching the
client.

- [ ] **Step 5: Verify GREEN and existing proxy behavior**

Run:

```bash
python3 -m unittest services/telegram-userbot/test_analysis_export.py services/telegram-userbot/test_health.py services/telegram-userbot/test_guardrails.py -v
```

Expected: all tests pass; no real Telegram connection is attempted.

### Task 2: Define strict observations and reusable model construction

**Files:**

- Create: `scripts/contact-analysis/types.ts`
- Create: `scripts/contact-analysis/types.test.ts`
- Create: `scripts/contact-analysis/model.ts`
- Create: `scripts/contact-analysis/model.test.ts`
- Modify: `agent/provider.ts`
- Modify: `agent/agent.ts`

**Interfaces:**

- Produces:
  - `ChatKindSchema` and `type ChatKind = "private" | "group" | "channel" | "bot"`
  - `TelegramDialogSchema`, `TelegramMessageSchema`
  - `ObservationPredicateSchema`
  - `ObservationSchema`, `AnalysisBatchSchema`
  - `canonicalUserId(id: number): string`
  - `canonicalChatId(id: number): string`
  - `canonicalMessageId(chatId: number, messageId: number): string`
  - `createTextModel(modelName?: string): LanguageModel`
  - `analyzeStructured(input: ModelAnalysisInput): Promise<AnalysisBatch>`

- [ ] **Step 1: Write schema tests**

Cover accepted evidence and rejection of unknown predicates, empty evidence, overlong values and
unsafe IDs:

```ts
assert.equal(canonicalUserId(44), "telegram:user:44");
assert.equal(canonicalMessageId(-1001, 9), "telegram:message:-1001:9");
assert.equal(
  ObservationSchema.safeParse({
    subjectId: "telegram:user:44",
    kind: "fact",
    predicate: "role",
    value: "backend developer",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence: [
      { chatId: -1001, messageId: 9, timestamp: "2026-08-07T00:00:00Z" },
    ],
  }).success,
  true,
);
```

Initial predicates are exactly `display_name`, `username`, `relationship`, `role`, `member_of`,
`works_on`, `communication_style`, `commitment`, `preference`, `owner_mention` and
`external_owner_claim`.

- [ ] **Step 2: Run schema tests and confirm RED**

Run: `node --test scripts/contact-analysis/types.test.ts`

Expected: module-not-found for `types.ts`.

- [ ] **Step 3: Implement strict Zod schemas**

Use `z.strictObject`, integer IDs, ISO datetime validation, `.max(500)` observation values,
`.max(32)` observations per model call and `.max(4000)` rolling summaries. Require exactly one of
`value` or `objectId` and require `assertedById` for `external_owner_claim`.

- [ ] **Step 4: Extract the existing root model factory**

Move the provider branch currently in `agent/agent.ts` into:

```ts
export function createTextModel(modelName = providerConfig.textModel) {
  const base =
    providerName === "codex"
      ? makeCodexModel(modelName)
      : createOpenAICompatible({
          name: `iva-${providerName}`,
          baseURL: providerConfig.baseURL,
          apiKey: providerConfig.apiKey,
          includeUsage: true,
        })(modelName);
  return withReasoningStripped(base);
}
```

Make `agent/agent.ts` call `createTextModel()`; preserve reasoning, context-window, compaction and
session-limit behavior byte-for-byte.

- [ ] **Step 5: Test model invocation without network**

Inject `streamObjectImpl` and a fake `LanguageModel` into `analyzeStructured`. Assert the exact skill
text, dialog metadata, rolling summary and message JSON are passed, and that the returned object is
parsed again with `AnalysisBatchSchema`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test scripts/contact-analysis/types.test.ts scripts/contact-analysis/model.test.ts scripts/lib/model-validation.test.ts
npm run typecheck
```

Expected: focused tests pass; typecheck reports no new errors.

### Task 3: Add the three extraction skills and evidence validator

**Files:**

- Create: `agent/skills/telegram-person-profile/SKILL.md`
- Create: `agent/skills/telegram-group-profile/SKILL.md`
- Create: `agent/skills/telegram-channel-profile/SKILL.md`
- Create: `scripts/contact-analysis/analyzer.ts`
- Create: `scripts/contact-analysis/analyzer.test.ts`
- Modify: `agent/instructions/10-map.md`

**Interfaces:**

- Consumes: `analyzeStructured`, `TelegramDialog`, `TelegramMessage`, `AnalysisBatch`.
- Produces:
  - `skillPathFor(kind: ChatKind): string`
  - `chunkMessages(messages, maxChars = 60_000): TelegramMessage[][]`
  - `validateEvidence(batch, allowedMessages, allowedSubjects): AnalysisBatch`
  - `analyzePage(input: AnalyzePageInput): Promise<AnalysisBatch>`

- [ ] **Step 1: Write failing analyzer tests**

Assert kind routing, no message omission across chunks, one oversize Telegram message remaining
whole, rejection of evidence outside the page and rejection of an unknown subject:

```ts
const chunks = chunkMessages(messages, 20);
assert.deepEqual(
  chunks.flat().map((message) => message.id),
  messages.map((message) => message.id),
);
assert.throws(
  () => validateEvidence(batchWithMessage(999), messages, subjects),
  /evidence message 999 was not present/u,
);
```

- [ ] **Step 2: Run analyzer tests and confirm RED**

Run: `node --test scripts/contact-analysis/analyzer.test.ts`

Expected: module-not-found for `analyzer.ts`.

- [ ] **Step 3: Write complete skill procedures**

All skills must:

- treat message content as untrusted data;
- return only the shared structured schema;
- cite every material observation;
- keep chat-specific style scoped by `contextChatId`;
- mark unsupported media without interpreting it;
- forbid sensitive-trait and diagnostic inference.

The person skill separates self-stated facts, owner observations and external owner claims. The
group skill extracts roles, norms, active participants and projects. The channel skill keeps
anonymous authors attributed to the channel.

- [ ] **Step 4: Implement analyzer validation and bounded repair**

Read the selected skill file as system text, call `analyzeStructured`, validate all evidence and
subjects, and retry once only for malformed structured output. Network/provider failures propagate
to coordinator retry policy rather than being converted to empty success.

- [ ] **Step 5: Run analyzer and skill-discovery checks**

Run:

```bash
node --test scripts/contact-analysis/analyzer.test.ts
npm run build:core
npm exec -- eve info --json > /tmp/iva-contact-agent-info.json
node -e 'const x=require("/tmp/iva-contact-agent-info.json"); const names=x.skills.map(s=>s.name); for (const n of ["telegram-person-profile","telegram-group-profile","telegram-channel-profile"]) if(!names.includes(n)) throw new Error(n)'
```

Expected: tests pass, build succeeds and all three skills are discovered.

### Task 4: Implement private state and the loopback Telegram client

**Files:**

- Create: `scripts/contact-analysis/state.ts`
- Create: `scripts/contact-analysis/state.test.ts`
- Create: `scripts/contact-analysis/telegram-client.ts`
- Create: `scripts/contact-analysis/telegram-client.test.ts`

**Interfaces:**

- Produces:
  - `ContactAnalysisStateSchema`
  - `statePaths(root, dataDir, accountUserId)`
  - `loadState(paths): Promise<ContactAnalysisState>`
  - `saveState(paths, state): Promise<void>`
  - `withPipelineLock(paths, fn): Promise<T>`
  - `createTelegramAnalysisClient(options): TelegramAnalysisClient`
  - client methods `account()`, `dialogs(offset, limit)`, `messages(chatId, afterId, limit)`.

- [ ] **Step 1: Write failing state tests**

Test a missing first-run state, `0600` atomic save, corrupt-file quarantine, exclusive lock, account
namespace separation and schema rejection. The job schema contains `chatId`, `kind`, `title`,
`committedThrough`, `contextSummary`, `status`, `attempts` and `lastErrorCode`; it never stores message
text.

- [ ] **Step 2: Write failing HTTP client tests**

Inject `fetchImpl` and assert loopback URL construction, bearer header, query encoding, response
schema parsing, timeout and sanitized errors. Assert an error never includes the bearer or response
message text.

- [ ] **Step 3: Run both tests and confirm RED**

Run:

```bash
node --test scripts/contact-analysis/state.test.ts scripts/contact-analysis/telegram-client.test.ts
```

Expected: both implementation modules are missing.

- [ ] **Step 4: Implement state using existing JSON primitives**

Reuse `loadJsonStrict`, `saveJsonAtomic`, `acquireLock` and `releaseLock`. After writes, apply `chmod`
to `0600`; create account and job directories with `0700`. Validate parsed data with Zod after every
load. A schema failure quarantines the state and throws; it must not return an empty import.

- [ ] **Step 5: Implement the HTTP client**

Read the proxy token from `data/telegram-userbot.token` at call time, use only
`http://127.0.0.1:${TELEGRAM_MCP_PORT}`, cap each request with `AbortSignal.timeout(30_000)` and parse
all payloads through Task 2 schemas.

- [ ] **Step 6: Verify GREEN**

Run the two tests again. Expected: all pass with no network access.

### Task 5: Build the single-writer Markdown graph reducer

**Files:**

- Create: `scripts/contact-analysis/reducer.ts`
- Create: `scripts/contact-analysis/reducer.test.ts`

**Interfaces:**

- Consumes: validated `AnalysisBatch`, dialog/entity descriptors and existing vault cards.
- Produces:
  - `contactCardPath(vault, userId): string`
  - `chatCardPath(vault, dialog): string`
  - `observationId(observation): string`
  - `reduceBatch(input: ReduceBatchInput): Promise<ReduceResult>`

- [ ] **Step 1: Write a fixture-vault RED test**

Create one owner, one peer and two groups in a temporary vault. Reduce observations in a deliberately
interleaved order and assert:

```ts
assert.match(peerCard, /telegram_user_id: "44"/u);
assert.match(peerCard, /\[\[cards\/notes\/telegram-group-1001\|/u);
assert.match(groupCard, /\[\[cards\/contacts\/telegram-user-44\|/u);
assert.doesNotMatch(core, /technical lead/u);
assert.equal(count(peerCard, "telegram:message:-1001:9"), 1);
```

Also assert display-name changes preserve `telegram-user-44.md`, repeated batches are idempotent,
external owner claims remain attributed and a changed single-valued identity attribute moves the old
value into `## History`.

- [ ] **Step 2: Run reducer tests and confirm RED**

Run: `node --test scripts/contact-analysis/reducer.test.ts`

Expected: module-not-found for `reducer.ts`.

- [ ] **Step 3: Implement stable paths and managed sections**

Use exact paths:

```ts
join(vault, "cards", "contacts", `telegram-user-${userId}.md`);
join(
  vault,
  "cards",
  "notes",
  `telegram-${dialog.kind}-${Math.abs(dialog.id)}.md`,
);
```

Preserve frontmatter fields and all user-authored content outside
`<!-- iva:telegram-graph:start -->` / `<!-- iva:telegram-graph:end -->`. Render observation bullets
with deterministic SHA-256 IDs, confidence and evidence references. Parse only the owned region on
the next run.

- [ ] **Step 4: Implement temporal and reciprocal merges**

Single-valued `display_name` and `username` observations supersede by subject/predicate. Contextual
roles and styles key by subject/predicate/chat. Commitments key by evidence. Write both sides of
person↔group and person/project edges in one reducer operation. Use existing `parseFrontmatter`,
`writeFrontmatter`, `acquireLock` and `atomicWrite`; acquire multiple card locks in lexical path order.

- [ ] **Step 5: Verify graph output**

Run:

```bash
node --test scripts/contact-analysis/reducer.test.ts
uv run scripts/autograph/graph.py health <fixture-vault> <fixture-vault>/schema.json
```

Expected: reducer tests pass, no broken links are introduced and owner observations never touch
`CORE.md`.

### Task 6: Orchestrate full and incremental imports with three chat workers

**Files:**

- Create: `scripts/contact-analysis/coordinator.ts`
- Create: `scripts/contact-analysis/coordinator.test.ts`

**Interfaces:**

- Consumes: Telegram analysis client, state store, `analyzePage`, `reduceBatch`.
- Produces:
  - `runContactAnalysis(options): Promise<ContactAnalysisReport>`
  - `runWorkerPool<T>(items, concurrency: 3, worker): Promise<SettledItem<T>[]>`
  - report fields `completedChats`, `pendingChats`, `blockedChats`, `failedChats`,
    `processedMessages`, `unsupportedMedia`.

- [ ] **Step 1: Write the concurrency and resume RED test**

Use a fake Telegram client with five chats. Track active chat IDs and per-chat page order:

```ts
assert.equal(maxConcurrentChats, 3);
assert.deepEqual(pageOrder.get(1001), [1, 2, 3]);
assert.equal(reducerMaxConcurrency, 1);
```

Inject a crash after analysis of chat 1001 page 2 but before reduction. Resume and assert page 2 may
be analyzed again, is reduced exactly once, and `committedThrough` advances only after the durable
reduce call.

- [ ] **Step 2: Add failure-isolation tests**

Assert a malformed model batch retries once then marks only that chat failed; a 409 authorization
loss blocks the account run; one inaccessible chat releases its slot; a changed account ID creates a
separate namespace and never reuses another account's cursors.

- [ ] **Step 3: Run coordinator tests and confirm RED**

Run: `node --test scripts/contact-analysis/coordinator.test.ts`

Expected: module-not-found for `coordinator.ts`.

- [ ] **Step 4: Implement inventory and the fixed worker pool**

Inventory all dialog pages until `nextOffset` is null. Sort jobs by dialog ID for deterministic test
ordering, then run exactly three async worker loops over one shared index. A worker fetches
`after_id=committedThrough`, analyzes pages sequentially and enqueues each validated batch to one
promise-chain reducer.

- [ ] **Step 5: Implement checkpoint and retry semantics**

Persist job state after inventory, after a sanitized failure and after each successful reduction.
Use exponential transient retries of 1s, 2s and 4s, while honoring explicit FloodWait seconds when
the proxy returns them. Do not retry validation or authorization errors beyond the analyzer's one
format-repair attempt.

- [ ] **Step 6: Verify GREEN**

Run: `node --test scripts/contact-analysis/coordinator.test.ts`

Expected: all concurrency, resume and failure-isolation cases pass.

### Task 7: Add the command, automatic schedule and post-login trigger

**Files:**

- Create: `scripts/contact-analysis.ts`
- Create: `scripts/contact-analysis-entrypoint.test.ts`
- Create: `agent/schedules/telegram-contact-sync.ts`
- Create: `scripts/telegram-contact-sync-schedule.test.ts`
- Modify: `agent/lib/schedule-paths.ts`
- Modify: `agent/skills/telegram-userbot/SKILL.md`

**Interfaces:**

- `node --env-file-if-exists=.env scripts/contact-analysis.ts sync`
- `node --env-file-if-exists=.env scripts/contact-analysis.ts status`
- `contactAnalysisJob()` for the schedule runner.

- [ ] **Step 1: Write entrypoint and schedule RED tests**

Assert `status` performs no model or Telegram call, `sync` refuses unless
`TELEGRAM_EXPOSED_TOOLS=read-only`, and the schedule is exactly `*/15 * * * *`. Assert the job uses
`.contact-analysis.lock`, a 24-hour timeout, a 10-minute success guard and the shared status file.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node --test scripts/contact-analysis-entrypoint.test.ts scripts/telegram-contact-sync-schedule.test.ts
```

Expected: missing entrypoint and schedule modules.

- [ ] **Step 3: Implement command modes**

`status` reads validated state and prints counts only. `sync` acquires the pipeline lock, verifies
read-only mode, runs the coordinator and prints JSON or compact text selected by `--json`. Errors
must contain codes and counts, never message bodies, credentials or usernames.

- [ ] **Step 4: Implement the thin schedule**

Use `defineSchedule`, call `runScheduledJob(contactAnalysisJob())`, and keep all readiness and import
logic in the script. The lock prevents overlap between schedule and manual execution.

- [ ] **Step 5: Trigger immediately after QR authorization**

Update the userbot skill's `authorized` branch to run:

```bash
node --env-file-if-exists=.env scripts/contact-analysis.ts sync
```

Explain that failure does not invalidate Telegram login because the 15-minute schedule resumes the
same checkpoints.

- [ ] **Step 6: Verify command and schedule**

Run the focused tests and `npm run build:core`. Expected: tests and build pass, and Eve discovers six
schedules total.

### Task 8: Update documentation and coverage inventory

**Files:**

- Modify: `docs/userbot.md`
- Modify: `docs/memory.md`
- Modify: `docs/extending.md`
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `scripts/coverage-policy.test.ts`

**Interfaces:** Documentation only; no behavior changes.

- [ ] **Step 1: Update affected documentation**

Document: automatic full first import, three-chat concurrency, incremental cursors, owner profile,
message provenance, read-only requirement, unsupported voice/video and where to run `sync`/`status`.
Do not claim live import validation unless it actually occurred.

- [ ] **Step 2: Update the exact production inventory**

The nine planned production TypeScript paths raise the count from 142 to 151. Set:

```ts
const EXPECTED_PRODUCTION_COUNT = 151;
const EXPECTED_INVENTORY_SHA256 =
  "8c31566f93801e3a5220f8f9124b5c29150237499ecdfda4377b78e81046288f";
```

Add the new schedule to the measured framework-boundary blind-spot list only if the fresh coverage
report confirms it is unreported; otherwise leave that measured list unchanged and update its count
assertion only from measured evidence.

- [ ] **Step 3: Check Markdown and inventory**

Run:

```bash
npx prettier --check README.md README.ru.md docs/userbot.md docs/memory.md docs/extending.md docs/superpowers/specs/2026-08-07-telegram-contact-graph-design.md docs/superpowers/plans/2026-08-07-telegram-contact-graph.md
node --test scripts/coverage-policy.test.ts
git diff --check
```

Expected: all checks pass.

### Task 9: Fresh verification and review

**Files:** All files changed by Tasks 1–8.

**Interfaces:** Produces the evidence needed to claim local completion; no publication.

- [ ] **Step 1: Run focused feature suites**

```bash
python3 -m unittest services/telegram-userbot/test_analysis_export.py services/telegram-userbot/test_health.py services/telegram-userbot/test_guardrails.py -v
node --test scripts/contact-analysis/*.test.ts scripts/contact-analysis-entrypoint.test.ts scripts/telegram-contact-sync-schedule.test.ts
```

Expected: all new and directly related tests pass.

- [ ] **Step 2: Run static checks and required authored build**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Expected: all commands pass. The full `npm run build` is mandatory because `agent/` changed.

- [ ] **Step 3: Run coverage and full tests**

```bash
npm run test:coverage
npm test
```

Expected: coverage thresholds pass; every feature test passes. Compare any full-suite failures with
the recorded clean-main baseline rather than claiming the repository is fully green.

- [ ] **Step 4: Run security and repository-data checks**

```bash
npm run test:security
git ls-files | rg '(^|/)(data|attachments|vault|memory)/|(^|/)\.env($|\.)' && exit 1 || true
rg -n '/Users/|/home/[^/]+|api_hash|TELEGRAM_MCP_TOKEN|BEGIN .*PRIVATE KEY' agent scripts services docs README.md README.ru.md
```

Expected: security tests pass; no private runtime file, machine-specific path or credential value is
tracked. Variable names in documentation/source are allowed after manual inspection.

- [ ] **Step 5: Review the complete diff**

Inspect `git diff --stat`, `git diff --check` and the full diff. Verify no Telegram write method is
reachable, every model-derived fact has evidence, reducer writes are bounded to the vault, and no
claim exceeds the fresh verification evidence.

- [ ] **Step 6: Stop at the authorized boundary**

Report local files, checks, the three pre-existing baseline failures if they remain, and the fact
that no real Telegram account import, commit, push or deployment occurred. Await separate user
authorization for any Git publication or live-account run.
