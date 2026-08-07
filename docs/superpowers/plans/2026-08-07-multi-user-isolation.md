# Multi-User Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project policy requires application implementation to stay in the main agent; do not use subagent-driven development.

**Goal:** Run up to ten mutually untrusted Telegram users through one Iva bot while keeping every conversation, vault, runtime state, integration, schedule, and quota isolated by verified Telegram user ID.

**Architecture:** Keep one Telegram gateway and one control registry, then route each private-chat update to a fixed per-user Eve worker. Every worker runs from a private runtime root so Eve's cwd-bound `.eve/.workflow-data` store, settings, queue-adjacent state, and schedules remain separate; shared code and build artifacts are mounted into that runtime view read-only. Model-facing tools are vault-bounded for every Telegram role, including owner, while server administration remains local CLI-only.

**Tech Stack:** TypeScript ESM, Node.js 24, Eve 0.29, zod, Node test runner, systemd user units, atomic JSON/file stores, Telegram Bot API.

## Global Constraints

- Support at most 10 active users and private Telegram chats only.
- Treat users as mutually untrusted; verified Telegram `from.id` is the only tenant selector.
- Keep `.env`, `.env.*`, `data`, `attachments`, `/vault/`, user vaults, credentials, and sessions untracked.
- Keep one shared bot/server/provider configuration; all user data and runtime state are personal.
- No Telegram command, menu, model tool, callback, or synthetic update may read another user's data, including for owner.
- Full host access remains local terminal-only; multi-user Telegram workers cannot execute host-native bash or accept arbitrary absolute paths.
- Preserve the owner vault through copy-verify-switch migration with rollback evidence.
- Any authored `agent/` change requires `npm run build` before runtime verification.
- Persisted formats are versioned and backward-compatible with the old installed CLI update boundary.
- Default quotas: 1 concurrent turn, 30 requests/hour, 100 requests/day, 500,000 LLM tokens/day, 30 audio minutes/day, 20 MB/attachment, 1 GB/user.
- Node 24 and Linux are the supported verification runtime. The current macOS baseline has 829 passing tests, 4 skips, and 3 pre-existing platform/fixture failures documented in the design handoff.

---

## File and Interface Map

- `scripts/lib/user-registry.ts`: versioned control-plane schema, atomic mutations, ID validation, default limits.
- `scripts/lib/user-layout.ts`: bounded personal paths and runtime-view creation.
- `scripts/cli/users.ts`: local `iva users ...` command group; no Telegram entrypoint.
- `scripts/poller/tenant-routing.ts`: private-chat tenant resolution and worker endpoint selection.
- `scripts/poller/config.ts`: gateway/control paths only; no longer assumes one Eve route for every user.
- `scripts/poller/deliver.ts`, `scripts/poller/routing.ts`, `scripts/poller/control.ts`: pass a resolved tenant route rather than global `ROUTE` constants.
- `scripts/cli/systemd.ts`: gateway unit plus one generated worker unit per active registry entry.
- `scripts/worker-entry.ts`: validate one registry-backed worker identity and launch Eve with fixed personal environment.
- `agent/lib/safe-user-path.ts`: one realpath-aware resolver shared by every model-facing filesystem tool.
- `agent/tools/{bash,read_file,write_file,glob,grep}.ts`: disable host shell and enforce personal-root paths in multi-user mode.
- `scripts/lib/user-quota.ts`: atomic ingress, audio, token, and storage accounting.
- `agent/hooks/usage.ts`: attribute usage to the fixed worker user and update personal usage.
- `scripts/lib/user-migration.ts`: idempotent legacy owner migration and rollback manifest.
- `docs/{configuration,deploy,security}.md`, `README.md`, `README.ru.md`: accurate multi-user operation and trust boundary.

---

### Task 1: Versioned User Registry and Personal Layout

**Files:**

- Create: `scripts/lib/user-registry.ts`
- Create: `scripts/lib/user-registry.test.ts`
- Create: `scripts/lib/user-layout.ts`
- Create: `scripts/lib/user-layout.test.ts`

**Interfaces:**

