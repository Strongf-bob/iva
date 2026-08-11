# Container Multi-User Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Iva's existing isolated per-user workers durably inside the production Telegram poller container and activate the two owner-confirmed Telegram users after a protected-main release.

**Architecture:** A deterministic TypeScript supervisor owns the Telegram poller and personalized worker child processes in one container/network namespace. A private, versioned filesystem command protocol lets `iva users` request idempotent lifecycle operations without Docker socket access; systemd remains unchanged outside containers.

**Tech Stack:** TypeScript ESM on Node.js 24, zod, atomic JSON stores, child processes, Docker Compose, Node test runner, GitHub Actions protected-main deployment.

## Global Constraints

- Numeric Telegram ID is the only persistent identity; inbound messages never auto-register users.
- Keep the existing limit of ten non-blocked users and all default quotas unchanged.
- Keep per-user vault, runtime, sessions, integrations, usage, allowlist, and digest paths isolated.
- Keep the personal Telegram userbot owner-only; ordinary workers receive no userbot token or host-native shell.
- Do not mount the Docker socket, add Linux capabilities, or interpolate user input into shell commands.
- Control directories are non-symlink mode `0700`; command, receipt, and status files are mode `0600`.
- Invalid registry/control state fails closed before Telegram updates are consumed.
- Preserve the existing systemd lifecycle on non-container installations.
- Any authored `agent/` change requires `npm run build`; the implementation should avoid `agent/` changes.
- Publication boundary is a reviewed PR merged through protected `main`, followed by automated deployment and independent production verification.

## Completion Contract

**Goal:** Durable Docker lifecycle plus verified access for `@KNFFRT` and `@strongf_ai`.

**In scope:** control protocol, supervisor, CLI lifecycle selection, Compose/deploy health contracts, tests, affected documentation, PR, merge, deploy, two production user additions, restart recovery verification.

**Out of scope:** automatic signup, username registry keys, owner migration, quota changes, userbot access for ordinary users, destructive deletion, unrelated contact-memory work.

**Protected state:** current dirty checkout; legacy owner vault/session/route; `.env`, tokens, Telegram session, existing production data; other worktrees and branches.

**Decisions requiring user approval:** expanding beyond the selected supervisor architecture; destructive removal/quarantine; granting more identities; weakening owner-only capabilities. The selected architecture, merge to `main`, automated deploy, and adding the two confirmed users are already approved.

**Finish boundary:** deploy.

**Evidence:**

- Container lifecycle -> focused protocol/supervisor/CLI tests and Compose contract tests.
- Isolation -> existing multi-user, worker bootstrap, routing, and quota tests plus new environment assertions.
- Release -> remote PR/check/merge SHA, deployed immutable image SHA, runtime health and restart counts.
- User access -> active registry records, distinct healthy ports, private layouts, supervisor status, and successful recovery after one poller-container restart.

**Stop conditions:** scope expansion requires new authority; an unapproved destructive/external action is required; or the same blocker repeats without a safe alternative.

---

### Task 1: Private container lifecycle protocol

**Goal:** Provide a strict, atomic, idempotent filesystem protocol shared by the supervisor and CLI.

**Dependencies:** Existing `agent/lib/json-store.ts`, `scripts/lib/user-registry.ts`, Node 24 filesystem APIs, zod.

**Touched files:**

- Create: `scripts/lib/container-worker-control.ts`
- Create: `scripts/lib/container-worker-control.test.ts`

**Accepted decisions:** Requests may select only an action and canonical user ID; registry data supplies port, paths, role, and limits. Receipts are durable and operation IDs are replay-safe.

**Interfaces:**

- Produces: `resolveContainerControlPaths(controlDir: string): ContainerControlPaths`
- Produces: `submitContainerCommand(controlDir, input, options?): Promise<ContainerCommandReceipt>`
- Produces: `claimContainerCommands(controlDir): ClaimedContainerCommand[]`
- Produces: `completeContainerCommand(controlDir, command, result): void`
- Produces: `recoverClaimedContainerCommands(controlDir): void`
- Produces: `writeContainerRuntimeStatus(controlDir, status): void`
- Produces: `readContainerRuntimeStatus(controlDir): ContainerRuntimeStatus`

