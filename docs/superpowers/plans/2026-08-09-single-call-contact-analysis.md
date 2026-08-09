# Single-call Telegram Contact Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analyze each Telegram chat with zero or one LLM request per sync, using the newest messages that fit the configured context, and create one answerable Markdown worksheet from evidence-bound model questions.

**Architecture:** The read-only Telethon sidecar returns a newest-first bounded unseen-message window plus a durable newest cursor and skipped count. TypeScript computes a conservative character budget from the configured context, invokes the existing per-chat skill exactly once, validates observations and questions against the same input evidence, serially writes graph changes and a managed question worksheet, then advances the checkpoint.

**Tech Stack:** TypeScript ESM, Node test runner, Zod, AI SDK structured output, Python 3, Telethon, Markdown vault, Docker Compose.

## Global Constraints

- At most one model request per chat per sync; zero requests when no unseen message fits.
- Process at most three chats concurrently and keep graph/workbook writes single-writer.
- Prefer the newest complete unseen messages and restore chronological order before the model call.
- Never store message bodies in checkpoints or logs.
- Keep Telegram access read-only and bearer-protected.
- Do not interpret voice messages or ingest worksheet answers in this change.
- Advance a chat checkpoint only after all durable reducers succeed.

---

### Task 1: Bounded newest-message export

**Files:**

- Modify: `services/telegram-userbot/analysis_export.py`
- Test: `services/telegram-userbot/test_analysis_export.py`

**Interfaces:**

- Consumes: Telethon `get_messages(chat_id, min_id, limit=0)` total and `iter_messages(chat_id, min_id, reverse=False)`.
- Produces: `message_window_payload(client, *, chat_id: int, after_id: int, max_chars: int) -> dict` with `messages`, `latestMessageId`, and `skippedMessages`; GET `/analysis/v1/message-window`.

- [ ] **Step 1: Write failing export tests**

Add a fake newest-first iterator and assertions equivalent to:

```python
payload = await message_window_payload(
    FakeClient(), chat_id=-1001, after_id=10, max_chars=250
)
self.assertEqual([item["id"] for item in payload["messages"]], [12, 13])
self.assertEqual(payload["latestMessageId"], 15)
self.assertEqual(payload["skippedMessages"], 2)
```

Also assert `/analysis/v1/message-window` rejects `max_chars=0` and values above `500000` with sanitized HTTP 400.

- [ ] **Step 2: Verify RED**

Run: `python3 -m unittest services/telegram-userbot/test_analysis_export.py`

Expected: FAIL because `message_window_payload` and the route do not exist.

- [ ] **Step 3: Implement the bounded export**

Add constants and a helper with this contract:

```python
MAX_WINDOW_CHARS = 500_000

async def message_window_payload(client, *, chat_id, after_id, max_chars):
    total = int((await client.get_messages(chat_id, min_id=after_id, limit=0)).total)
    selected = []
    used = 0
    latest_message_id = after_id
    async for message in client.iter_messages(chat_id, min_id=after_id, reverse=False):
        payload = _message_payload(message)
        latest_message_id = max(latest_message_id, payload["id"])
        size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        if size > max_chars - used:
            break
        selected.append(payload)
        used += size
    selected.reverse()
    return {
        "messages": selected,
        "latestMessageId": latest_message_id,
        "skippedMessages": max(0, total - len(selected)),
    }
```

Register the bearer-gated GET route and parse `chat_id`, `after_id`, and `max_chars` with `parse_bounded_int`.

- [ ] **Step 4: Verify GREEN**

Run: `python3 -m unittest services/telegram-userbot/test_analysis_export.py`

Expected: all export tests PASS.

- [ ] **Step 5: Commit**

Commit the Python implementation and tests with a descriptive Conventional Commit message.

### Task 2: Context budget and TypeScript client

**Files:**

- Create: `scripts/contact-analysis/context-budget.ts`
- Create: `scripts/contact-analysis/context-budget.test.ts`
- Modify: `scripts/contact-analysis/telegram-client.ts`
- Modify: `scripts/contact-analysis/telegram-client.test.ts`

**Interfaces:**

- Consumes: `OPENCODE_CONTEXT_WINDOW`, selected skill text, rolling summary and dialog envelope.
- Produces: `messageCharacterBudget(input): number` and `TelegramAnalysisClient.messageWindow(chatId, afterId, maxChars)`.