- Produces: `TelegramUserId`, `UserRecord`, `UserLimits`, `UserRegistry`, `parseTelegramUserId(value)`, `readUserRegistry(controlDir)`, `mutateUserRegistry(controlDir, mutation)`, `addUser(controlDir, input)`, `setUserStatus(controlDir, id, status)`, `updateUserLimits(controlDir, id, patch)`, `defaultUserLimits()`, `resolveUserLayout(usersDir, userId)`, `ensureUserLayout(layout, appRoot)`.
- Consumes: `loadJsonStrict`, `saveJsonAtomic`, `acquireLock`, and `releaseLock` from `agent/lib/json-store.ts`.

- [ ] **Step 1: Write failing registry tests**

```ts
test("registry rejects malformed ids and more than ten active users", async () => {
  assert.equal(parseTelegramUserId("01"), null);
  assert.equal(parseTelegramUserId("../7"), null);
  assert.equal(parseTelegramUserId("7"), "7");
  const control = fixture();
  for (let id = 1; id <= 10; id++)
    await addUser(control, {
      id: String(id),
      role: id === 1 ? "owner" : "user",
    });
  await assert.rejects(
    () => addUser(control, { id: "11", role: "user" }),
    /10 active users/,
  );
});

test("concurrent mutations preserve distinct users and private file modes", async () => {
  const control = fixture();
  await Promise.all([
    addUser(control, { id: "101", role: "owner" }),
    addUser(control, { id: "202", role: "user" }),
  ]);
  assert.deepEqual(
    readUserRegistry(control)
      .users.map((user) => user.id)
      .sort(),
    ["101", "202"],
  );
  assert.equal(statSync(join(control, "users.json")).mode & 0o777, 0o600);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/lib/user-registry.test.ts scripts/lib/user-layout.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement the schema and atomic mutation API**

```ts
export const USER_REGISTRY_SCHEMA = "iva-users/v1" as const;
export type TelegramUserId = string & {
  readonly __telegramUserId: unique symbol;
};
export type UserLimits = {
  concurrentTurns: number;
  requestsPerHour: number;
  requestsPerDay: number;
  llmTokensPerDay: number;
  audioSecondsPerDay: number;
  attachmentBytes: number;
  storageBytes: number;
};
export type UserRecord = {
  id: TelegramUserId;
  role: "owner" | "user";
  status: "active" | "blocked";
  port: number;
  limits: UserLimits;
  createdAt: string;
};
export type UserRegistry = {
  schema: typeof USER_REGISTRY_SCHEMA;
  revision: number;
  users: UserRecord[];
};

export function parseTelegramUserId(value: unknown): TelegramUserId | null {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
    ? (value as TelegramUserId)
    : null;
}

export async function addUser(
  controlDir: string,
  input: { id: string; role: "owner" | "user"; now?: Date },
): Promise<UserRecord>;
export async function setUserStatus(
  controlDir: string,
  id: TelegramUserId,
  status: "active" | "blocked",
): Promise<UserRecord>;
export async function updateUserLimits(
  controlDir: string,
  id: TelegramUserId,
  patch: Partial<UserLimits>,
): Promise<UserRecord>;
```

Use zod strict schemas when reading persisted JSON. Allocate worker ports from a bounded range starting at `IVA_WORKER_PORT_BASE` (default `8800`), reject duplicates, require exactly zero or one owner, cap active records at 10, and write `users.json` under the existing tokenized JSON lock.

- [ ] **Step 4: Implement bounded layout creation**

```ts
export type UserLayout = {
  root: string;
  vault: string;
  runtime: string;
  data: string;
  sessions: string;
  integrations: string;
  usage: string;
};

export function resolveUserLayout(
  usersDir: string,
  userId: TelegramUserId,
): UserLayout {
  const root = resolve(usersDir, userId);
  const base = resolve(usersDir);
  if (!root.startsWith(`${base}${sep}`))
    throw new Error("user layout escaped users root");
  return {
    root,
    vault: join(root, "vault"),
    runtime: join(root, "runtime"),
    data: join(root, "runtime", "data"),
    sessions: join(root, "runtime", ".eve", ".workflow-data"),
    integrations: join(root, "integrations"),
    usage: join(root, "usage"),
  };
}
```

`ensureUserLayout` creates directories as `0700` and a runtime view containing only the shared paths required to start Eve. It must reject pre-existing symlinks for personal directories and never link `.env`, another user's root, `data/control`, or the legacy vault.

- [ ] **Step 5: Verify GREEN and regression safety**

Run: `node --test scripts/lib/user-registry.test.ts scripts/lib/user-layout.test.ts scripts/json-store.test.ts`

Expected: PASS with registry concurrency, modes, active-user cap, traversal, and symlink tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/user-registry.ts scripts/lib/user-registry.test.ts scripts/lib/user-layout.ts scripts/lib/user-layout.test.ts
git commit -m "feat(users): add isolated user registry and layouts" -m "Introduce the versioned control-plane registry and bounded per-user runtime paths needed for safe multi-user routing. Validate IDs, enforce the ten-user cap, and create private layouts atomically."
```

