# Unified Read-Only Inbox Design

## Goal

Add an owner-only unified inbox pipeline that incrementally reads personal Telegram, Gmail inbox,
and Google Calendar context, normalizes the results, classifies actionable items with exact source
evidence, prepares meeting briefs and Gmail reply proposals, and produces a compact report envelope
for the owner's private bot chat.

This branch owns the complete collection-to-report pipeline and its local entry point. It exposes
ports for a later container scheduler, private-bot delivery, and relationship registry integration;
it does not wire those deployment concerns itself.

## Scope

In scope:

- incremental Telegram collection through the existing bearer-authenticated GET-only userbot proxy;
- incremental Gmail inbox and Calendar collection through `gws`, invoked with `execFile` and fixed
  allowlisted commands;
- a source-neutral, strictly validated observation schema with exact evidence references;
- private atomic state containing source cursors, normalized observations, and deduplication keys;
- evidence-constrained classification into `urgent`, `needs_reply`, `informational`, or `ignorable`;
- meeting preparation for upcoming Calendar events;
- safe Gmail reply proposals that remain internal data;
- a bounded, compact owner-private-bot report envelope;
- adapter interfaces for model judgment, relationship context, and report delivery;
- a local TypeScript entry point and mocked end-to-end tests.

Out of scope:

- Telegram sends, reactions, deletes, joins, invites, mark-read operations, or any other userbot
  mutation;
- sending Gmail messages, deleting Google data, or automatically creating Google Tasks;
- automatically creating Gmail drafts from proposals;
- scheduling, Containerfile or production maintenance changes;
- actual bot delivery, deployment, push, merge, or production validation;
- a second relationship/profile store.

## Design Principles

The implementation follows Iva's wheel principle. Deterministic guarantees live in small code:
identity, input validation, cursor movement, deduplication, atomic persistence, private file modes,
evidence linkage, command allowlists, and report bounds. Contextual judgment lives behind a model
port: priority classification, meeting notes, and suggested replies.

External messages are untrusted data. They are never treated as instructions, interpolated into a
shell, placed in an error message, or permitted to choose commands, paths, identifiers, or report
destinations.

## Architecture

The package lives under `scripts/unified-inbox/` and has the following boundaries:

1. `types.ts` defines strict Zod schemas and canonical ID helpers.
2. `state.ts` owns account-scoped private state, locking, atomic writes, schema validation, and
   quarantine of invalid state.
3. `telegram-source.ts` adapts the existing read-only analysis client to normalized source pages.
4. `google-source.ts` invokes only fixed Gmail-list/get and Calendar-list commands and validates
   every response before normalization.
5. `classifier.ts` defines the classifier port, validates model output, and rejects unknown or
   duplicate observation references.
6. `meeting-prep.ts` joins upcoming events to related observations and optional relationship
   context without creating another registry.
7. `report.ts` renders a bounded report and creates an owner-private delivery envelope.
8. `pipeline.ts` orchestrates collection, durable reduction, classification, meeting preparation,
   proposal generation, and report construction.
9. `scripts/unified-inbox.ts` is the TypeScript local entry point and composition root.

The composition root may use real source adapters, but tests inject in-memory implementations. No
new `.mjs` entry point is added.

## Data Model

### Normalized observation

Each observation contains:

- `schemaVersion: 1`;
- a canonical `id` derived from source, account, external object ID, and source revision;
- `source`: `telegram`, `gmail`, or `calendar`;
- `sourceAccountId` and opaque `externalId`;
- `kind`: `message` or `event`;
- source timestamp and optional update timestamp;
- bounded sender/participant labels, subject/title, and content excerpt;
- reply/thread metadata where the source provides it;
- exact evidence containing source, external ID, timestamp, and a safe human-readable locator;
- a source-specific cursor candidate supplied by its page.

Raw credentials and full provider responses are never persisted. Content fields are bounded by
Unicode code points. Provider identifiers remain opaque strings after schema validation.

### Classification

For each observation selected for the report, the classifier returns:

- one allowed category;
- a short rationale;
- evidence observation IDs;
- optional reply proposal fields only for Gmail `needs_reply` or `urgent` messages.

Every evidence ID must exist in the exact input batch. Unknown IDs, duplicates, missing evidence,
category mismatches, oversized output, or a proposal targeting a non-Gmail observation reject the
entire classifier result before persistence or reporting.

### Meeting brief

An upcoming Calendar event produces a brief containing the event evidence, bounded attendee labels,
related recent observations, optional relationship context, open commitments/questions drawn only
from supplied evidence, and suggested preparation points. Relationship information is consumed
through `RelationshipContextProvider`; the default provider returns no extra context.

### Private state

State is rooted at `${ASSISTANT_DATA_DIR}/unified-inbox/` (or `data/unified-inbox/` for a
single-user installation). The directory and state file use `0700` and `0600` modes. Multi-user
workers already point `ASSISTANT_DATA_DIR` at their personal runtime, so no global data is shared.

The schema stores:

- an owner/account identity that must match the current run;
- independent source cursors;
- normalized observations keyed by canonical ID;
- a bounded processed-identity ledger;
- the last successfully constructed report metadata.

Collection pages are reduced under one pipeline lock. A page cursor advances only in the same
atomic state commit that publishes every accepted observation and deduplication key from that page.
Overlapping retries are therefore idempotent. Invalid persisted state is quarantined and fails
closed rather than being silently overwritten.

Retention is deterministic: expired ignorable/informational observations are pruned by their
source timestamp, and expired observations that never entered the reporting window are pruned in
the same page commit. Actionable observations and evidence needed by the current reporting window
remain. No deletion is based on filesystem mtime. The pipeline lock refreshes its lease while
provider and model calls are in flight so another run cannot reclaim a live lock.

