# Container Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-container foundation with pinned Google Workspace CLI, isolated Google OAuth, durable user reminders, and truthful container Maintenance behavior.

**Architecture:** The image owns an exact `gws` binary. Per-user workers and menu flows resolve Google state from the fixed personal root. A dedicated Compose scheduler reads versioned per-user reminder stores, evaluates validated one-off/cron schedules, and sends only through the private Telegram bot. Menu screens select host or container behavior through explicit `IVA_RUNTIME=container` configuration.

**Tech Stack:** Node.js 24, TypeScript ESM, zod, Node test runner, Docker Compose, Google Workspace CLI 0.22.5, existing atomic JSON and Telegram delivery primitives.

## Global Constraints

- Work only on `strongf/container-foundation`; do not push, merge, deploy, or modify production.
- The personal Telegram userbot stays strictly read-only; scheduler delivery uses the bot token only and targets the fixed user's private chat.
- Google policy remains: Calendar events without attendees; Tasks, Docs, Sheets, and Drive artifacts may be created; Gmail drafts only; never send or delete.
- All credentials, OAuth state, reminders, status, logs, vault data, and runtime data stay in ignored per-user roots outside Git.
- Do not implement CRM, inbox intelligence, or automatic Google Task creation from discovered commitments.
- New Node source and tests are TypeScript; add no tracked `.mjs` file.
- Any authored `agent/` change requires `npm run build` before completion.
- Scheduler consumers, not the foundation, own the future 08:00 Europe/Moscow daily and Monday 08:00 weekly schedules.

---

### Task 1: Pin `gws` and close the per-user OAuth boundary

**Goal:** Ensure every production container contains one known `gws` version and every Google operation uses the selected user's private HOME.

**Dependencies:** Existing `scripts/lib/menu/gws-auth.ts`, `scripts/lib/menu/gws.ts`, `agent/tools/google_workspace.ts`, and menu state `personalRoot`.

**Files:**

- Modify: `Containerfile`
- Modify: `scripts/lib/menu/gws-auth.ts`
- Modify: `scripts/lib/menu/gws.ts`
- Modify: `agent/tools/google_workspace.ts`
- Modify: `scripts/lib/menu/gws-auth.test.ts`
- Modify: `scripts/google-workspace-tool.test.ts`
- Create: `scripts/container-gws.test.ts`

**Accepted decisions:** Pin `@googleworkspace/cli@0.22.5`, the current immutable upstream release verified from the package registry and upstream release page. Container or multi-user execution fails closed when the personal root is absent or non-absolute.

**Interfaces:**

- Produces: `resolveGoogleHome({ personalRoot, container, multiUser }): string` and `childEnv(homeDir: string): NodeJS.ProcessEnv`.
- Consumes: absolute `personalRoot` from the authenticated menu/worker route.

**DoD:** Runtime image installs and smoke-checks `gws 0.22.5`; OAuth probe/login/tool executions share the same personal HOME; no bridge/global HOME fallback exists in container or multi-user mode.

**Checks:** `node --test scripts/container-gws.test.ts scripts/lib/menu/gws-auth.test.ts scripts/google-workspace-tool.test.ts`

- [ ] **Step 1: Write failing image and isolation tests**

Add assertions equivalent to:

```ts
assert.match(containerfile, /ARG GWS_VERSION=0\.22\.5/u);
assert.match(containerfile, /@googleworkspace\/cli@\$\{GWS_VERSION\}/u);
assert.throws(
  () => resolveGoogleHome({ container: true }),
  /personal Google HOME/u,
);
assert.equal(
  resolveGoogleHome({
    personalRoot: "/srv/iva/data/users/101",
    container: true,
  }),
  "/srv/iva/data/users/101",
);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test scripts/container-gws.test.ts scripts/lib/menu/gws-auth.test.ts scripts/google-workspace-tool.test.ts`

Expected: FAIL because the image pin and `resolveGoogleHome` contract do not exist.

- [ ] **Step 3: Implement the exact pin and shared HOME resolver**

Add the runtime image contract:

```dockerfile
ARG GWS_VERSION=0.22.5
RUN npm install --global "@googleworkspace/cli@${GWS_VERSION}" \
  && test "$(gws --version)" = "${GWS_VERSION}"
```