---

### Task 2: Local User Administration CLI

**Files:**

- Create: `scripts/cli/users.ts`
- Create: `scripts/cli/users.test.ts`
- Modify: `scripts/cli/main.ts`
- Modify: `scripts/cli/main.test.ts`
- Modify: `scripts/cli/entrypoints.test.ts`

**Interfaces:**

- Consumes: registry/layout functions from Task 1.
- Produces: `createUsersCommands(deps)` returning `cmdUsers(args): Promise<void>` and CLI verbs `list`, `add`, `block`, `unblock`, `limits`, `delete`.

- [ ] **Step 1: Write failing command tests**

```ts
test("add creates a blocked candidate and activates only after layout health", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(fakeDeps(calls));
  await command.cmdUsers(["add", "123", "--owner"]);
  assert.deepEqual(calls, [
    "registry:add-blocked:123",
    "layout:123",
    "worker-health:123",
    "registry:activate:123",
  ]);
});

test("delete requires the exact repeated id and quarantines instead of unlinking", async () => {
  const command = createUsersCommands(fakeDeps([]));
  await assert.rejects(
    () => command.cmdUsers(["delete", "123", "--confirm", "321"]),
    /exact Telegram ID/,
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/cli/users.test.ts scripts/cli/main.test.ts scripts/cli/entrypoints.test.ts`

Expected: FAIL because the command group is not registered.

- [ ] **Step 3: Implement the command factory and parser**

```ts
export function createUsersCommands(deps: UsersDeps) {
  async function cmdUsers(args: string[]): Promise<void> {
    const [verb = "list", idRaw, ...tail] = args;
    if (verb === "list") return deps.print(renderUsers(deps.readRegistry()));
    const id = parseTelegramUserId(idRaw);
    if (!id) throw new Error("Telegram ID must be a positive decimal integer");
    if (verb === "add")
      return addUserTransaction(deps, id, tail.includes("--owner"));
    if (verb === "block") return blockUserTransaction(deps, id);
    if (verb === "unblock") return unblockUserTransaction(deps, id);
    if (verb === "limits") return updateLimitsTransaction(deps, id, tail);
    if (verb === "delete") return quarantineUserTransaction(deps, id, tail);
    throw new Error(`unknown users command: ${verb}`);
  }
  return { cmdUsers };
}
```

Keep all dependencies injectable. `list` prints ID, role, status, port, process health, and quota totals only. `delete` blocks first, stops the worker, then renames the personal root to `data/quarantine/user-<id>-<timestamp>`; it never recursively deletes.

- [ ] **Step 4: Register only the local CLI entrypoint**

Add `users: commands.cmdUsers` to the CLI command map and help copy. Do not add Telegram commands, callbacks, menu rows, or model tools.

- [ ] **Step 5: Verify GREEN**

Run: `node --test scripts/cli/users.test.ts scripts/cli/main.test.ts scripts/cli/entrypoints.test.ts`

Expected: PASS, including no import-time mutations and no secret/path output.

- [ ] **Step 6: Commit**

```bash
git add scripts/cli/users.ts scripts/cli/users.test.ts scripts/cli/main.ts scripts/cli/main.test.ts scripts/cli/entrypoints.test.ts
git commit -m "feat(cli): manage isolated Iva users" -m "Add local-only lifecycle commands for creating, blocking, limiting, and quarantining users without exposing personal data through Telegram."
```

---

### Task 3: Private-Chat Gateway and Tenant Routing

**Files:**

- Create: `scripts/poller/tenant-routing.ts`
- Create: `scripts/poller/tenant-routing.test.ts`
- Modify: `scripts/poller/config.ts`
- Modify: `scripts/poller/main.ts`
- Modify: `scripts/poller/routing.ts`
- Modify: `scripts/poller/deliver.ts`
- Modify: `scripts/poller/control.ts`
- Modify: `scripts/poller/config.test.ts`
- Modify: `scripts/telegram-poll.test.ts`

