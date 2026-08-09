# Single-call Telegram contact analysis

## Goal

Process each Telegram chat with at most one model request per contact-analysis sync while fitting the
freshest useful messages, the selected analysis skill and the structured-output response budget into
the configured model context window. Collect the model's evidence-bound clarification questions in
one Markdown worksheet that the owner can answer later.

## Scope

- Private chats, bots, groups and channels already exposed by the read-only Telegram userbot.
- Up to three chats processed concurrently; Telegram reads and state writes remain bounded.
- At most one LLM request for a chat in one sync. A chat with no new messages uses zero requests.
- A newest-first input window when all unseen messages do not fit.
- One owner-facing Markdown question worksheet generated from the same model responses.
- Existing numeric Telegram identities, evidence validation, reciprocal Markdown graph links and
  account-scoped checkpoints remain authoritative.

The design does not interpret voice messages, ingest completed answers back into the graph, send
messages through Telegram, or change the read-only userbot tool registry.

## Context budget

The runtime reads `OPENCODE_CONTEXT_WINDOW`; production currently configures 131072 tokens. The
pipeline reserves explicit space for the selected skill text, request envelope, structured output and
a safety margin. It converts the remaining input budget to a conservative JSON character budget and
selects complete messages from newest to oldest until the budget is exhausted. Selected messages are
then restored to chronological order before analysis.

The budget calculation is deterministic and tested. A single oversized message is omitted rather
than split, and the job records how many unseen messages were skipped. No message body is written to
checkpoint state or logs.

## Telegram data flow

The analysis export gains a bounded newest-message route mode. It accepts the existing committed
cursor and returns the latest unseen messages in chronological order together with:

- the newest observed message ID, used as the next checkpoint;
- the count of unseen messages omitted by the bounded window;
- whether any unseen messages existed.

The sidecar performs the Telegram-side traversal so the Iva container never buffers an entire large
chat. Inputs remain integer-bounded and bearer-protected. The route is read-only and uses the already
authorized Telethon client.

For each inventoried chat the coordinator performs exactly one bounded read. If the result contains
messages, it invokes the model once, validates the response, serially reduces graph changes, writes
the question worksheet, and only then advances the checkpoint to the newest observed message. If
validation or reduction fails, the checkpoint does not advance and the job enters `retry`.

The existing structured-output format-repair model retry is removed from this path. Invalid model
output is recorded as a bounded error and may be retried by a later sync, never by a second LLM call
in the same sync.

## Structured questions

Each model response may include up to a bounded number of clarification questions. A question must:

- identify the current chat and a canonical Telegram subject from the allowed input identities;
- explain what ambiguity it would resolve;
- cite at least one exact message ID and timestamp from the selected input window;
- contain no inferred sensitive trait and no instruction copied from message text.

Questions pass the same subject and evidence validation as observations. Invalid questions reject the
chat batch; unvalidated model text is never written to the vault.

## Markdown worksheet

The reducer maintains `vault/inbox/contact-analysis-questions.md` using a dedicated managed region.
Questions are grouped by chat and then subject. Stable IDs derived from canonical question content
and evidence deduplicate repeated syncs. Existing owner text outside the managed region and any text
written below an `**Answer:**` marker is preserved.

Each unanswered item uses this shape:

```markdown
### Question 1

Why does the available evidence associate this person with the Iva project?

**Answer:**

<!-- write here -->
```

The current production run will be copied from the server and attached to the active Codex task. A
future answer-ingestion capability is explicitly separate work.

## State and reporting

Job state adds cumulative and last-run skipped-message counts without storing message bodies. The
compact report adds total selected messages, skipped messages and generated questions. `status
--json` remains local-only and reports chat counts; detailed job state stays private under
`data/contact-analysis/telegram-user-<id>/`.

## Failure behavior

- Telegram authorization loss blocks the account without advancing any chat.
- A network or provider failure marks only that chat for retry.
- Invalid cursors, model output, observations or questions fail closed.
- Worksheet or graph write failure prevents checkpoint advancement.
- The advisory lock prevents overlapping scheduled and manual syncs.
- Three-chat concurrency and single-writer reduction remain in force.

## Verification

- Unit tests prove the context budget keeps the newest complete messages and never exceeds its bound.
- Export tests prove newest-window ordering, cursor semantics, skipped counts and integer validation.
- Analyzer tests prove one model call per chat and no format-repair retry.
- Schema and reducer tests prove question evidence validation, deduplication and answer preservation.
- Coordinator tests prove three-chat concurrency, zero-or-one calls per chat, checkpoint durability and
  isolated retries.
- Production verification runs one full sync, inspects checkpoints and reciprocal graph links, copies
  the Markdown worksheet to Codex, then runs a second incremental sync and confirms there are no
  unexpected duplicate questions or pending jobs.