## Source Adapters

### Telegram

The adapter wraps the existing `TelegramAnalysisClient`. It uses only `account`, `dialogs`, and
`messages`, all of which map to bearer-authenticated GET requests. It neither extends the MCP
registry nor introduces a second Telethon client. Canonical Telegram observation IDs include the
numeric chat and message IDs. Pages remain sequential within a chat.

The pipeline is owner-only whenever multi-user mode is active. A non-owner run fails before the
proxy is contacted.

### Gmail

The adapter invokes `gws` without a shell. It supports only these fixed read operations:

- list inbox messages newer than or overlapping the persisted cursor;
- get the metadata and bounded body excerpt for returned message IDs.

The cursor is based on provider timestamps/history metadata carried by validated pages. Queries
overlap the previous boundary. Intermediate provider pages keep the retry-safe starting watermark;
only the final page advances it, so a later-page failure cannot skip older messages. Canonical
message IDs deduplicate replayed results. No send, reply, delete, modify, trash, label mutation, or
mark-read operation is present in the adapter.

Reply proposals are internal structured data. A future explicit Gmail draft writer can consume
them, but is not part of automatic pipeline execution.

### Calendar

The adapter invokes only Calendar event listing for a bounded look-back and look-ahead window. It
requests deleted events and emits local removal tombstones for cancelled event IDs without making
any Calendar mutation. It does not insert, update, delete, invite, or respond to events. Event
revisions produce stable canonical identities, while overlapping windows make changed events
visible without duplicates.

## Pipeline Flow

1. Resolve and validate the owner identity and private state path.
2. Acquire the account-scoped pipeline lock and load validated state.
3. Collect each source incrementally through its adapter.
4. Validate, normalize, and atomically reduce each source page before advancing its cursor.
5. Select at most 500 observations from the current reporting window, prioritizing previously
   actionable records and Calendar context before the newest remaining records. Report how many
   observations were deferred instead of passing an unbounded classifier input.
6. Validate classification evidence and build Gmail reply proposals.
7. Build briefs for upcoming meetings, consulting the optional relationship provider.
8. Render a compact report and create a delivery envelope whose target equals the owner ID and whose
   chat kind is `private`.
9. Persist successful report metadata and return the report/envelope to the caller.

One source failure does not fabricate empty success. The run records a sanitized source error and
may produce a clearly marked partial report from successfully committed sources. Authorization
loss, identity mismatch, corrupt state, invalid cursors, or invalid classifier evidence are fatal
and produce no delivery envelope.

## Report Contract

The report is ordered as:

1. urgent;
2. needs reply;
3. upcoming meeting preparation;
4. informational summary;
5. source-health/partial-run note.

Ignorable items are counted but omitted individually. Every actionable line includes a compact
source locator. Gmail proposals are visually separated from source text and never presented as
sent or saved. The renderer limits section counts and total Unicode code points so the later bot
adapter can deliver without unbounded splitting.

`PrivateInboxReportEnvelope` contains the owner chat ID, `chatKind: "private"`, generated timestamp,
report text, and structured report data. Construction rejects an empty owner ID or a destination
that differs from the authenticated owner.

## Error Handling and Privacy

- Zod validates all external payloads and model output.
- Source errors use fixed sanitized codes; message bodies, tokens, email addresses, and raw provider
  errors are not logged.
- `execFile` receives fixed arguments; no shell interpolation is used.
- State paths are resolved beneath the configured data root and reject symlink escapes.
- Directories/files are re-chmodded after creation and atomic replacement.
- Cursors must advance according to their source contract; regressions fail closed.
- A failed atomic write leaves the previous state and cursor valid.
- The package exports no Telegram mutation or Gmail send operation.
- Tests scan the implemented command registry and source adapter surface for forbidden operations.

## Testing Strategy

Implementation follows test-driven development. Focused tests will prove:

- strict schemas, canonical IDs, bounded Unicode handling, and evidence validation;
- private account-scoped state, atomic page reduction, cursor durability, overlap deduplication,
  invalid-state quarantine, and lock behavior;
- owner-only Telegram collection and GET-only reuse of the existing proxy;
- exact allowlisted Gmail/Calendar commands and absence of mutation commands;
- classification categories, evidence enforcement, and Gmail-only draft proposals;
- meeting correlation and optional relationship-provider behavior;
- compact report ordering, bounds, source locators, and owner-private envelope enforcement;
- partial-source reporting versus fatal identity/state/evidence failures;
- a mocked end-to-end run with Telegram, Gmail, Calendar, classification, state reload, duplicate
  replay, meeting brief, draft proposal, and report envelope.

Fresh completion checks are:

- focused unified-inbox tests;
- `npm run typecheck`;
- `npm run lint`;
- `npm run format:check`;
- `npm run build` because authored `agent/` material may be added for model judgment;
- full `npm test`, with any pre-existing platform-sensitive failure reported separately and rerun
  in isolation;
- `git diff --check` and protected-state searches for secrets, tracked runtime data, forbidden
  Telegram mutations, Gmail sending, task creation, Containerfile, and maintenance changes.

## Completion Boundary

The branch is complete when the package and entry point satisfy the tests above, the approved scope
has fresh evidence, review findings are resolved, commits use meaningful Conventional Commit titles
with explanatory bodies, and `git status` is clean on `strongf/unified-inbox`.

The branch is not merged, pushed, deployed, scheduled, or exercised against live Telegram/Google
accounts in this task.