**DoD:** Strict schemas reject extra fields, invalid IDs/actions, symlinks, wrong modes, corrupt receipts/status, and traversal. Duplicate completion returns the original receipt. Timeout errors preserve the operation ID for diagnosis.

**Checks:** `node --test scripts/lib/container-worker-control.test.ts`; `npm run typecheck`; `git diff --check`.

- [ ] **Step 1: Write failing schema and path-safety tests**

```ts
void test("container commands accept only canonical lifecycle inputs", async (t) => {
  const control = fixture(t);
  await assert.rejects(
    () => submitContainerCommand(control, { action: "start-worker", userId: "../7" }),
    /canonical Telegram user id/u,
  );
  await assert.rejects(
    () => submitContainerCommand(control, { action: "shell", userId: "7" } as never),
    /invalid container command/u,
  );
});

void test("control paths reject symlinks and stay private", async (t) => {
  const control = fixture(t);
  symlinkSync(t.tmp, join(control, "container-runtime"));
  await assert.rejects(
    () => submitContainerCommand(control, { action: "pause-poller" }),
    /symbolic link/u,
  );
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test scripts/lib/container-worker-control.test.ts`

Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement strict records and atomic directories**

```ts
export const CONTAINER_COMMAND_SCHEMA = "iva-container-command/v1" as const;
export type ContainerAction =
  | "start-worker"
  | "stop-worker"
  | "pause-poller"
  | "resume-poller";

export type ContainerCommandReceipt = {
  schema: "iva-container-receipt/v1";
  operationId: string;
  action: ContainerAction;
  userId: TelegramUserId | null;
  ok: boolean;
  message: string;
  completedAt: string;
};

export type ContainerRuntimeStatus = {
  schema: "iva-container-runtime-status/v1";
  supervisorPid: number;
  updatedAt: string;
  poller: { state: "running" | "stopped" | "backoff"; pid: number | null; restarts: number };
  workers: Record<string, {
    state: "running" | "stopped" | "backoff";
    pid: number | null;
    port: number;
    restarts: number;
  }>;
};

const ContainerCommandSchema = z.strictObject({
  schema: z.literal(CONTAINER_COMMAND_SCHEMA),
  operationId: z.uuid(),
  action: z.enum([
    "start-worker",
    "stop-worker",
    "pause-poller",
    "resume-poller",
  ]),
  userId: TelegramUserIdSchema.nullable(),
  createdAt: z.iso.datetime(),
});
```

Use `saveJsonAtomic`, `chmodSync`, `lstatSync`, `renameSync`, and bounded polling. Require `userId` exactly for worker actions and `null` exactly for poller actions.

- [ ] **Step 4: Add replay, receipt, recovery, timeout, and status tests**

```ts
void test("completion is durable and idempotent", async (t) => {
  const { control, command } = claimedFixture(t);
  completeContainerCommand(control, command, { ok: true, message: "started" });
  completeContainerCommand(control, command, { ok: true, message: "started" });
  assert.equal(readReceipt(control, command.operationId).ok, true);
});
```

Cover `.processing` recovery after restart and ensure status never accepts arbitrary keys containing environment or message data.

- [ ] **Step 5: Run checks and commit**

Run: `node --test scripts/lib/container-worker-control.test.ts && npm run typecheck && git diff --check`

Expected: all pass.

Commit:

```text
feat(container): add private worker control protocol

Add strict atomic lifecycle commands, durable receipts, recovery, and runtime status for container-managed Iva workers. Keep all control state private and reject malformed or path-escaping inputs before they can affect a process.

Verification: container worker control tests and typecheck pass.
```

### Task 2: Poller and worker supervisor

**Goal:** Own the poller and personalized workers in one container with deterministic recovery and bounded restarts.

**Dependencies:** Task 1 protocol; `readUserRegistry`; `prepareWorker` and `launchWorker`; existing `scripts/telegram-poll.mjs`.

