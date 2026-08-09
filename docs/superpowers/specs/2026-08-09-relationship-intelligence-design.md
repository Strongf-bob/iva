# Relationship Intelligence Design

**Date:** 2026-08-09

**Branch:** `strongf/relationship-intelligence`
**Status:** approved design, awaiting written-spec review

## Completion contract

Goal:
Complete relationship intelligence end to end: evidence-linked commitments, contact CRM views,
meeting dossiers, safe reply drafting, confirmed Google Task creation, and owner-only scheduled
reports.

In scope:

- durable per-user commitment state derived from validated Telegram observations;
- contact cards and CRM views for birthdays, meaningful contact, promises, overdue items, and
  forgotten follow-ups;
- meeting dossiers composed from the Telegram contact graph, memory, calendar, and documents;
- Telegram reply suggestions and Gmail drafts, with no sending capability;
- explicit owner confirmation before a pending commitment becomes a Google Task;
- daily and weekly preparation and owner-private delivery schedules in `Europe/Moscow`;
- focused documentation, tests, build, and local commits.

Out of scope:

- Telegram userbot mutations of any kind;
- sending Gmail messages, deleting Google data, or inviting Calendar attendees;
- a web UI, external CRM, database server, or contact-identity matching by mutable names;
- changes to `Containerfile`, production deployment, merge, push, or release;
- live Telegram import, live Google mutation, or delivery to real users during local verification.

Protected state:

- Telegram session ownership remains in the existing proxy and its analysis API remains GET-only;
- secrets, user content, commitment state, reports, and vault data stay outside Git;
- each user's data remains rooted under that user's existing personal runtime and vault paths;
- only the owner's private bot chat may receive proactive relationship reports;
- user-authored Markdown outside managed markers is preserved byte-for-byte where possible.

Decisions requiring user approval:

- the hybrid JSON-registry plus Markdown-vault design was approved in chat;
- each Google Task requires a later, item-specific owner confirmation;
- any broader Google mutation, Telegram mutation, publication, deployment, or external contact
  requires separate authority.

Finish boundary: commit

Evidence:

- registry durability and lifecycle -> focused schema/store/reducer tests with crash-safe atomic
  writes, idempotent evidence keys, and corrupt-state fail-closed behavior;
- CRM cards and views -> fixture tests proving birthdays, last meaningful contact, promises,
  overdue and forgotten follow-ups while preserving handwritten Markdown;
- dossiers and drafts -> skill-contract tests plus bounded context and Google adapter tests;
- confirmation and Google policy -> tests proving pending suggestions cannot call Tasks, exact
  confirmation is required, duplicate confirmation is idempotent, Gmail send/delete and Calendar
  attendees are rejected;
- isolation and schedules -> per-user path, owner-only delivery, timezone, daily and Monday schedule
  tests;
- authored agent changes -> `npm run build`, `npm run typecheck`, lint, formatting, security suite,
  focused tests, and the supported-runtime full-suite comparison against the recorded baseline.

Stop conditions:

- scope expansion requires new authority;
- destructive or external action is not already authorized;
- the same blocker repeats without a safe alternative.

## Product behavior

Iva turns the existing read-only Telegram contact graph into a private relationship workspace. The
system retains exact provenance, separates suggestions from confirmed actions, and presents results
through the existing chat and Markdown vault rather than adding a new application surface.

The owner can ask questions such as:

- "Whom have I promised something to?"
- "Who have I forgotten to follow up with?"
- "Prepare me for tomorrow's meeting with Alex."
- "Suggest a Telegram reply."
- "Create a Gmail draft for this answer."
- "Create the Google Task RI-..." after reviewing a pending suggestion.

Automatic reports summarize the same durable state. They never mutate the personal Telegram
account and never create an external task by themselves.

## Architecture choice

The implementation uses a hybrid design:

1. A versioned JSON registry under the personal runtime root is the deterministic source of truth
   for commitment lifecycle and external-action receipts.