**Interfaces:**

- Consumes: `readUserRegistry`, `parseTelegramUserId`.
- Produces: `resolveTenant(update, registry): TenantRouteResult`, `workerRoutes(record): WorkerRoutes`, where the result is `active`, `blocked`, `unknown`, or `non-private` and active carries fixed acceptance/reset/callback URLs.

- [ ] **Step 1: Write failing routing tests**

```ts
test("verified from.id selects the worker and chat text cannot override it", () => {
  const update = privateUpdate({ fromId: 123, text: "tenant=999" });
  assert.deepEqual(resolveTenant(update, registry([active("123", 8800)])), {
    kind: "active",
    userId: "123",
    port: 8800,
  });
});

test("groups, missing senders, unknown users, and blocked users fail closed", () => {
  assert.equal(resolveTenant(groupUpdate(), registry([])).kind, "non-private");
  assert.equal(
    resolveTenant(privateUpdate({ fromId: 7 }), registry([])).kind,
    "unknown",
  );
  assert.equal(
    resolveTenant(privateUpdate({ fromId: 8 }), registry([blocked("8")])).kind,
    "blocked",
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/poller/tenant-routing.test.ts scripts/poller/config.test.ts scripts/telegram-poll.test.ts`

Expected: FAIL because routing still uses one global `HOST`.

- [ ] **Step 3: Implement fail-closed tenant resolution**

```ts
export type TenantRouteResult =
  | { kind: "active"; userId: TelegramUserId; port: number }
  | { kind: "blocked" | "unknown" | "non-private" };

export function resolveTenant(
  update: TelegramQueueUpdate,
  registry: UserRegistry,
): TenantRouteResult {
  const message = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  if (message?.chat?.type !== "private") return { kind: "non-private" };
  const id = parseTelegramUserId(String(from?.id ?? ""));
  if (!id) return { kind: "unknown" };
  const user = registry.users.find((candidate) => candidate.id === id);
  if (!user) return { kind: "unknown" };
  return user.status === "active"
    ? { kind: "active", userId: id, port: user.port }
    : { kind: "blocked" };
}
```

- [ ] **Step 4: Thread explicit routes through delivery**

Replace imported singleton `ROUTE`, `ACCEPTANCE_ROUTE`, and `RESET_ROUTE` usage with a required `WorkerRoutes` argument. Preserve one shared bot API and gateway queue, but store `userId` in every queue item and reject a loaded queue item whose verified sender no longer matches its stored user.

- [ ] **Step 5: Gate controls and callbacks**

Only owner identity may invoke owner-only userbot/update/service controls, and those controls must not expose a cross-user filesystem operation. Unknown, blocked, and non-private updates are acknowledged without delivery; no user layout is created at ingress.

- [ ] **Step 6: Verify GREEN and cross-tenant replay resistance**

Run: `node --test scripts/poller/tenant-routing.test.ts scripts/poller/config.test.ts scripts/telegram-poll.test.ts scripts/lib/telegram-queue.test.ts`

Expected: PASS with private-only routing, stored-sender revalidation, callback isolation, and unchanged durable offset semantics.

- [ ] **Step 7: Commit**

```bash
git add scripts/poller scripts/telegram-poll.test.ts
git commit -m "feat(gateway): route private chats to user workers" -m "Resolve every update from its verified Telegram sender and deliver it only to the active worker assigned in the control registry. Reject groups, blocked identities, and stale cross-user queue records."
```

---

### Task 4: Per-User Eve Worker Lifecycle

**Files:**

- Create: `scripts/worker-entry.ts`
- Create: `scripts/worker-entry.test.ts`
- Create: `scripts/lib/worker-units.ts`
- Create: `scripts/lib/worker-units.test.ts`
- Modify: `scripts/cli/systemd.ts`
- Modify: `scripts/cli/services.ts`
- Modify: `scripts/cli/doctor.ts`
- Modify: `deploy/iva-telegram-poll.service`
- Modify: `scripts/lib/systemd-control.test.ts`
- Modify: `scripts/production/deploy-script.test.ts`

**Interfaces:**

- Consumes: registry and layout APIs.
- Produces: `workerServiceName(id)`, `renderWorkerUnit(record, layout, runtime)`, `desiredWorkerUnits(registry)`, and executable worker bootstrap.