**Touched files:**

- Create: `scripts/container-runtime.ts`
- Create: `scripts/container-runtime.test.ts`
- Modify: `scripts/worker-entry.ts` only if an injectable launch/termination seam is required.

**Accepted decisions:** Registry is durable desired state; runtime status is observation only. Worker failures never rewrite user policy. The poller starts only after registry/control validation succeeds.

**Interfaces:**

- Consumes: Task 1 claim/complete/status APIs.
- Produces: `createContainerRuntime(options): ContainerRuntime`
- Produces: `runContainerRuntimeFromEnv(): Promise<void>`
- Produces CLI mode: `node scripts/container-runtime.ts status --require-ready`

**DoD:** Startup reconciles `active` and `provisioning` users, blocked users never run, commands acknowledge only observed outcomes, SIGTERM shuts down children, worker crashes restart with bounded backoff, and malformed registry prevents poller startup.

**Checks:** `node --test scripts/container-runtime.test.ts scripts/worker-entry.test.ts scripts/multi-user-isolation.test.ts`; `npm run typecheck`.

- [ ] **Step 1: Write failing reconciliation tests with injected child handles**

```ts
void test("startup launches the poller and each routable worker once", async () => {
  const fixture = runtimeFixture([user("101", "active"), user("202", "provisioning")]);
  await fixture.runtime.tick();
  assert.deepEqual(fixture.started, ["poller", "worker:101", "worker:202"]);
  await fixture.runtime.tick();
  assert.deepEqual(fixture.started, ["poller", "worker:101", "worker:202"]);
});

void test("an invalid registry fails before poller launch", async () => {
  const fixture = corruptRegistryFixture();
  await assert.rejects(() => fixture.runtime.start(), /invalid user registry/u);
  assert.deepEqual(fixture.started, []);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test scripts/container-runtime.test.ts`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement a small injected runtime state machine**

```ts
export type ManagedChild = {
  pid: number | undefined;
  stop(signal: NodeJS.Signals): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export type ContainerRuntime = {
  start(): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
  status(): ContainerRuntimeStatus;
};
```

Keep poller and worker maps separate. Spawn with argument arrays. Derive worker arguments and filtered environment through `prepareWorker`; never accept a port/path from command JSON.

- [ ] **Step 4: Add command, crash-loop, and shutdown tests**

```ts
void test("stop receipt is written only after the exact worker exits", async () => {
  const fixture = runtimeFixture([user("101", "active")]);
  await fixture.runtime.start();
  const command = fixture.command("stop-worker", "101");
  await fixture.runtime.tick();
  assert.equal(fixture.receipt(command.operationId), null);
  fixture.exit("worker:101", 0);
  await fixture.runtime.tick();
  assert.equal(fixture.receipt(command.operationId)?.ok, true);
});
```

Cover pause acknowledgement after poller exit, resume, SIGTERM, one user's crash isolation, exponential delays capped at 30 seconds, and readiness failure while any required child is absent.

- [ ] **Step 5: Wire the real entrypoint and status command**

Use `ASSISTANT_APP_DIR`, `ASSISTANT_DATA_DIR`, and explicit `IVA_CONTAINER_RUNTIME=1`. Refuse relative app/data roots in production mode. Status output is a terse pass/fail line and contains no environment values.

- [ ] **Step 6: Run checks and commit**

Run: `node --test scripts/container-runtime.test.ts scripts/worker-entry.test.ts scripts/multi-user-isolation.test.ts && npm run typecheck && git diff --check`

Commit:

```text
feat(container): supervise Telegram tenant workers

Run the Telegram poller and isolated personalized workers under one deterministic container supervisor. Reconcile durable registry state, bound child restarts, and expose a non-secret readiness check for deployment verification.

Verification: container runtime, worker bootstrap, multi-user isolation tests, and typecheck pass.
```

### Task 3: Container-aware `iva users` lifecycle

**Goal:** Make existing user transactions use the supervisor protocol inside the poller container while retaining systemd elsewhere.

