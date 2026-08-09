# Proactive reviews design

## Completion contract

Goal: prepare daily and weekly owner reports ahead of time and deliver the
already prepared material at 08:00 Europe/Moscow, with durable recovery and
owner-confirmed commitment actions.

In scope: daily and Monday weekly reports; persisted immutable report versions;
delivery state, retry, deduplication and missed-run recovery; owner-only urgent
alerts; quiet/noise controls; confirmation and dismissal of pending commitment
suggestions; narrow unified inbox, CRM, calendar, tasks, composer and bot
delivery provider interfaces.

Out of scope: source collectors, Gmail/Telegram/CRM ingestion, Containerfile or
production image work, writes through the personal Telegram userbot, Google
Calendar/Drive/Docs/Sheets implementation, sending email, inviting attendees,
merge, push and deployment.

Protected state: all operational data stays beneath the current user's private
`ASSISTANT_DATA_DIR`; no runtime content is tracked by Git; only the configured
owner may receive proactive messages or act on commitment callbacks; the
personal Telegram userbot remains read-only; no Google Task is created before
an owner confirmation has been durably accepted.

Decisions requiring user approval: changing the private-chat-only boundary,
allowing a Telegram-userbot mutation, sending email, inviting attendees,
creating a Google Task without confirmation, or extending work into collectors,
container images, production or publication.

Finish boundary: a clean, locally verified `strongf/proactive-reviews` branch
with meaningful Conventional Commits; no merge, push or deployment.

Evidence:

- Report timing and Monday bundling -> deterministic clock tests around prepare,
  08:00 delivery, Monday combination and timezone boundaries.
- Persistence, versions, retry and deduplication -> SQLite store and restart
  tests proving immutable versions, persisted attempts and one delivery receipt.
- Recovery -> reconciliation tests for downtime during preparation and delivery,
  including bounded late-delivery windows.
- Owner-only alerts and callbacks -> policy tests covering role, private chat,
  quiet hours, severity, cooldown, callback ownership and duplicate callbacks.
- Confirmation lifecycle -> integration test proving no task creation before a
  confirmation, one idempotent creation afterward, and permanent dismissal.
- Provider boundaries -> typecheck plus contract tests using fake inbox, CRM,
  calendar, tasks, composer and bot providers.
- Runtime integration -> focused schedule and poller tests, `npm run build`,
  `npm run typecheck`, relevant lint/format checks and the repository test suite.
- Protected state -> diff review, secret/path scans and Git status/index checks.

Stop conditions:

- scope expansion requires new authority;
- a destructive or external action is not already authorized;
- the same blocker repeats without a safe local alternative.

## Approved behavior

All wall-clock decisions use `Europe/Moscow`, independent of the host timezone.
The daily report is eligible for preparation at 05:00. The weekly review is
eligible at 05:15 on Monday, after the existing daily and weekly memory rollups.
The prepared material is frozen for delivery at 07:55. A five-minute Eve
reconciliation schedule reaches the 08:00 boundary and performs one due
delivery attempt without generating content on the delivery path.

On Monday, the latest ready daily and weekly versions are rendered as one bot
message and share one delivery receipt. On other days, only the daily report is
included. A restart or missed cron tick runs the same reconciler: daily delivery
may recover for 12 hours, weekly delivery for 72 hours. Material outside its
recovery window is marked expired rather than creating stale noise.

Preparation failures retry with persisted exponential backoff capped at 30
minutes and stop at the freeze boundary. Delivery failures retry from the
persisted ready version, never re-running the composer. The stable delivery key
is derived from owner identity and the covered period keys. A successful
provider receipt closes the delivery permanently; repeated ticks become no-ops.

## Architecture

### Thin scheduled reconciler

`agent/schedules/proactive-reviews.ts` is a thin Eve schedule. It checks the
runtime opt-in and owner role, resolves the personal data path, and invokes one
deterministic TypeScript entrypoint. The entrypoint opens the store, constructs
runtime adapters and calls a testable reconciliation service. There is no new
systemd timer, cron daemon or general-purpose scheduler.

The reconciler owns only deterministic concerns: period calculation, admission,
state transitions, retries, deduplication, quiet-hour decisions and action
dispatch. Judgement and prose generation stay behind `ReportComposer`, allowing
an agent skill to create report content without moving reliability logic into a
prompt.

### Provider contracts

The feature defines narrow interfaces rather than source collectors:

- `UnifiedInboxProvider`: returns normalized, source-referenced inbox items for
  a bounded time window.
- `CrmProvider`: returns follow-ups, relationship changes and pending commitment
  suggestions with stable IDs and evidence references.
- `CalendarProvider`: returns bounded upcoming events and schedule conflicts.
- `TasksProvider`: reads current tasks and idempotently creates one Google Task
  from a confirmed commitment using a caller-provided idempotency key.
- `ReportComposer`: converts one normalized snapshot into a daily or weekly
  report body and a bounded list of commitment suggestions.
- `BotDeliveryProvider`: sends to one explicit owner private chat and returns a
  durable provider receipt; it may include only allowlisted confirmation and
  dismissal actions.

Provider inputs and outputs are typed, length-bounded and validated before they
cross the persistence boundary. The runtime composition layer may adapt existing
Iva capabilities, while tests use in-memory fakes. This branch does not fetch
Telegram, Gmail or CRM source data itself.

### Private SQLite state

The database lives at
`$ASSISTANT_DATA_DIR/proactive-reviews/state.sqlite`, with private directory and
file permissions. The path is resolved beneath the current personal data root;
symlink escapes are rejected. SQLite transactions provide one writer and atomic
admission across schedule ticks, restarts and callback processing.

The schema contains:

- `report_versions`: immutable `kind`, period key, version, source fingerprint,
  body, suggestions, preparation timestamps and state;
- `deliveries`: stable delivery key, selected version IDs, due time, attempts,
  next retry, late/expired state and provider receipt;
- `urgent_alerts`: stable fingerprint, severity, first/last seen, cooldown,
  quiet-hour deferral and delivery receipt;
- `commitment_actions`: opaque action token hash, owner, suggestion, decision,
  task idempotency key, task provider receipt and timestamps.

Raw callback tokens are random and appear only in the bot markup; only their
hashes are stored. Schema creation is forward-compatible and idempotent. This
feature owns no destructive migration and does not alter existing persisted
formats.

## Urgent alerts and noise policy

Only normalized `high` and `critical` alerts are eligible. Lower severities stay
in the next report. Equal alert fingerprints are deduplicated; repeated high
alerts observe a six-hour cooldown and critical alerts a one-hour cooldown.
Quiet hours are 22:00-08:00 Europe/Moscow: high alerts are deferred until 08:00,
while critical alerts may bypass quiet hours. Every alert still passes the owner
role and private-chat gate. Failure leaves the alert pending with persisted
backoff; success records a receipt before another tick can resend it.

## Commitment confirmation flow

The report exposes `Create Google Task` and `Dismiss` for each pending
suggestion. Callback data carries an allowlisted prefix and opaque token only.
The poller intercepts that namespace before model delivery, reuses its verified
tenant routing, and accepts it only when sender ID and private chat both equal
the owner recorded for the action.

Acceptance first commits the decision transactionally. The reconciler later
invokes `TasksProvider.createConfirmedCommitment` with the stored idempotency
key. A repeated callback or retry can therefore create at most one task. Dismiss
is terminal and never calls the provider. Unknown, expired, foreign or already
decided tokens receive a generic callback answer without leaking action data.

## Error handling and observability

Logs contain report kind, period, state and attempt numbers, never report bodies,
inbox text, commitment text, callback tokens or credentials. Invalid provider
data fails that preparation attempt without partially persisting a ready report.
SQLite operational failures fail closed: no bot or task call is attempted unless
the corresponding transaction established ownership of the operation. Provider
failures are classified as retryable, ambiguous or terminal and stored as
bounded codes, not raw response bodies. A definite Bot API rejection may retry.
A transport loss after dispatch is ambiguous because Telegram has no caller
idempotency key; it is retained for owner-visible reconciliation and is not
automatically resent, preventing a guessed retry from creating a duplicate.

## Test strategy

Development follows red-green-refactor. Clock-driven unit tests cover Moscow
period keys, 05:00/05:15 preparation, 07:55 freeze, 08:00 delivery, Monday
bundling and late expiry. Store tests reopen a real temporary SQLite database to
prove persistence and transaction-safe deduplication. Service tests use real
state plus fake providers for retries, restart recovery, quiet hours, alerts and
confirmation-to-task creation. Poller tests exercise verified owner/private-chat
callbacks and rejection cases. Schedule tests prove the cron and owner-only
runtime gate. Final verification includes authored-agent rebuild because the
schedule lives under `agent/`.
