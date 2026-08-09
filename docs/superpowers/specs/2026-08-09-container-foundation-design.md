# Container Foundation Design

## Goal contract

**Goal:** make Iva's production container a complete foundation for Google Workspace, durable user-created reminders, and truthful Maintenance operations.

**In scope:**

- install the Google Workspace CLI at an exact version in the production image;
- run the existing `/menu` Google OAuth flow with the selected user's private `HOME` and XDG configuration root;
- provide a durable, container-native scheduler for one-off and recurring reminders;
- expose stable scheduler interfaces for later feature branches;
- make `/menu` Maintenance diagnostics, vault cleanup, memory-cycle triggering, status, and update guidance work correctly in a container;
- document the scheduler records, commands, lifecycle, and integration boundary.

**Out of scope:** CRM and inbox intelligence, Google-side automatic commitment creation, Telegram userbot mutations, mail sending, attendee invitations, production deployment, remote publication, and unrelated refactors.

**Protected state:** per-user vaults, credentials, OAuth state, scheduler records, and runtime logs stay outside Git and inside the user's private root. The personal Telegram userbot remains read-only. Proactive messages can go only to the matching user's private bot chat. Google operations retain the shared policy: Calendar events without attendees, Tasks/Docs/Sheets/Drive creation, Gmail drafts only, no sends or deletes.

**Decisions requiring new approval:** adding another external service, changing the Google permission policy, adding a Telegram mutation, changing persisted user formats incompatibly, pushing, merging, deploying, or touching production.

**Finish boundary:** local commits on `strongf/container-foundation`, with a clean, freshly verified branch. No push, merge, PR, deployment, or production mutation.

**Evidence:**

- pinned CLI -> Containerfile/package assertion plus an image-level `gws --version` smoke check;
- per-user OAuth -> tests proving `HOME` and `XDG_CONFIG_HOME` are derived from the fixed user context and do not cross users;
- durable scheduler -> unit and integration tests for validation, atomic persistence, one-off deletion, recurring calculation, restart recovery, deduplication, private delivery, isolation, status, and cancellation;
- container Maintenance -> menu/runtime tests for diagnostics, cleanup, memory cycle, status, and update guidance without `systemctl`;
- authored agent changes -> `npm run build` after tests and typecheck;
- final state -> diff review, secret/path scan, code review, and clean `git status` after meaningful Conventional Commits.

**Stop conditions:** scope expansion requires new authority; destructive or external action lacks authorization; or the same unavoidable blocker recurs for three goal turns.

## Chosen architecture

### Production image and Google OAuth

The runtime image installs `@googleworkspace/cli` with an exact version rather than relying on a host-global binary or a floating npm tag. The build verifies that `gws` resolves and reports the pinned version. The version is declared once so the Containerfile test and documentation cannot silently disagree.

The existing menu relay remains the OAuth mechanism. Every probe, login child, callback relay, and later `gws` invocation receives the selected user's absolute private root as `HOME` and `<HOME>/.config` as `XDG_CONFIG_HOME`. The menu must fail closed when a personal root is absent or not absolute in multi-user mode; it must not fall back to the bridge account's home. Client secrets and tokens remain mode-restricted in `<HOME>/.config/gws`.

### Scheduler service

A dedicated scheduler process runs as a Compose service from the same immutable Iva image. It is separate from the Telegram poller and Eve worker so polling restarts and agent turns do not own reminder lifecycle. The scheduler uses only the existing bind-mounted `data/` tree and needs no host `systemd`, cron daemon, or Docker socket.

Each user owns a private scheduler directory under the existing per-user layout. The durable store is a small versioned JSON document written through a unique temporary file plus atomic rename, protected by an exclusive lock. SQLite is deliberately not introduced for this bounded registry. Corrupt or unsupported records fail closed and remain inspectable; they are never silently discarded.

The public TypeScript interface and CLI support:

- `create` with caller-supplied idempotency key, message, timezone, and exactly one schedule form;
- one-off schedules as an absolute timestamp;
- recurring schedules as a validated five-field cron expression;
- `list`, `get`, `cancel`, and `status` scoped to the fixed user identity;
- a long-running `run` mode used only by the container service.

The CLI accepts structured JSON through a file or stdin and never interpolates user strings into a shell command. Schema validation constrains ids, timestamps, cron fields, message size, timezone, and destination. The destination is always derived from the authenticated user's Telegram id and private bot chat, never supplied as an arbitrary chat id.

At startup and on each bounded polling tick, the service loads active users from the registry, acquires a per-user scheduler lease, and evaluates due jobs. A one-off job becomes complete only after successful delivery. A recurring job advances from its scheduled occurrence, not wall-clock completion, to avoid drift. The store records attempt and delivery state before/after I/O so a restart cannot create an unbounded duplicate storm. Failed deliveries retry with bounded backoff. Catch-up is limited and explicit: one-off reminders remain due; recurring jobs coalesce missed occurrences into one delivery and calculate the next future occurrence.

The execution layer calls the existing bot delivery primitive directly with fixed user identity. It does not invoke the personal userbot. A scheduler process cannot target a group, another user, or an inactive/blocked registry entry.

### Maintenance runtime adapter

`/menu` Maintenance keeps one presentation layer and selects a runtime adapter from explicit container configuration. The host adapter preserves existing behavior. The container adapter:

- obtains service/runtime health from local process and persisted status evidence rather than `systemctl`;
- runs diagnostics and vault cleanup as attached, bounded child processes with per-user paths;
- triggers the memory cycle through the same deterministic schedule runner used by normal maintenance, preserving locks, quota admission, and status reporting;
- reports progress and cancellation through the existing menu runner;
- replaces restart/update actions that cannot be performed safely inside the immutable container with truthful operator guidance naming the Compose/deployment workflow.

No Maintenance action mounts or controls the host Docker socket. No action restarts its own bridge during the current Telegram interaction. Container status distinguishes "not available from this container" from unhealthy.

### Interfaces for later branches

Later daily/weekly planning branches depend only on the documented scheduler API, never the JSON representation. They may create owner-private jobs through the scoped CLI/library and query status. Automatically discovered commitments remain internal until the owner explicitly confirms creating a Google Task. Daily material is prepared before delivery and scheduled for 08:00 Europe/Moscow; weekly review is scheduled for Monday at 08:00 Europe/Moscow by consumers, not hard-coded into the scheduler foundation.

## Error handling and observability

Every scheduler mutation is atomic and returns a machine-readable result. Validation errors do not alter the store. Delivery attempts record timestamps, a bounded sanitized error, and next retry time; message contents and OAuth data are not logged. A stale lease can be recovered only after its recorded expiry. The scheduler exposes a health/status record consumed by diagnostics and `/menu`.

OAuth error screens distinguish missing CLI, missing client JSON, unauthenticated state, and failed callback relay without printing tokens or secrets. Maintenance surfaces the exact operation that failed and retains the last bounded output tail already used by the menu runner.

## Testing strategy

Implementation proceeds test-first. Pure scheduler tests cover schema and time calculation. Store tests cover atomic writes, idempotency, cancellation, corrupt data, and isolation. Runner tests use a fake clock and delivery adapter to cover restart recovery, retries, coalescing, blocked users, and one-off completion. Compose and Containerfile contract tests cover the service, mounts, environment, and pinned CLI. OAuth tests cover absolute per-user HOME and fail-closed behavior. Maintenance tests cover both host and container adapters and verify container mode never calls `systemctl`, `systemd-run`, or `crontab`.

Fresh completion checks include the relevant Node test suites, typecheck, production build, repository policy scans, and an independent code review of the final diff.