**Dependencies:** Tasks 1-2 protocol/status; existing `createUsersCommands` transaction ordering.

**Touched files:**

- Create: `scripts/cli/container-workers.ts`
- Create: `scripts/cli/container-workers.test.ts`
- Modify: `scripts/cli/users.ts`
- Modify: `scripts/cli/main.ts`
- Modify: `scripts/cli/users.test.ts`

**Accepted decisions:** Lifecycle selection requires explicit `IVA_CONTAINER_RUNTIME=1`; no implicit systemd fallback occurs inside a container.

**Interfaces:**

- Produces: `createContainerWorkerLifecycle(runtime): WorkerLifecycle`
- Exports `WorkerLifecycle` from `scripts/cli/users.ts`, changes its methods to return `MaybePromise<void | string>`, and awaits them in user transactions.

**DoD:** `add`, `unblock`, `block`, and `delete` wait for receipts and preserve existing rollback order. `list` reports supervisor state. Wrong-container execution fails without creating an active record.

**Checks:** `node --test scripts/cli/container-workers.test.ts scripts/cli/users.test.ts scripts/lib/user-registry.test.ts scripts/lib/user-layout.test.ts`; `npm run typecheck`.

- [ ] **Step 1: Write failing lifecycle-selection and rollback tests**

```ts
void test("container add waits for start acknowledgement before health", async () => {
  const calls: string[] = [];
  const lifecycle = createFixtureLifecycle(calls);
  await commands(lifecycle).cmdUsers(["add", "123"]);
  assert.deepEqual(calls, [
    "registry:provisioning:123",
    "layout:ensure:123",
    "container:start:123",
    "health:123",
    "registry:active:123",
  ]);
});
```

Cover timeout -> blocked record, block -> stop, and delete -> stop -> pause -> quarantine -> resume.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test scripts/cli/container-workers.test.ts scripts/cli/users.test.ts`

Expected: FAIL because the container lifecycle and async interface do not exist.

- [ ] **Step 3: Implement the container lifecycle adapter**

```ts
export function createContainerWorkerLifecycle(
  runtime: Pick<CliRuntime, "dataDirAbs">,
): WorkerLifecycle {
  const controlDir = join(runtime.dataDirAbs(), "control");
  return {
    startWorker: (user) =>
      submitContainerCommand(controlDir, {
        action: "start-worker",
        userId: user.id,
      }).then(requireSuccess),
    stopWorker: (user) =>
      submitContainerCommand(controlDir, {
        action: "stop-worker",
        userId: user.id,
      }).then(requireSuccess),
    pauseGateway: () =>
      submitContainerCommand(controlDir, { action: "pause-poller" }).then(requireSuccess),
    resumeGateway: () =>
      submitContainerCommand(controlDir, { action: "resume-poller" }).then(requireSuccess),
    workerStatus: (user) => workerStatusFromRuntime(controlDir, user),
  };
}
```

- [ ] **Step 4: Await lifecycle methods and select explicitly in CLI composition**

```ts
const usersLifecycle =
  process.env.IVA_CONTAINER_RUNTIME === "1"
    ? createContainerWorkerLifecycle(runtime)
    : systemdLifecycle;
```

Change dependency wrappers to `return Promise.resolve(lifecycle?.startWorker(user)).then(() => undefined)` and the equivalent for stop/pause/resume.

- [ ] **Step 5: Run checks and commit**

Run: `node --test scripts/cli/container-workers.test.ts scripts/cli/users.test.ts scripts/lib/user-registry.test.ts scripts/lib/user-layout.test.ts && npm run typecheck && git diff --check`

Commit:

```text
feat(cli): manage users through container supervisor

Route user lifecycle transactions through the private container control protocol when explicitly enabled, while preserving systemd behavior for native installations. Await lifecycle receipts so users become active only after their worker is observable.