- [ ] **Step 1: Write failing unit and bootstrap tests**

```ts
test("worker unit fixes cwd, paths, port, identity, and rebuild dependency", () => {
  const unit = renderWorkerUnit(
    active("123", 8800),
    layout("123"),
    runtimeFixture(),
  );
  assert.match(unit, /WorkingDirectory=.*data\/users\/123\/runtime/);
  assert.match(unit, /Environment=ASSISTANT_USER_ID=123/);
  assert.match(unit, /Environment=ASSISTANT_VAULT_DIR=.*users\/123\/vault/);
  assert.match(unit, /Environment=PORT=8800/);
  assert.doesNotMatch(unit, /TELEGRAM_ALLOWED_USER_IDS=.*,/);
});

test("bootstrap refuses an id, port, or layout not matching the registry", async () => {
  await assert.rejects(
    () =>
      prepareWorker({
        userId: "999",
        registry: registry([active("123", 8800)]),
      }),
    /not active/,
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/worker-entry.test.ts scripts/lib/worker-units.test.ts scripts/lib/systemd-control.test.ts`

Expected: FAIL because workers do not exist.

- [ ] **Step 3: Implement a fixed-identity worker bootstrap**

The entrypoint loads one active registry record, verifies directory ownership/modes and runtime links, constructs a minimal environment with personal paths plus shared provider configuration, then spawns the shared Eve CLI from the personal runtime cwd. It must not accept a port or path from Telegram or arbitrary CLI text.

```ts
export async function prepareWorker(
  input: WorkerInput,
): Promise<PreparedWorker> {
  const id = parseTelegramUserId(input.userId);
  if (!id) throw new Error("invalid worker user id");
  const record = readUserRegistry(input.controlDir).users.find(
    (user) => user.id === id,
  );
  if (!record || record.status !== "active")
    throw new Error("worker user is not active");
  const layout = resolveUserLayout(input.usersDir, id);
  await verifyUserLayout(layout);
  return {
    cwd: layout.runtime,
    port: record.port,
    env: workerEnvironment(record, layout, input.appRoot),
  };
}
```

- [ ] **Step 4: Generate exact user units and remove stale ones safely**

`writeUnits()` writes the gateway plus `iva-worker-<id>.service` for active records, disables/removes only stale units matching `^iva-worker-[1-9][0-9]*\.service$`, reloads systemd, and never removes the legacy `iva.service` until migration has completed and the new build is verified.

- [ ] **Step 5: Update lifecycle and doctor**

`start`, `stop`, `restart`, `status`, deploy checks, and doctor operate on the gateway and desired worker list. A single failed worker is reported by ID without exposing its personal paths. Update performs one shared `npm run build` before restarting any worker.

- [ ] **Step 6: Verify GREEN**

Run: `node --test scripts/worker-entry.test.ts scripts/lib/worker-units.test.ts scripts/cli/services.test.ts scripts/cli/doctor.test.ts scripts/lib/systemd-control.test.ts scripts/production/deploy-script.test.ts`

Expected: PASS with exact unit allowlists, stale-unit cleanup, fixed cwd, and no start after a failed build.

- [ ] **Step 7: Commit**

```bash
git add scripts/worker-entry.ts scripts/worker-entry.test.ts scripts/lib/worker-units.ts scripts/lib/worker-units.test.ts scripts/cli/systemd.ts scripts/cli/services.ts scripts/cli/doctor.ts deploy/iva-telegram-poll.service scripts/lib/systemd-control.test.ts scripts/production/deploy-script.test.ts
git commit -m "feat(runtime): run one Eve worker per user" -m "Generate fixed-identity worker services with private cwd-bound workflow stores while keeping one shared gateway and build. Extend lifecycle and diagnostics without exposing personal paths."
```

---

### Task 5: Model Tool and Filesystem Isolation

**Files:**

- Create: `agent/lib/safe-user-path.ts`
- Create: `agent/lib/safe-user-path.test.ts`
- Modify: `agent/tools/bash.ts`
- Modify: `agent/tools/read_file.ts`
- Modify: `agent/tools/write_file.ts`
- Modify: `agent/tools/glob.ts`
- Modify: `agent/tools/grep.ts`
- Modify: `agent/tools/memory_search.ts`
- Modify: `scripts/bash-tool.test.ts`
- Modify: `scripts/vault-tools-paths.test.ts`