Make `childEnv` require the resolved absolute home and set both `HOME` and `XDG_CONFIG_HOME`. Menu rendering turns a missing personal root into a safe unavailable screen; the agent tool returns a structured error.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test scripts/container-gws.test.ts scripts/lib/menu/gws-auth.test.ts scripts/google-workspace-tool.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the unit**

```bash
git add Containerfile scripts/container-gws.test.ts scripts/lib/menu/gws-auth.ts scripts/lib/menu/gws.ts scripts/lib/menu/gws-auth.test.ts agent/tools/google_workspace.ts scripts/google-workspace-tool.test.ts
git commit -m "feat(container): pin Google Workspace CLI" -m "Install a verified gws release in the runtime image and bind OAuth and tool execution to each user's private HOME. Fail closed when container user context is unavailable so credentials cannot fall back to a shared account."
```

---

### Task 2: Build the versioned reminder store and cron engine

**Goal:** Provide a deterministic, validated, per-user durable model for one-off and recurring reminders.

**Dependencies:** `agent/lib/json-store.ts`, `scripts/lib/timezone.ts`, and fixed per-user `ASSISTANT_DATA_DIR`.

**Files:**

- Create: `scripts/lib/reminder-schema.ts`
- Create: `scripts/lib/reminder-cron.ts`
- Create: `scripts/lib/reminder-store.ts`
- Create: `scripts/lib/reminder-schema.test.ts`
- Create: `scripts/lib/reminder-cron.test.ts`
- Create: `scripts/lib/reminder-store.test.ts`

**Accepted decisions:** Persist `iva-reminders/v1` JSON under `<personal data>/reminders.json`; use exclusive lock plus atomic rename; implement bounded standard five-field cron parsing without adding a scheduler database or daemon dependency.

**Interfaces:**

- Produces: `ReminderInputSchema`, `ReminderJob`, `ReminderStore`, `nextCronOccurrence(expression, timezone, afterMs)`, `createReminder`, `listReminders`, `cancelReminder`, and `mutateReminderStore`.
- Store fields: schema, revision, jobs; each job contains id, idempotencyKey, message, timezone, schedule, state, nextRunAt, attempt/delivery timestamps, failure count, and bounded sanitized last error.

**DoD:** Inputs reject arbitrary destinations, invalid ids/timezones/crons, oversized messages, and past one-off timestamps; idempotency returns the existing job; corrupt JSON is preserved and rejected; stores cannot cross their supplied personal data root.

**Checks:** `node --test scripts/lib/reminder-schema.test.ts scripts/lib/reminder-cron.test.ts scripts/lib/reminder-store.test.ts`

- [ ] **Step 1: Write failing schema, time, and persistence tests**

Cover exact cases:

```ts
assert.equal(
  nextCronOccurrence("0 8 * * 1", "Europe/Moscow", mondayBefore),
  mondayAtEight,
);
assert.throws(
  () => nextCronOccurrence("@daily", "Europe/Moscow", now),
  /five fields/u,
);
assert.equal((await createReminder(store, input)).created, true);
assert.equal((await createReminder(store, input)).created, false);
await assert.rejects(() => loadReminderStore(corruptPath), /damaged/u);
```

Also test ranges, lists, steps, Sunday 0/7, DST forward/backward behavior, cancellation, and concurrent mutations.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test scripts/lib/reminder-schema.test.ts scripts/lib/reminder-cron.test.ts scripts/lib/reminder-store.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement minimal schemas, cron evaluation, and store mutations**

Use strict zod objects and a branded reminder id. Cron parsing accepts only `*`, numbers, ranges, lists, and positive steps within minute/hour/day/month/weekday bounds. Search future minute boundaries with a hard horizon and compare timezone-local parts through `Intl.DateTimeFormat`.

Use the existing store primitives:

```ts
const token = await acquireLock(`${file}.lock`);
try {
  const current = parseStore(await loadJsonStrict(file, emptyStore()));
  const next = mutate(current);
  await saveJsonAtomic(file, next);
  return next;
} finally {
  releaseLock(`${file}.lock`, token);
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test scripts/lib/reminder-schema.test.ts scripts/lib/reminder-cron.test.ts scripts/lib/reminder-store.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the unit**

```bash
git add scripts/lib/reminder-schema.ts scripts/lib/reminder-cron.ts scripts/lib/reminder-store.ts scripts/lib/reminder-schema.test.ts scripts/lib/reminder-cron.test.ts scripts/lib/reminder-store.test.ts
git commit -m "feat(scheduler): add durable reminder store" -m "Define validated one-off and recurring reminder records with atomic per-user persistence, idempotent creation, cancellation, and timezone-aware cron calculation. Preserve corrupt data and avoid host scheduler dependencies."
```

---

### Task 3: Add the scheduler runner, service, CLI, and agent tool

**Goal:** Deliver due reminders durably from a dedicated container service and expose stable scoped interfaces to Iva and later branches.

**Dependencies:** Task 2 reminder interfaces, `readUserRegistry`, `resolveUserLayout`, and `sendTelegramHtml`.

**Files:**

- Create: `scripts/lib/reminder-runner.ts`
- Create: `scripts/lib/reminder-runner.test.ts`
- Create: `scripts/reminder-scheduler.ts`
- Create: `scripts/reminder-scheduler.test.ts`
- Create: `agent/tools/reminders.ts`
- Create: `scripts/reminder-tool.test.ts`
- Modify: `package.json`
- Modify: `deploy/container/compose.production.yml`
- Create: `scripts/container-scheduler-contract.test.ts`

**Accepted decisions:** Scheduler is a separate Compose service using the same image and `data` bind mount. Delivery is at-least-once with a persisted delivery lease; a crash around Telegram acknowledgement can cause at most one retry, never an unbounded replay storm. Missed recurring slots coalesce to one delivery.

**Interfaces:**

- Produces: `runReminderTick(options): Promise<TickReport>`, `runScheduler(options): Promise<never>`, CLI actions `create|list|get|cancel|status|run|health`, and Eve tool actions `create|list|get|cancel|status`.
- Consumes: fixed `ASSISTANT_USER_ID` and `ASSISTANT_DATA_DIR` for mutations; scheduler service alone iterates active registry users.

**DoD:** One-off jobs complete only after success; recurring jobs advance from the scheduled occurrence; failures retry with bounded exponential backoff; stale leases recover; inactive users are skipped; delivery chat id always equals the active registry user id; heartbeat makes health checkable; Compose grants no Docker socket or userbot mutation path.

**Checks:** `node --test scripts/lib/reminder-runner.test.ts scripts/reminder-scheduler.test.ts scripts/reminder-tool.test.ts scripts/container-scheduler-contract.test.ts`

- [ ] **Step 1: Write failing runner, interface, and Compose tests**

Use a fake clock and injected delivery:

```ts
const report = await runReminderTick({ now: () => due, deliver: capture });
assert.deepEqual(capture.calls[0], { chatId: "101", message: "Call Mom" });
assert.equal(await getJob("once-1").state, "completed");
assert.equal(await getJob("weekly-1").nextRunAt, nextMonday);
```

Cover retry, stale lease, same-tick dedupe, restart recovery, blocked user, cross-user isolation, coalescing, health heartbeat, structured CLI output, and Compose security/mount contracts.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test scripts/lib/reminder-runner.test.ts scripts/reminder-scheduler.test.ts scripts/reminder-tool.test.ts scripts/container-scheduler-contract.test.ts`

Expected: FAIL with missing runner/entry/tool/service.

- [ ] **Step 3: Implement runner and stable interfaces**

The service command is `node --env-file=.env scripts/reminder-scheduler.ts run`. It ticks at a bounded interval, writes `data/control/reminder-scheduler-status.json`, handles SIGTERM, and logs only ids/outcomes. CLI mutations require fixed user env and emit one JSON object. The Eve tool calls the same library without shell and exposes no destination field.

Add Compose service properties equivalent to:

```yaml
reminder-scheduler:
  image: ${IVA_IMAGE:?IVA_IMAGE is required}
  env_file: [${IVA_ENV_FILE:-./.env}]
  environment:
    IVA_RUNTIME: container
    ASSISTANT_DATA_DIR: /app/data
  command: ["npm", "run", "scheduler"]
  volumes:
    - ./data:/app/data
    - ./.env:/app/.env:ro
  restart: unless-stopped
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
```

- [ ] **Step 4: Run focused tests, typecheck, and authored-agent build**