Verification: container lifecycle, user transaction, registry, layout tests, and typecheck pass.
```

### Task 4: Compose and deployment health contract

**Goal:** Start and promote the supervisor in immutable production releases and reject incompatible rollback with personalized users.

**Dependencies:** Tasks 1-3 runtime and status command; existing deploy transaction.

**Touched files:**

- Modify: `package.json`
- Modify: `deploy/container/compose.production.yml`
- Modify: `deploy/container/deploy.sh`
- Modify: `scripts/production/release-contract.test.ts`
- Modify: `scripts/production/deploy-script.test.ts`
- Create or modify a focused entrypoint test if required by the final command shape.

**Accepted decisions:** The poller container remains read-only and capability-free. Compatibility is an image marker plus a ready supervisor status, not a label supplied by deployment configuration.

**DoD:** Compose launches supervisor, health checks supervisor plus children, Docker socket remains absent, candidate promotion checks active workers, and rollback to an incompatible image is rejected when personalized users exist.

**Checks:** `node --test scripts/production/release-contract.test.ts scripts/production/deploy-script.test.ts scripts/container-runtime.test.ts`; `npm run typecheck`; `npm run build`.

- [ ] **Step 1: Add failing Compose and deploy contract tests**

```ts
assert.match(
  compose,
  /command:\s*\["node",\s*"--env-file=\.env",\s*"scripts\/container-runtime\.ts",\s*"run"\]/u,
);
assert.match(compose, /IVA_CONTAINER_RUNTIME:\s*"1"/u);
assert.doesNotMatch(compose, /docker\.sock/u);
```

Add harness cases for a missing supervisor marker, degraded worker status, compatible rollback, and incompatible rollback with a non-empty registry.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test scripts/production/release-contract.test.ts scripts/production/deploy-script.test.ts`

Expected: FAIL on the old direct poller command and missing runtime checks.

- [ ] **Step 3: Wire Compose and package scripts**

Set the poller command to the supervisor entrypoint and add explicit absolute app/data roots plus `IVA_CONTAINER_RUNTIME=1`. Add a healthcheck invoking `node scripts/container-runtime.ts status --require-ready`. Do not add mounts or capabilities.

- [ ] **Step 4: Harden deploy compatibility and health**

```bash
image_supports_container_workers() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'test -f /app/scripts/container-runtime.ts && test -f /app/scripts/lib/container-worker-control.ts'
}
```

In `runtime_ok`, execute the supervisor readiness command in `telegram-poll`. Before an incompatible rollback, parse the strict registry with the candidate's Node code and reject rollback if any non-blocked personalized record exists.

- [ ] **Step 5: Run build and focused release checks**

Run: `node --test scripts/production/release-contract.test.ts scripts/production/deploy-script.test.ts scripts/container-runtime.test.ts && npm run typecheck && npm run build && git diff --check`

Expected: all pass and build materializes successfully.

- [ ] **Step 6: Commit**

```text
feat(deploy): activate container tenant runtime

Launch the Telegram bridge through the container worker supervisor and require its poller and tenant readiness before promoting an immutable image. Prevent rollback to images that cannot serve existing personalized users.

Verification: release contracts, deploy transaction tests, typecheck, and production build pass.
```

### Task 5: Operator documentation and complete local verification

**Goal:** Document the real container command path and prove the complete change before review.

**Dependencies:** Tasks 1-4 complete.

**Touched files:**

- Modify: `docs/configuration.md`
- Modify: `docs/deploy.md`
- Modify: `docs/ru/configuration.md`
- Modify README only if audit finds the documented product story inaccurate.

**Accepted decisions:** Documentation shows numeric IDs and `docker compose exec`; it does not include the two private IDs, hostnames, paths, or secrets.

**DoD:** Both native systemd and container operator paths are explicit; all relevant and full checks pass; no secret or machine-specific path is added.

**Checks:** full commands below plus fixed-string secret/path scans.

- [ ] **Step 1: Update container operator instructions**

Document:

```bash
cd /path/to/iva-runtime
IVA_IMAGE="$(sed -n '1p' deploy/current-image)" \
  docker compose -f compose.yml exec telegram-poll \
  node bin/iva.mjs users add 987654321
```