**Interfaces:**

- Produces: `multiUserMode()`, `personalRoot()`, `resolvePersonalReadPath(relative)`, `resolvePersonalWritePath(relative)`, `assertNoSymlinkEscape(path)`.
- Consumes: fixed personal environment from Task 4.

- [ ] **Step 1: Write adversarial failing tests**

```ts
test("multi-user paths reject absolute, traversal, and symlink escapes", async () => {
  assert.throws(() => resolvePersonalReadPath("/etc/passwd"), /relative path/);
  assert.throws(
    () => resolvePersonalReadPath("../202/vault/CORE.md"),
    /personal root/,
  );
  symlinkSync(otherUserRoot, join(personalRoot, "alias"));
  assert.throws(() => resolvePersonalReadPath("alias/CORE.md"), /symlink/);
});

test("host bash is unavailable even to the Telegram owner worker", async () => {
  process.env.IVA_MULTI_USER = "1";
  process.env.ASSISTANT_ROLE = "owner";
  assert.deepEqual(await bash.execute({ command: "pwd" }), {
    stdout: "",
    stderr: "Host shell is unavailable in multi-user Telegram workers.",
    exitCode: 1,
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test agent/lib/safe-user-path.test.ts scripts/bash-tool.test.ts scripts/vault-tools-paths.test.ts`

Expected: FAIL because tools currently accept host paths.

- [ ] **Step 3: Implement one resolver and apply it everywhere**

```ts
export function resolvePersonalReadPath(value: string): string {
  if (isAbsolute(value) || value.includes("\0"))
    throw new Error("path must be relative");
  const base = realpathSync(personalRoot());
  const target = realpathSync(resolve(base, value));
  if (target !== base && !target.startsWith(`${base}${sep}`))
    throw new Error("path escaped personal root");
  return target;
}
```

For writes, resolve the nearest existing parent, reject symlinks in every existing component, open with exclusive/no-follow-safe behavior where Node supports it, and recheck the parent before atomic rename. Preserve legacy host-native behavior only when `IVA_MULTI_USER !== "1"` so existing single-user installations remain backward-compatible until migration.

- [ ] **Step 4: Disable host shell and bound search tools**

In multi-user mode `bash` fails before parsing/spawning. `read_file`, `write_file`, `glob`, and `grep` accept only personal-root-relative paths; their descriptions stop advertising host access. `memory_search` remains vault-relative and validates any graph/index override against the personal root.

- [ ] **Step 5: Verify GREEN and build**

Run: `node --test agent/lib/safe-user-path.test.ts scripts/bash-tool.test.ts scripts/vault-tools-paths.test.ts scripts/write-card.test.ts && npm run typecheck && npm run build`

Expected: PASS and a fresh `.output` containing the bounded tools.

- [ ] **Step 6: Commit**

```bash
git add agent/lib/safe-user-path.ts agent/lib/safe-user-path.test.ts agent/tools scripts/bash-tool.test.ts scripts/vault-tools-paths.test.ts
git commit -m "feat(security): confine Telegram workers to personal data" -m "Disable model-driven host shell access and apply one traversal- and symlink-safe path resolver to every filesystem-facing tool in multi-user mode. Preserve legacy behavior before migration."
```

---

### Task 6: Per-User Quotas and Usage

**Files:**

- Create: `scripts/lib/user-quota.ts`
- Create: `scripts/lib/user-quota.test.ts`
- Modify: `scripts/poller/tenant-routing.ts`
- Modify: `scripts/poller/routing.ts`
- Modify: `agent/hooks/usage.ts`
- Modify: `scripts/lib/usage.ts`
- Modify: `agent/channels/telegram.ts`

**Interfaces:**

- Produces: `reserveIngress(controlDir, user, kind, amount, now)`, `releaseTurn(...)`, `recordTokens(...)`, `quotaStatus(...)`.
- Consumes: fixed registry limits and `ASSISTANT_USER_ID`.

- [ ] **Step 1: Write failing quota tests**