Run: `node --test scripts/lib/reminder-runner.test.ts scripts/reminder-scheduler.test.ts scripts/reminder-tool.test.ts scripts/container-scheduler-contract.test.ts && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit the unit**

```bash
git add scripts/lib/reminder-runner.ts scripts/lib/reminder-runner.test.ts scripts/reminder-scheduler.ts scripts/reminder-scheduler.test.ts agent/tools/reminders.ts scripts/reminder-tool.test.ts scripts/container-scheduler-contract.test.ts package.json deploy/container/compose.production.yml
git commit -m "feat(scheduler): run durable container reminders" -m "Add a dedicated scheduler service, scoped CLI and agent tool, private bot delivery, restart recovery, bounded retries, and health reporting. Keep destination identity derived from the active user registry and leave the personal userbot read-only."
```

---

### Task 4: Make Maintenance and status container-native

**Goal:** Ensure `/menu` diagnostics, cleanup, memory cycle, status, timers, and update guidance are accurate and usable without systemd.

**Dependencies:** Task 3 scheduler heartbeat/status and existing `svc-run.ts`, `schedule-runner.ts`, and menu state `personalRoot`.

**Files:**

- Create: `scripts/lib/container-maintenance.ts`
- Create: `scripts/lib/container-maintenance.test.ts`
- Modify: `scripts/lib/menu/service.ts`
- Modify: `scripts/lib/menu/service.test.ts`
- Modify: `scripts/lib/menu/status.ts`
- Modify: `scripts/lib/menu/status.test.ts`
- Modify: `scripts/lib/menu/crons.ts`
- Modify: `scripts/lib/menu/crons.test.ts`
- Modify: `scripts/lib/menu/svc-run.ts`
- Modify: `scripts/lib/menu/svc-run.test.ts`
- Modify: `scripts/poller/control.ts`
- Modify: `deploy/container/compose.production.yml`

**Accepted decisions:** `IVA_RUNTIME=container` selects the adapter. Container actions are attached bounded processes; no Docker socket, `systemctl`, `systemd-run`, `crontab`, self-restart, or in-chat update execution.

**Interfaces:**

- Produces: `containerMaintenanceSpec(command, context): ProcessSpec`, `readContainerRuntimeStatus(...)`, and per-process explicit environment in `startProcess`.
- Consumes: authenticated menu state's absolute `personalRoot`, personal data/vault paths, scheduler heartbeat, and existing update UI copy.

**DoD:** Doctor checks writable private paths, `gws`, Eve/poller evidence, scheduler heartbeat, and last schedule outcome without host claims. Cleanup uses the user's vault. Memory uses the deterministic runner/lock/status path. Status reads Google config from the selected user and shows runtime/scheduler state. Timers list personal reminders rather than calling systemd. Update button shows exact Compose/deployment guidance.

**Checks:** `node --test scripts/lib/container-maintenance.test.ts scripts/lib/menu/service.test.ts scripts/lib/menu/status.test.ts scripts/lib/menu/crons.test.ts scripts/lib/menu/svc-run.test.ts`

- [ ] **Step 1: Write failing container-mode menu and process tests**

Assert:

```ts
assert.equal(
  calls.some(({ file }) => file === "systemctl"),
  false,
);
assert.equal(spec.cwd, "/app/data/users/101/vault");
assert.equal(spec.env?.HOME, "/app/data/users/101");
assert.match(updateView.text, /docker compose pull/u);
assert.match(statusView.text, /Scheduler: ready/u);
```

Also prove host-mode behavior remains unchanged and one user's status never reads another user's `.config/gws` or reminders.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test scripts/lib/container-maintenance.test.ts scripts/lib/menu/service.test.ts scripts/lib/menu/status.test.ts scripts/lib/menu/crons.test.ts scripts/lib/menu/svc-run.test.ts`

Expected: FAIL on systemd calls and missing container adapter.

- [ ] **Step 3: Implement the runtime adapter and menu behavior**

Pass `personalRoot` from the menu state into every spec. Extend process specs with an explicit child environment. In container mode, run doctor/cleanup/memory foreground commands; render update guidance instead of delegating to `handleUpdateCheck`; read personal reminder and heartbeat status. Keep host adapter branches intact.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test scripts/lib/container-maintenance.test.ts scripts/lib/menu/service.test.ts scripts/lib/menu/status.test.ts scripts/lib/menu/crons.test.ts scripts/lib/menu/svc-run.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the unit**