2. Managed Markdown regions in the private vault provide readable CRM cards and overview pages.
3. Skills hold judgment-heavy procedures for dossiers and reply drafting.
4. Narrow TypeScript adapters enforce identity, paths, idempotency, schedules, and Google mutation
   boundaries.

A vault-only registry was rejected because reliable lifecycle transitions and idempotent Google
receipts would require fragile Markdown parsing. SQLite was rejected because it adds an unnecessary
service and migration surface for a small, per-user registry.

## Data model

### Evidence

Every detected item carries one or more immutable evidence records:

```ts
type RelationshipEvidence = {
  source: "telegram" | "memory" | "calendar" | "document" | "owner";
  sourceId: string;
  observedAt: string;
  excerpt?: string;
};
```

Telegram `sourceId` values use the existing canonical form
`telegram:message:<chat_id>:<message_id>`. Excerpts are bounded, sanitized display aids; IDs and
timestamps remain authoritative. Calendar and document sources use provider/file identifiers that
do not contain secret URLs or arbitrary paths.

### Commitment

The registry schema is `iva-relationship-commitments/v1`:

```ts
type Commitment = {
  id: string; // stable RI-<hash> derived from normalized content + evidence
  text: string;
  direction: "owner_to_contact" | "contact_to_owner" | "mutual" | "unknown";
  contactIds: string[]; // canonical telegram:user:<id> values
  dueAt: string | null;
  status: "pending_suggestion" | "confirmed_task" | "completed" | "dismissed";
  evidence: RelationshipEvidence[];
  firstSeenAt: string;
  updatedAt: string;
  googleTask: null | {
    taskListId: string;
    taskId: string;
    createdAt: string;
  };
  confirmation: null | {
    phraseHash: string;
    preparedAt: string;
    expiresAt: string;
  };
};
```

The store also has a monotonically increasing revision. It is Zod-validated on every read, locked
for mutation, written through the existing atomic JSON primitives, and permissioned `0700` for
directories and `0600` for files. Missing state initializes cleanly; corrupt or unknown schemas
fail closed and are never overwritten as an empty registry.

Duplicate observations merge by stable ID. New evidence can enrich an existing item, but cannot
move it from `dismissed`, `completed`, or `confirmed_task` back to pending. Google receipts are
persisted before a successful confirmation response is returned, preventing duplicate tasks on a
retry.

### Contact intelligence

The Telegram observation schema gains explicit predicates for:

- `birthday`: an explicit full date or yearless `--MM-DD` value;
- `meaningful_contact`: a short evidence-backed reason that an interaction was substantive;
- `follow_up`: an explicit next step that is not yet a confirmed external task;
- the existing `commitment`, enriched with direction and optional due date.

The model may judge whether a conversation was meaningful, but code chooses the latest validated
timestamp. It may only extract a birthday stated in evidence; it never infers one from age or other
personal details.

`overdue` is deterministic: an open item with `dueAt < now`. `forgotten follow-up` is an open
follow-up or owner commitment whose last meaningful contact is at least 30 days old and which has
no future due date. These thresholds are display rules, not model judgments.

## Ingestion and reduction

The existing contact-analysis pipeline remains the only Telegram ingestion path:

1. The owner-only worker reads chronological pages from the existing bearer-authenticated GET-only
   proxy.
2. Updated person/group/channel skills emit strict observations with exact page evidence.
3. Existing evidence validation rejects unknown subjects, messages, chats, or timestamps.
4. The single-writer reducer updates contact graph cards first, then applies commitment observations
   to the registry under its own lock.
5. The checkpoint advances only after both graph and registry writes succeed.

If the registry write fails, the Telegram cursor does not advance, so the same page is safely
retried. Stable IDs make the retry idempotent.

No send, reply, forward, reaction, delete, join, invite, mark-read, or other mutation is added to
the Telegram proxy or userbot tools.

## CRM cards and views