```ts
test("users consume independent hourly, daily, token, audio, and concurrency limits", async () => {
  const first = await reserveIngress(control, user("101"), "request", 1, now);
  const second = await reserveIngress(control, user("202"), "request", 1, now);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  await fillDailyRequests(control, "101", 100, now);
  assert.equal(
    (await reserveIngress(control, user("101"), "request", 1, now)).ok,
    false,
  );
  assert.equal((await quotaStatus(control, "202", now)).requests.day, 1);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/lib/user-quota.test.ts scripts/lib/usage.test.ts scripts/poller/tenant-routing.test.ts`

Expected: FAIL because there is no quota state.

- [ ] **Step 3: Implement tokenized atomic reservations**

Persist `iva-quota/v1` records under `data/control/quota/<id>.json`, protected by per-user locks. A request reservation returns an opaque token; only the matching token releases concurrency. UTC hour/day keys are explicit strings so restarts do not reset limits.

- [ ] **Step 4: Enforce limits before expensive work**

The gateway reserves request/concurrency before delivery, rejects oversize attachments before download, charges declared Telegram audio duration before transcription, and checks current personal storage. Worker usage hooks record actual tokens after every step; the next ingress is rejected once the daily total reaches the limit.

- [ ] **Step 5: Verify GREEN**

Run: `node --test scripts/lib/user-quota.test.ts scripts/lib/usage.test.ts scripts/poller/tenant-routing.test.ts scripts/telegram-media-identity.test.ts`

Expected: PASS with concurrent writers, reset boundaries, crash-safe stale reservation recovery, and independent users.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/user-quota.ts scripts/lib/user-quota.test.ts scripts/poller/tenant-routing.ts scripts/poller/routing.ts agent/hooks/usage.ts scripts/lib/usage.ts agent/channels/telegram.ts
git commit -m "feat(quotas): enforce per-user usage limits" -m "Reserve ingress capacity atomically and account for requests, tokens, audio, attachments, concurrency, and storage without allowing one user to consume or reset another user's budget."
```

---

### Task 7: Personal Integrations, Schedules, and Owner Migration

**Files:**

- Create: `scripts/lib/user-migration.ts`
- Create: `scripts/lib/user-migration.test.ts`
- Modify: `scripts/lib/menu/gws.ts`
- Modify: `scripts/lib/menu/gws-auth.ts`
- Modify: `scripts/lib/menu/userbot.ts`
- Modify: `agent/lib/schedule-paths.ts`
- Modify: `agent/instrumentation.ts`
- Modify: `scripts/cli/update.ts`
- Modify: `scripts/cli/config.ts`
- Modify: `scripts/replica-smoke.ts`

**Interfaces:**

- Produces: `planOwnerMigration(input)`, `applyOwnerMigration(plan)`, `verifyOwnerMigration(plan)`, `rollbackOwnerMigration(plan)`.
- Consumes: registry, layout, worker lifecycle, and quota APIs.

- [ ] **Step 1: Write failing migration and integration tests**

```ts
test("legacy owner migration copies, hashes, switches atomically, and keeps rollback", async () => {
  const plan = await planOwnerMigration(fixtureWithOneAllowedId("123"));
  await applyOwnerMigration(plan);
  assert.deepEqual(await verifyOwnerMigration(plan), {
    ok: true,
    mismatches: [],
  });
  assert.equal(readUserRegistry(plan.controlDir).users[0].id, "123");
  assert.equal(existsSync(plan.backupDir), true);
});