```bash
git add scripts/lib/container-maintenance.ts scripts/lib/container-maintenance.test.ts scripts/lib/menu/service.ts scripts/lib/menu/service.test.ts scripts/lib/menu/status.ts scripts/lib/menu/status.test.ts scripts/lib/menu/crons.ts scripts/lib/menu/crons.test.ts scripts/lib/menu/svc-run.ts scripts/lib/menu/svc-run.test.ts scripts/poller/control.ts deploy/container/compose.production.yml
git commit -m "feat(container): adapt Maintenance runtime" -m "Run diagnostics, vault cleanup, and memory maintenance as bounded per-user container processes, report scheduler and Google state accurately, and replace unavailable systemd update actions with truthful operator guidance. Preserve existing host behavior."
```

---

### Task 5: Document interfaces and verify the complete branch

**Goal:** Make the scheduler consumable by later branches and prove every completion-contract item from fresh evidence.

**Dependencies:** Tasks 1-4 complete.

**Files:**

- Create: `docs/scheduler.md`
- Modify: `agent/instructions.md`
- Modify: `docs/deploy.md`
- Modify: `docs/configuration.md`
- Modify: `deploy/container/runtime.env.example`
- Modify: `README.md` only if setup/product commands are now inaccurate
- Modify: `README.ru.md` only if the matching Russian setup/product commands are inaccurate

**Accepted decisions:** User reminders use the `reminders` tool, not bash or host schedulers. Documentation states at-least-once delivery and the narrow duplicate window. Future daily/weekly branches use the stable tool/library contract.

**Interfaces:**

- Documents: schema version, action inputs/outputs, one-off/cron semantics, timezone/DST behavior, restart recovery, retry/coalescing, private delivery invariant, health/status, and Compose lifecycle.

**DoD:** Agent instructions contain no active recommendation to use `systemd-run` or `crontab` for user reminders; container deployment includes scheduler lifecycle and `gws` verification; docs preserve Google and Telegram policies; full checks pass; final review has no unresolved findings; branch is clean and local-only.

**Checks:** full commands below plus `git status --short --branch`.

- [ ] **Step 1: Write documentation and contract assertions**

Update reminder instructions to say:

```md
Use the `reminders` tool for one-off and recurring user reminders. Never create
`systemd-run`, crontab, detached shell, or userbot delivery jobs.
```

Document exact CLI examples using JSON inputs without arbitrary chat ids.

- [ ] **Step 2: Run documentation/policy scans**

Run: `rg -n 'systemd-run|crontab' agent/instructions.md docs/scheduler.md docs/deploy.md`

Expected: only migration/history or explicit prohibition text; no active user-reminder instruction using host schedulers.

- [ ] **Step 3: Run fresh full verification**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
git diff --check HEAD~4
git ls-files data attachments vault .env '.env.*'
rg -n '/Users/|/home/[^ ]+|TELEGRAM_EXPOSED_TOOLS.*(send|write)|systemd-run|crontab' Containerfile deploy/container scripts/lib/reminder-* scripts/reminder-scheduler.ts agent/tools/reminders.ts agent/instructions.md docs/scheduler.md
```

Expected: all commands PASS; tracked-private-data listing empty; scans show no machine-specific paths or mutation capability and only intentional scheduler prohibitions/history.

- [ ] **Step 4: Request and apply code review**

Invoke `requesting-code-review` on the complete diff from `962e8dd` to HEAD. Resolve every finding through `receiving-code-review`, rerun affected checks, and record any accepted residual risk.

- [ ] **Step 5: Commit documentation or verification fixes**

```bash
git add docs/scheduler.md agent/instructions.md docs/deploy.md docs/configuration.md deploy/container/runtime.env.example README.md README.ru.md
git commit -m "docs(container): document reminder scheduling" -m "Describe the stable reminder interfaces, durability and retry semantics, private delivery boundary, Google CLI verification, and container Maintenance lifecycle for operators and future feature branches."
```

- [ ] **Step 6: Audit the completion contract**

Re-read `docs/superpowers/specs/2026-08-09-container-foundation-design.md`, map every requirement to a fresh command/output, confirm `git status --short --branch` is clean on `strongf/container-foundation`, confirm no remote action occurred, then mark the persistent goal complete.