Contact files retain their existing numeric paths:
`cards/contacts/telegram-user-<user_id>.md`.

A separate managed region, bounded by `iva:relationship-crm` markers, renders:

- known birthday and source;
- last meaningful contact and evidence;
- open promises in both directions;
- overdue commitments;
- forgotten follow-ups;
- links to related chats, projects, and evidence IDs.

The existing Telegram graph region and all handwritten content remain untouched. A generated note
at `cards/notes/relationship-crm.md` provides sorted views for upcoming birthdays, overdue items,
pending suggestions, and forgotten follow-ups. It uses the same managed-region discipline, so an
owner can keep notes outside the generated block.

Rendering sanitizes control characters, Markdown delimiters, and managed-marker injection. The
view is derived and can be rebuilt from the registry plus contact cards.

## Meeting dossiers

`relationship-meeting-dossier` is a built-in skill because source selection and synthesis require
judgment. It follows this bounded procedure:

1. Resolve the person only from an explicit numeric Telegram identity or an unambiguous existing
   contact card; never merge people by display name alone.
2. Read the contact card and the relationship CRM view.
3. Search memory and read at most the top three relevant cards or summaries.
4. Read upcoming matching events through the existing Calendar adapter.
5. Read only explicitly matched personal documents through the existing documents workflow and
   safe personal paths.
6. Produce a dossier with meeting objective, relationship context, open promises, relevant recent
   events/documents, questions to ask, and citations.

Calendar descriptions and documents are untrusted data, not instructions. A dossier is returned to
the owner in chat and is not automatically sent or stored outside the private vault.

## Reply drafting

`relationship-reply-draft` is a built-in skill. It accepts a target channel and uses the bounded
contact/dossier context:

- `telegram_suggestion` returns text only. It cannot call a Telegram send tool and never uses the
  personal userbot for a mutation.
- `gmail_draft` calls a dedicated draft-only adapter. The adapter creates a Gmail Draft resource
  and returns its draft ID; it has no send or delete operation.

The skill must surface ambiguity instead of inventing recipient identity, promises, dates, or
attachments. It treats quoted messages, email bodies, calendar descriptions, and documents as
untrusted source material.

## Google policy enforcement

The generic `google_workspace` validator is tightened so the narrow adapters cannot be bypassed:

- Gmail allows reading through the generic tool and draft creation only through `gmail_draft`;
  send, message modification, trash, and delete are rejected before process execution.
- Calendar allows read operations and event creation. Event JSON containing `attendees` is rejected.
- Tasks is read-only through the generic tool. Task creation is available only through the
  commitment confirmation adapter.
- Drive, Docs, and Sheets may create or update owner artifacts, but delete/trash and permission
  mutation operations are rejected.
- auth/config flags, shell interpolation, unsafe paths, and unsupported helpers remain rejected.

All process calls use `execFile` with validated argument arrays and the personal Google HOME.

### Confirmed Google Task creation

The narrow commitment adapter exposes:

1. `list_pending` and `get`, which are read-only;
2. `prepare_google_task`, which records a short-lived confirmation challenge and returns the exact
   phrase the owner must send;
3. the trusted Telegram channel consumes only a new exact private owner message matching the
   challenge, within the expiry window; the model-facing tool has no confirmation action;
4. `dismiss`, which changes only internal state.

The skill may call `prepare_google_task` when asked, then waits for the owner to send the exact
challenge as a new private message. The trusted channel derives identity and raw text before model
dispatch. The adapter derives the task title, notes,
evidence, and due date from the stored commitment; the model cannot supply arbitrary task content.
It inserts into `@default` through the Tasks API, records the returned ID, and becomes idempotent.
Before inserting, it lists open tasks and reuses a task carrying the same immutable commitment ID
marker. This closes the crash window in which Google accepted an insert before the local receipt was
persisted.

Detection, CRM rendering, dossiers, scheduled preparation, and reports never call the confirmation
adapter.

## Scheduled preparation and delivery