test("migration refuses zero or multiple legacy ids before writes", async () => {
  await assert.rejects(
    () => planOwnerMigration(fixtureWithAllowedIds(["1", "2"])),
    /explicit owner/,
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test scripts/lib/user-migration.test.ts scripts/lib/menu/gws-auth.test.ts scripts/lib/menu/userbot.test.ts agent/lib/schedule-paths.test.ts`

Expected: FAIL because migration and personal integration boundaries are absent.

- [ ] **Step 3: Personalize integration and schedule paths**

Google OAuth state includes the fixed worker user ID and stores credentials under its `integrations` path. Userbot UI and MCP registration require `ASSISTANT_ROLE=owner`. Schedule roots use `ASSISTANT_APP_DIR` for shared scripts and personal data/vault/lock paths for state.

- [ ] **Step 4: Implement copy-verify-switch migration**

Build a manifest containing source path, destination path, byte size, and SHA-256 for every ordinary file. Copy without following symlinks, verify the manifest, write the owner registry record atomically, then mark migration `switched`. Preserve the timestamped backup and rollback manifest. Re-entry reads the phase and resumes or rolls back without duplicating data.

- [ ] **Step 5: Wire the old-CLI update boundary**

The old CLI may download the new code but must complete build before generating/starting workers. If the new build or migration verification fails, retain or restart the legacy `iva.service`; never remove it merely because source files changed.

- [ ] **Step 6: Verify GREEN and replica smoke**

Run: `node --test scripts/lib/user-migration.test.ts scripts/lib/menu/gws-auth.test.ts scripts/lib/menu/userbot.test.ts agent/lib/schedule-paths.test.ts scripts/cli/update.test.ts && npm run replica`

Expected: PASS with one-ID migration, multi-ID refusal, OAuth replay rejection, owner-only userbot, and rollback evidence.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/user-migration.ts scripts/lib/user-migration.test.ts scripts/lib/menu/gws.ts scripts/lib/menu/gws-auth.ts scripts/lib/menu/userbot.ts agent/lib/schedule-paths.ts agent/instrumentation.ts scripts/cli/update.ts scripts/cli/config.ts scripts/replica-smoke.ts
git commit -m "feat(migration): personalize integrations and migrate owner data" -m "Move legacy state through a verified copy-switch transaction, keep rollback evidence, and bind Google, schedules, and userbot capabilities to the fixed worker identity."
```

---

### Task 8: End-to-End Isolation, Documentation, and Release Evidence

**Files:**

- Create: `scripts/multi-user-isolation.test.ts`
- Modify: `scripts/production/release-contract.test.ts`
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `docs/configuration.md`
- Modify: `docs/deploy.md`
- Modify: `docs/security.md`
- Modify: `docs/faq.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: all previous tasks.
- Produces: one reproducible two-user harness and an accurate operator runbook.

- [ ] **Step 1: Write the two-user isolation test before final wiring**

```ts
test("two users cannot cross conversations, files, callbacks, integrations, quotas, or restarts", async () => {
  const app = await startMultiUserFixture(["101", "202"]);
  await app.send("101", "remember alpha");
  await app.send("202", "remember beta");
  assert.match(await app.search("101", "alpha"), /alpha/);
  assert.doesNotMatch(await app.search("101", "beta"), /beta/);
  await assert.rejects(
    () => app.readAs("101", "../202/vault/CORE.md"),
    /personal root/,
  );
  await app.block("101");
  assert.equal((await app.send("101", "again")).status, "blocked");
  assert.equal((await app.send("202", "again")).status, "delivered");
});
```

- [ ] **Step 2: Run the isolation test and verify RED**

Run: `node --test scripts/multi-user-isolation.test.ts`

Expected: FAIL at the first remaining unwired boundary.

- [ ] **Step 3: Complete only the wiring exposed by the test**

Do not add new architecture. Connect the already-defined registry, worker, safe-path, quota, integration, and migration interfaces until the harness passes.

- [ ] **Step 4: Update documentation accurately**

Document manual user commands, default limits, private-chat-only behavior, backup/rollback, per-user Google connections, owner-only userbot, and the honest boundary that the server owner can inspect disk locally. Remove the FAQ statement that Iva is single-user-only only after the end-to-end test passes.

- [ ] **Step 5: Run fresh verification**

Run with Node 24 on Linux:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run replica
npm run test:deploy
```

Expected: every command exits 0. Also verify the build contains all authored schedules and tools, and run two concurrent private-chat smoke requests against distinct worker ports.

- [ ] **Step 6: Review the complete diff**

Use `requesting-code-review`. Check secrets, `.gitignore`, registry/path validation, Telegram auth, old-CLI update compatibility, rebuild evidence, and every tool input against the project Code Review Rules. Resolve findings through `receiving-code-review` and rerun affected tests.

- [ ] **Step 7: Commit**

```bash
git add scripts/multi-user-isolation.test.ts scripts/production/release-contract.test.ts README.md README.ru.md docs/configuration.md docs/deploy.md docs/security.md docs/faq.md CHANGELOG.md
git commit -m "docs(multi-user): document isolated personal workers" -m "Add the verified two-user contract and operator guidance for private-chat routing, limits, migration, integration ownership, and the server-owner trust boundary."
```

- [ ] **Step 8: Stop at the authorized boundary**

The current request authorizes local implementation and verification only. Do not push, merge, deploy, modify a live bot, or migrate real user data without a new explicit instruction.