- [ ] **Step 1: Write failing budget and client tests**

Test exact invariants:

```ts
assert.equal(
  messageCharacterBudget({
    contextTokens: 131_072,
    skillChars: 4_000,
    envelopeChars: 2_000,
  }),
  320_000,
);
await client.messageWindow(-1001, 8, 320_000);
assert.equal(
  requestUrl,
  "http://telegram-userbot:8724/analysis/v1/message-window?chat_id=-1001&after_id=8&max_chars=320000",
);
```

Also reject unsafe context sizes and malformed response fields.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/contact-analysis/context-budget.test.ts scripts/contact-analysis/telegram-client.test.ts`

Expected: FAIL because the budget module and client method do not exist.

- [ ] **Step 3: Implement deterministic budgeting and transport**

Use explicit constants for output reserve, safety reserve, and three conservative characters per token. Clamp the result to `[1, 500000]`. Add strict Zod response parsing:

```ts
const MessageWindowSchema = z.strictObject({
  messages: z.array(TelegramMessageSchema),
  latestMessageId: z.int().nonnegative(),
  skippedMessages: z.int().nonnegative(),
});
```

Keep the existing loopback fallback and the already-fixed `TELEGRAM_MCP_URL` origin behavior.

- [ ] **Step 4: Verify GREEN**

Run the two focused test files and expect all tests PASS.

- [ ] **Step 5: Commit**

Commit budget and transport changes with their tests.

### Task 3: Evidence-bound questions and one model call

**Files:**

- Modify: `scripts/contact-analysis/types.ts`
- Modify: `scripts/contact-analysis/types.test.ts`
- Modify: `scripts/contact-analysis/analyzer.ts`
- Modify: `scripts/contact-analysis/analyzer.test.ts`
- Modify: `agent/skills/telegram-person-profile/SKILL.md`
- Modify: `agent/skills/telegram-group-profile/SKILL.md`
- Modify: `agent/skills/telegram-channel-profile/SKILL.md`

**Interfaces:**

- Produces: `ClarificationQuestionSchema`, `AnalysisBatch.questions`, and one-call `analyzePage`.

- [ ] **Step 1: Write failing schema/analyzer tests**

Define expected data:

```ts
const question = {
  schemaVersion: 1,
  subjectId: "telegram:user:44",
  question: "What role does this person have in the Iva project?",
  reason: "The messages mention work but not the role.",
  contextChatId: -1001,
  evidence: [
    { chatId: -1001, messageId: 9, timestamp: messages[0]!.timestamp },
  ],
};
```

Assert unknown subjects, mismatched chats and absent evidence are rejected. Pass messages larger than the former 60000-character chunk size and assert `analyzeStructuredImpl` is called exactly once. Return malformed structured output and assert there is no repair call.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/contact-analysis/types.test.ts scripts/contact-analysis/analyzer.test.ts`

Expected: FAIL on the absent schema and the current chunk loop/retry.

- [ ] **Step 3: Implement question validation and single-call analysis**

Add a bounded `questions` array (maximum 16) to `AnalysisBatchSchema` and `AnalysisPageSchema`. Reuse a shared evidence-validation helper for observations and questions. Replace the chunk loop and format-repair wrapper with one direct structured call. Update all three skills to ask only useful ambiguity-resolving questions and prohibit sensitive-trait questions or copied instructions.

- [ ] **Step 4: Verify GREEN**

Run focused schema/analyzer tests and expect PASS with exactly one model invocation.

- [ ] **Step 5: Commit**

Commit schema, analyzer, skill and test changes.

### Task 4: Managed Markdown question worksheet

**Files:**

- Create: `scripts/contact-analysis/question-workbook.ts`
- Create: `scripts/contact-analysis/question-workbook.test.ts`

**Interfaces:**

- Consumes: validated `ClarificationQuestion[]`, dialog and vault path.
- Produces: `updateQuestionWorkbook(input): Promise<{ file: string; questionIds: string[] }>` at `vault/inbox/contact-analysis-questions.md`.

- [ ] **Step 1: Write failing workbook tests**

Assert that two chat batches produce grouped Markdown, repeated questions deduplicate by stable ID, and owner text after `**Answer:**` survives a later update byte-for-byte. Assert model strings cannot terminate the managed region.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/contact-analysis/question-workbook.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the single-writer workbook reducer**

