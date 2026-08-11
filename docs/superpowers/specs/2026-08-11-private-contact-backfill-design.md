# Full private-contact backfill for Iva

- **Status:** approved
- **Date:** 2026-08-11
- **Depends on:** `2026-08-11-human-first-contact-memory-design.md`

## Goal contract

**Goal:** rebuild Telegram-derived person memory from complete private-chat history into the
human-first contact-card format, then keep it current with the existing incremental sync.

**In scope:** read-only Telegram export, private human dialogs, oldest-first bounded paging,
durable per-chat checkpoints, dry-run inventory, recoverable backup, legacy-card migration,
idempotent reduction, protected-main publication, deployment, live backfill, and result checks.

**Out of scope:** Telegram writes, bot/group/channel backfill, inferred meetings, automatic task
creation from historical chat, sensitive-trait inference, and a new database.

**Protected state:** the owner's Telegram session, live vault, manually authored Markdown,
owner-confirmed facts, meetings, person-task registry, existing incremental checkpoints, and all
other users' private roots.

**Decisions requiring user approval:** expanding beyond read-only private chats, deleting Telegram
history or vault data, changing the storage boundary, or sending messages. The requested deploy and
live migration are already authorized by the active goal.

**Finish boundary:** deploy and verified live migration.

**Evidence:**

- complete oldest-first traversal -> API/client and coordinator tests cover every message exactly
  once across pages, crash/resume, duplicate delivery, and a fixed high-water mark;
- protected memory -> migration tests prove backup-before-write, preservation of manual prose,
  owner facts, meetings, tasks, and rollback after an injected failure;
- private-only scope -> inventory tests exclude bots, groups, and channels;
- safe interpretation -> structured-output tests require exact evidence and reject meetings,
  historical tasks, sensitive traits, invalid identities, and prompt injection;
- operability -> CLI tests cover `status`, `--dry-run`, `run`, resume, lock contention, and bounded
  secret-free reports;
- release -> fresh build/typecheck/lint/tests, required PR checks, matching remote/deployment SHA,
  runtime health, backup manifest, completed live report, and post-run card validation.

**Stop conditions:** scope expansion needs new authority; a destructive or external action is not
authorized; backup integrity cannot be proven; live Telegram authorization is absent; or the same
blocker repeats without a safe alternative.

## Decision

Use a dedicated deterministic `rebuild-private` workflow over the existing bearer-authenticated,
GET-only userbot export. Do not change the semantics of scheduled `sync`: it is optimized for fresh
updates and may intentionally skip old messages outside its current context window.

Three approaches were considered:

1. Reset and repeatedly run ordinary `sync`. Rejected because its newest-first window can advance
   past older messages and therefore cannot prove complete history coverage.
2. Add a dedicated oldest-first workflow over the existing `/analysis/v1/messages` API.
   **Selected:** it preserves the stable API boundary, exposes an advancing message cursor, and
   keeps migration mechanics separate from ongoing sync.
3. Export raw Telegram history to a permanent local corpus and analyze it later. Rejected because
   it creates an unnecessary second store of private message text and a new retention problem.

## Data flow

1. Acquire the existing contact-analysis lock so scheduled sync and backfill cannot write together.
2. Read the connected account and exhaust the dialog inventory.
3. Keep only `kind=private`; bots, groups, and channels are reported but never processed.
4. On dry-run, report bounded counts and required paths without model calls or vault writes.
5. Before the first applying run, snapshot relevant live vault files and state into a private backup
   directory outside the vault and record hashes in a manifest.
6. Capture a per-chat high-water message ID. This fixes the historical input while new messages may
   continue arriving.
7. Read pages oldest-first after the durable cursor and no later than the high-water mark. Split
   pages into complete bounded model chunks without sampling or omitting a message. An individually
   oversized text is represented by bounded ordered fragments with the same evidence identity.
8. Run the existing person-profile skill and strict analysis schema. Each chunk is reduced through
   the existing serialized human-first reducer before its cursor advances.
9. When every private chat reaches its high-water mark, migrate any remaining legacy presentation,
   reconcile linked task views, validate all affected cards, and mark the run complete.
10. Set the incremental cursor to at least the captured high-water mark. The normal scheduled sync
    then processes messages that arrived after the snapshot.

## State and recovery

Backfill state is account-scoped and separate from incremental state. It records schema version,
run ID, phase, backup manifest, inventory completion, and for each private chat: Telegram ID, title,
high-water ID, committed cursor, rolling summary, processed-message count, and terminal status.

The cursor advances only after durable reduction. Replaying a page is safe because observations use
stable evidence-derived identities and the reducer is idempotent. A crash resumes the same run; a
new run is refused until the completed run is explicitly archived or the failed run is rolled back.
Errors are stored as bounded codes without message content.

## Memory policy

This remains externalized learning: Telegram messages are evidence episodes, structured
observations are candidates, and the Markdown card is typed user memory. Model weights do not
change, and a rolling summary is context only, never evidence.

The backfill may add identity, birthday, city, timezone, phone, email, education, employer,
interests, important dates, gift ideas, relationship context, and interesting facts under the
existing promotion rules. It cannot create meetings or active obligations from ordinary chat.
A birthday greeting may support only month/day when the local date is unambiguous; age is shown
only when a full birth date is known.

Message text and attachment labels remain untrusted data. Imperative text cannot change the
workflow, permissions, schema, or output policy. Every material fact retains exact Telegram
evidence internally while normal user replies hide IDs, confidence codes, comments, and source
coordinates.

## Backup, apply, and rollback

The backup is created before any live mutation, outside tracked paths and outside the vault. Its
manifest contains run ID, account ID, creation time, source paths, sizes, modes, and SHA-256 hashes.
The apply phase refuses a missing, unreadable, symlinked, or hash-invalid backup.

Manual Markdown outside managed regions is never replaced. Owner-confirmed facts, explicit meeting
history, and person tasks survive reconstruction. If an applying run fails, the durable journal and
backup restore affected files before another run may start. The backup is retained after success
until the owner chooses to remove it.

## Verification and release gate

Local verification includes focused unit/integration tests, the full repository suite in an
environment that supports loopback and process groups, coverage policy, typecheck, lint, formatting,
and `npm run build` because agent behavior changes.

Production execution requires the protected-main PR path and a deployment whose reported SHA
matches `origin/main`. Before apply, record userbot health, dry-run inventory, live card counts, and
backup hashes. After apply, require zero failed private chats, zero skipped messages, no duplicate
canonical person IDs, valid managed metadata, preserved manual regions, reconciled task links, and
healthy Telegram/userbot/runtime services. Any failed gate leaves the goal active and reports the
exact recoverable blocker.