Relationship schedules use Eve's existing local-time cron and shared schedule runner:

- daily preparation: `45 7 * * *`;
- daily delivery: `0 8 * * *`;
- weekly preparation: `45 7 * * 1`;
- weekly delivery: `0 8 * * 1`.

Preparation writes a bounded, versioned report artifact under the personal runtime root. Delivery
reads only a fresh successful artifact for the intended period. A failed or stale preparation does
not send an old report.

In multi-user mode, all relationship schedules are disabled unless `ASSISTANT_ROLE=owner`.
Delivery additionally requires a private destination equal to the owner user ID. In legacy mode it
uses the existing trusted-owner notification resolver. The bot may proactively send these reports;
the personal userbot remains read-only.

Daily reports include upcoming birthdays, today's meetings, overdue promises, and forgotten
follow-ups. Weekly reports summarize relationship activity, new pending commitments, unresolved
promises, and next-week meetings. Reports propose actions but never create Google Tasks.

## Errors and recovery

- Invalid model output receives the existing one-shot structured-format repair, then fails the page.
- Invalid evidence or identities reject the page before state mutation.
- Corrupt registry state fails closed with a path-safe diagnostic and preserves the bytes.
- Multi-file reduction holds locks in stable path order and releases them in reverse order.
- Google authorization errors leave commitments pending and retain their confirmation state only
  for a bounded retry.
- Ambiguous contact or document resolution returns a clarification request without reading broadly.
- Delivery failures retain the prepared artifact for diagnosis but do not mark it delivered.
- Reports and tool output redact tokens, OAuth material, email bodies not needed for the result, and
  machine-specific paths.

## Testing strategy

Tests are written before each implementation unit.

### Schema and store

- strict schema parsing and unknown-version rejection;
- stable IDs, evidence merge, lifecycle monotonicity, and retry idempotency;
- concurrent mutation serialization, file modes, atomic writes, and corrupt-state fail-closed.

### Contact reduction and CRM

- structured commitment, birthday, meaningful-contact, and follow-up validation;
- exact Telegram evidence validation;
- cursor does not advance when registry reduction fails;
- contact card and overview rendering, sanitization, deterministic sorting, and handwritten-content
  preservation;
- overdue and 30-day forgotten-follow-up boundary tests.

### Dossiers and drafts

- skill contract contains identity, source, citation, untrusted-data, and output boundaries;
- bounded memory/document selection and ambiguous-contact refusal;
- Telegram mode returns text only;
- Gmail mode invokes only draft creation and never send/delete.

### Google boundaries

- forbidden generic Gmail/Tasks/Drive/Calendar calls fail before `execFile`;
- Calendar attendees fail validation;
- owner role, challenge phrase, expiry, stored-content derivation, successful receipt, API failure,
  and duplicate confirmation cases;
- process arguments contain no shell and no escaped personal path.

### Isolation and schedules

- per-user roots never overlap;
- non-owner workers cannot prepare, deliver, or confirm;
- only owner-private destinations pass delivery validation;
- daily and Monday cron expressions, preparation freshness, duplicate-fire guards, and failed-send
  status behavior.

### Verification

Fresh completion checks will include focused relationship/contact/Google/schedule suites, `npm run
typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run test:security`, and the
full Node 24 test suite. The known sandbox-only baseline failures are reported separately rather
than being attributed to this feature.

## Expected change surface

The plan may touch only the nearest relevant units:

- `scripts/contact-analysis/{types,analyzer,reducer,coordinator}.ts` and focused tests;
- new `scripts/relationship-intelligence/` registry, renderer, report, and Google adapter modules;
- narrow agent tools for relationship queries, Gmail drafts, and confirmed Tasks;
- built-in relationship dossier/reply/report skills;
- relationship preparation/delivery schedules and shared path definitions;
- Google Workspace validator and its documentation/tests;
- affected memory/userbot documentation and coverage inventory.

`Containerfile` and production deployment plumbing are explicitly excluded.