Use stable SHA-256 IDs over canonical validated question JSON, private directory creation, the existing card-store atomic write helper, and explicit managed markers. Render grouped chat headings and this answer shape:

```markdown
### Question 1

<validated question>

**Answer:**

<!-- write here -->
```

Preserve all content outside managed markers and preserved answer bodies associated with stable IDs.

- [ ] **Step 4: Verify GREEN**

Run the workbook tests and expect PASS.

- [ ] **Step 5: Commit**

Commit the reducer and tests.

### Task 5: Coordinator, checkpoints and report

**Files:**

- Modify: `scripts/contact-analysis/state.ts`
- Modify: `scripts/contact-analysis/state.test.ts`
- Modify: `scripts/contact-analysis/coordinator.ts`
- Modify: `scripts/contact-analysis/coordinator.test.ts`
- Modify: `scripts/contact-analysis.ts`
- Modify: `scripts/contact-analysis-entrypoint.test.ts`

**Interfaces:**

- Consumes: `messageCharacterBudget`, `client.messageWindow`, one-call `analyzePage`, graph reducer and workbook reducer.
- Produces: cumulative job `skippedMessages`, report `processedMessages`, `skippedMessages`, `generatedQuestions`.

- [ ] **Step 1: Write failing coordinator/state tests**

Assert five chats execute with maximum concurrency three, exactly one analysis call per nonempty chat, one message-window read per chat, serial graph/workbook writes, and a durable cursor equal to `latestMessageId` only after both reducers succeed. Assert an empty window advances a valid newer cursor without a model call and records skipped messages. Update expected report objects with the two new counters.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/contact-analysis/state.test.ts scripts/contact-analysis/coordinator.test.ts scripts/contact-analysis-entrypoint.test.ts`

Expected: FAIL on missing state/report fields and the current page loop.

- [ ] **Step 3: Implement one-window coordination**

Read the selected skill once to compute the budget, call `messageWindow` once, analyze at most once, then enqueue one serial operation that writes graph and worksheet. Persist counters and cursor only after both writes. Keep isolated chat failures and the advisory lock unchanged. Extend compact output with `skipped_messages=<n> questions=<n>`.

- [ ] **Step 4: Verify GREEN**

Run the focused coordinator/state/entrypoint tests and expect PASS.

- [ ] **Step 5: Commit**

Commit coordination, state, reporting and tests.

### Task 6: Documentation, full verification and release

**Files:**

- Modify: `docs/userbot.md`
- Modify: `README.md` only if audit finds the documented product story inaccurate.

**Interfaces:**

- Produces: operator documentation and production evidence.

- [ ] **Step 1: Update operator documentation**

Document one call per chat per sync, newest-window truncation, skipped counters, worksheet location and the fact that answer ingestion is not implemented.

- [ ] **Step 2: Run fresh local verification**

Run:

```bash
python3 -m unittest services/telegram-userbot/test_analysis_export.py
node --test scripts/contact-analysis/*.test.ts scripts/contact-analysis-entrypoint.test.ts scripts/telegram-contact-sync-schedule.test.ts
npm run typecheck
npx prettier --check scripts/contact-analysis services/telegram-userbot docs/userbot.md
npm run build
python3 /Users/strongf/.codex/skills/beautify-github-readme/scripts/audit_readme.py README.md
```

Expected: every command exits 0; README audit either requires no change or produces a separately verified minimal correction.

- [ ] **Step 3: Review the complete diff and protected state**

Verify `git diff --check`, no secret/runtime file is tracked, `.env`, `data/`, and `vault/` remain ignored, and only intended source/docs/tests changed.

- [ ] **Step 4: Publish and merge**

Push `strongf/fix-contact-analysis-sidecar-url`, create a PR to protected `main`, monitor required checks, merge only when green, and verify `origin/main` contains the merged commit.

- [ ] **Step 5: Verify deployment**

Monitor the deployment until `/home/strongf/iva-runtime/deploy/current-image` references the merged SHA and all three Compose services are healthy on the immutable image.

- [ ] **Step 6: Run and observe production contact analysis**

Run the first manual `sync`, poll status/checkpoints without printing message bodies, verify reciprocal graph links and graph health, copy `vault/inbox/contact-analysis-questions.md` into the Codex workspace for attachment, then run a second incremental `sync`. Confirm zero pending jobs, no unexpected duplicate questions, and report exact completed/failed/skipped/message/question counters.
