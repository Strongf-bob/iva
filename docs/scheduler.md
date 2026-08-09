# Durable reminder scheduler

User-created reminders are durable data, not host processes. Iva stores each user's
jobs under that user's private runtime directory and a dedicated Compose service scans
the active-user registry. It delivers due text through the Telegram Bot API to the
registry user's private bot chat. The personal Telegram userbot remains read-only and
is never a reminder delivery path.

This interface is the stable foundation for later daily and weekly planning features.
Those features should call the tool or TypeScript library below instead of creating
`systemd-run`, crontab, detached shell, or sleep-loop jobs.

## Data contract

The store schema is `iva-reminders/v1` and lives at
`<personal ASSISTANT_DATA_DIR>/reminders.json`. Writes take an adjacent lock and replace
the JSON atomically. Callers create a job with:

```json
{
  "idempotencyKey": "weekly-plan:2026-08-10",
  "message": "Prepare the weekly plan",
  "timezone": "Europe/Moscow",
  "schedule": { "kind": "cron", "expression": "0 8 * * 1" }
}
```

| Field            | Contract                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| `idempotencyKey` | 1-128 safe characters: letters, digits, `:`, `_`, `-`; unique per user. |
| `message`        | Non-empty Telegram text, at most 4,000 characters.                      |
| `timezone`       | Valid IANA timezone such as `Europe/Moscow` or `UTC`.                   |
| `schedule`       | A future `once.at` ISO timestamp with offset, or a five-field cron.     |

Creating the same `idempotencyKey` again returns the original job with
`created: false`; it does not enqueue a duplicate. Job states are `active`,
`delivering`, `completed`, and `cancelled`. The UUID returned as `job.id` is used by
`get` and `cancel`.

Cron supports numeric wildcards, lists, ranges, and steps. Weekday `0` and `7` both
mean Sunday. The next occurrence is calculated against the job's IANA timezone, so
daylight-saving transitions follow that timezone: a nonexistent wall-clock minute is
skipped, while both real instants of a repeated wall-clock minute can match. One-off
timestamps are absolute instants and must be in the future when created.

## Tool contract

The Eve `reminders` tool accepts five strict actions:

- `create`: the fields above.
- `list`: optional `includeInactive: true`.
- `get`: a reminder UUID.
- `cancel`: a reminder UUID.
- `status`: per-state counts for the current user.

All mutations require the worker's fixed `ASSISTANT_USER_ID`, absolute
`ASSISTANT_PERSONAL_ROOT`, and bounded `ASSISTANT_DATA_DIR`. There is deliberately no
destination field: neither the agent nor a later feature can redirect a reminder to a
different user, group, or channel.

The matching TypeScript surface is:

```ts
createReminder(dataDir, input, options);
listReminders(dataDir, options);
getReminder(dataDir, id);
cancelReminder(dataDir, id);
runReminderTick({ users, deliver, now, leaseMs, log });
runSchedulerIteration({
  dataDir,
  token,
  loadUsers,
  authorize,
  deliver,
  now,
  log,
});
```

Callers should treat returned jobs as data snapshots. Store mutations must continue to
go through these functions so locking, validation, revision increments, and atomic
writes remain consistent.

Invalid store JSON is never replaced with an empty store and never quarantined into a
path that the next tick ignores. The original `reminders.json` remains in place and that
user fails closed until an operator explicitly repairs or restores it.

## Operator CLI

The CLI uses the same validation and store. Run mutation commands only inside a fixed
personal worker environment; input JSON never contains a Telegram destination.

```bash
printf '%s\n' '{"idempotencyKey":"dentist:2026-08-10","message":"Dentist appointment","timezone":"Europe/Moscow","schedule":{"kind":"once","at":"2026-08-10T15:00:00+03:00"}}' |
  npm run reminders -- create

npm run reminders -- list
npm run reminders -- list --all
npm run reminders -- get 00000000-0000-4000-8000-000000000000
npm run reminders -- cancel 00000000-0000-4000-8000-000000000000
npm run reminders -- status
```

Each command prints one JSON object. `create`, `list`, `get`, `cancel`, and `status`
fail closed unless user identity and storage are fixed. `health` is service-scoped and
reads the global scheduler heartbeat instead:

```bash
npm run scheduler:health
```

## Delivery and recovery semantics

Delivery is **at-least-once**. Before calling Telegram, the scheduler atomically reserves
an occurrence with a two-minute lease. A normal acknowledgement completes a one-off or
advances a recurring job. A failure returns it to `active` and retries with exponential
backoff from five minutes up to six hours.

If the process dies after Telegram accepted a message but before the success write, the
expired lease is recovered and that occurrence may be delivered once more. This narrow
acknowledgement window is the only intentional duplicate case; consumers must not assume
exactly-once delivery. A recurring job that missed several slots while the stack was
down coalesces them into one delivery, then advances to the first future occurrence.
Each tick processes at most 20 jobs per active user to prevent a restart storm.
The scheduler re-reads the durable user registry after reserving each occurrence and
immediately before Telegram I/O. If the user is no longer active, the reservation is
returned to `active` without sending. A corrupt or inaccessible tenant store increments
`userFailures` but does not stop other tenants or the process heartbeat.

The scheduler writes `data/control/reminder-scheduler-status.json` after every tick using
schema `iva-reminder-scheduler-status/v1`. Health is `ready` while its `updatedAt` is at
most 60 seconds old. A fresh heartbeat with tenant failures reports `degraded` while the
container stays alive; an older heartbeat is `stale`, a timestamp materially in the
future is `invalid`, and malformed or absent state is unhealthy.

## Container lifecycle

`reminder-scheduler` is a separate service in
`deploy/container/compose.production.yml`. It uses the production image, mounts only
the shared data directory and read-only `.env`, drops all capabilities, has no Docker
socket, and restarts unless stopped. Start, inspect, and update it with the whole stack:

```bash
docker compose -f deploy/container/compose.production.yml up -d
docker compose -f deploy/container/compose.production.yml ps reminder-scheduler
docker compose -f deploy/container/compose.production.yml logs reminder-scheduler
docker compose -f deploy/container/compose.production.yml exec reminder-scheduler npm run scheduler:health

docker compose -f deploy/container/compose.production.yml pull
docker compose -f deploy/container/compose.production.yml up -d
```

Do not run a second scheduler against the same data mount. The per-store lock protects
individual writes, but the supported topology has exactly one registry scanner.
The forced production deploy path starts and health-checks this service together with
Iva, the poller, and the userbot. Rollback images that predate the scheduler are restored
with the scheduler container removed, rather than being falsely reported as a healthy
four-service release.