Explain that container lifecycle is supervisor-backed, health-checked, and survives restart. Keep the existing native `iva users add` instructions.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test \
  scripts/lib/container-worker-control.test.ts \
  scripts/container-runtime.test.ts \
  scripts/cli/container-workers.test.ts \
  scripts/cli/users.test.ts \
  scripts/lib/user-registry.test.ts \
  scripts/lib/user-layout.test.ts \
  scripts/worker-entry.test.ts \
  scripts/multi-user-isolation.test.ts \
  scripts/production/release-contract.test.ts \
  scripts/production/deploy-script.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Run repository verification**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
git diff --check
git status --short
```

Report any documented pre-existing platform failures separately; do not flatten them into feature status.

- [ ] **Step 4: Scan protected paths and secrets**

Run fixed-string and bounded regex checks against the diff for `.env`, `data/`, `attachments/`, `/vault/`, token-looking literals, `/Users/`, and `/home/<user>/`. Confirm Git's index contains no runtime user data.

- [ ] **Step 5: Commit documentation**

```text
docs(container): document durable user provisioning

Describe the container-aware operator command and readiness behavior for isolated Telegram users while retaining the native systemd instructions. Clarify restart persistence and rollback compatibility without exposing deployment-specific identities.

Verification: documentation format and full repository checks pass.
```

### Task 6: Review, protected-main publication, deployment, and access activation

**Goal:** Merge reviewed code to `main`, verify the exact deployed artifact, and activate both confirmed users durably.

**Dependencies:** Tasks 1-5 verified and committed; user authorization to merge and add the two identities.

**Touched files:** No planned source changes; review fixes repeat their owning task's TDD/check cycle.

**Accepted decisions:** Use PR plus required `verify`; do not direct-push protected `main`; do not send Telegram messages for the users.

**DoD:** Review has no unresolved blocking findings, PR is merged, `origin/main` and deployed SHA match, both users are active and healthy, one restart proves recovery, owner/userbot remain healthy, and no unrelated checkout is changed.

**Checks:** GitHub PR/checks, deployment logs, immutable SHA, supervisor status, registry list, exact loopback health, container restart counts, filesystem modes.

- [ ] **Step 1: Run `requesting-code-review` and resolve findings**

Review the full diff against the design, auth boundaries, tool-input constraints, update compatibility, rebuild story, and protected state. Any functional fix starts with a failing regression test.

- [ ] **Step 2: Audit README before default-branch publication**

Use `beautify-github-readme` in audit mode. Change README only if the finished behavior makes current setup, architecture, commands, or proof inaccurate.

- [ ] **Step 3: Push the feature branch and open a PR**

PR title: `feat: support isolated users in container deployments`

PR body includes Summary, Changes, Motivation, Testing, and Notes; explicitly call out systemd compatibility and rollback limits.

- [ ] **Step 4: Wait for required checks and merge**

Verify the PR head SHA, required `verify` success, and merge commit on `origin/main`. Do not treat a local merge or push as completion.

- [ ] **Step 5: Verify automated production deployment**

Confirm current `origin/main`, GitHub deployment SHA, container image revision, supervisor readiness, poller/owner/userbot/scheduler health, and zero candidate restarts all match.

- [ ] **Step 6: Re-resolve and add the two users sequentially**

Use the already consented read-only `resolve_username` immediately before mutation. Require exact username and numeric ID equality with the previously confirmed identities. Then run the container-aware CLI once per ID. If a user already exists, inspect status rather than retrying `add`.

- [ ] **Step 7: Verify durable access**

For each user, verify role `user`, status `active`, default limits, distinct registry-derived ports, private `0700` layout roots, healthy exact loopback route, and supervisor child state. Restart only `telegram-poll`, wait for readiness, and repeat both worker health checks. Verify the legacy owner route, userbot session health, scheduler, and restart counts remain healthy.

- [ ] **Step 8: Final completion audit**

Re-read the completion contract and full task thread, run fresh evidence commands, verify protected state and unrelated changes, then mark the persistent goal complete only when no required item remains.
