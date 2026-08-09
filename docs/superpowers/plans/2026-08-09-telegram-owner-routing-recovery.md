# Telegram Owner Routing Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Telegram delivery for the configured owner and every explicitly registered active user, then prevent deployments whose services are healthy but routing is unusable.

**Architecture:** Add one focused owner-routing reconciler that creates an idempotent legacy owner overlay only for an unambiguous single-owner installation. Select the trusted `ASSISTANT_HOST` for that temporary legacy route while preserving registry-derived loopback routes for personalized workers. Add an in-container routing readiness probe to the deployment gate.

**Tech Stack:** TypeScript ESM on Node.js 24, `node:test`, Zod-backed user registry, Bash deployment harness, Docker Compose, GitHub Actions.

## Global Constraints

- Unknown Telegram accounts must never be auto-enrolled or authorized.
- Bootstrap is allowed only when persisted routing is empty and the allowlist contains exactly one canonical positive decimal ID.
- Ambiguous or inconsistent routing must stop the poller before `deleteWebhook` or `getUpdates` can consume updates.
- The temporary legacy owner uses trusted `ASSISTANT_HOST`; personalized workers retain registry-derived loopback ports.
- No Telegram IDs, tokens, message text, or private paths may be printed by new diagnostics.
- New Node.js source and tests must be TypeScript.
- Any authored `agent/` change requires `npm run build`; this plan does not modify `agent/`.

---

### Task 1: Fail-safe owner-route reconciliation

**Files:**

- Create: `scripts/lib/owner-routing.ts`
- Create: `scripts/lib/owner-routing.test.ts`

**Interfaces:**

- Consumes: `readUserRegistry(controlDir)`, `readRoutingUserRegistry(controlDir)`, `enableLegacyOwnerRoute(controlDir, user)`, `parseTelegramUserId(value)`, `defaultUserLimits()`.
- Produces: `reconcileTelegramOwnerRoute(input): Promise<{ outcome: "created" | "preserved"; owner: UserRecord }>` and `requireActiveTelegramOwner(controlDir): Promise<UserRecord>`.

- [ ] **Step 1: Write failing reconciliation tests**

Cover these exact cases with temporary control directories:

```ts
const created = await reconcileTelegramOwnerRoute({
  controlDir,
  allowedUserIds: new Set(["101"]),
  now: new Date("2026-08-09T18:00:00.000Z"),
});
assert.equal(created.outcome, "created");
assert.deepEqual(
  (await readRoutingUserRegistry(controlDir)).users.map(
    ({ id, role, status, port }) => ({ id, role, status, port }),
  ),
  [{ id: "101", role: "owner", status: "active", port: 8723 }],
);
assert.equal(
  (
    await reconcileTelegramOwnerRoute({
      controlDir,
      allowedUserIds: new Set(["101"]),
    })
  ).outcome,
  "preserved",
);
```

Also assert rejection for zero, multiple, and invalid allowlist entries; a non-empty registry without an owner; and an inactive owner. Assert preservation of both an existing personalized active owner and an existing active legacy owner.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/lib/owner-routing.test.ts`

Expected: FAIL because `scripts/lib/owner-routing.ts` does not exist.

- [ ] **Step 3: Implement the minimal reconciler**

Implement strict validation and construct the legacy record only after proving the effective and persisted registries are empty:

```ts
export type OwnerRoutingResult = {
  outcome: "created" | "preserved";
  owner: UserRecord;
};

export async function requireActiveTelegramOwner(
  controlDir: string,
): Promise<UserRecord> {
  const registry = await readRoutingUserRegistry(controlDir);
  const owners = registry.users.filter((user) => user.role === "owner");
  if (owners.length !== 1 || owners[0]?.status !== "active") {
    throw new Error("Telegram routing requires exactly one active owner");
  }
  return owners[0];
}
```

`reconcileTelegramOwnerRoute` must preserve a valid active owner, reject a non-empty ownerless registry, parse every allowlist entry canonically, require exactly one unique ID, create the active port-8723 record with default limits and the supplied clock, call `enableLegacyOwnerRoute`, and re-read through `requireActiveTelegramOwner` before returning.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test scripts/lib/owner-routing.test.ts scripts/lib/user-registry.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/lib/owner-routing.ts scripts/lib/owner-routing.test.ts
git commit -m "fix(telegram): reconcile the configured legacy owner" -m "Create a private legacy routing overlay only for an unambiguous empty single-owner installation. Reject ambiguous state before polling so Telegram updates cannot be silently consumed."
```

### Task 2: Container-aware route selection and startup gate

**Files:**

- Modify: `scripts/poller/tenant-routing.ts`
- Modify: `scripts/poller/tenant-routing.test.ts`
- Modify: `scripts/poller/main.ts`
- Create: `scripts/poller/startup-routing.test.ts`

**Interfaces:**

- Consumes: `reconcileTelegramOwnerRoute`, `isLegacyOwnerRoute`, `HOST`, `ROUTE`, `ACCEPTANCE_ROUTE`, and `RESET_ROUTE`.
- Produces: `routesForTenant(user, legacyBase): WorkerRoutes`; `main()` reconciles routing before its first Telegram API mutation.

- [ ] **Step 1: Write failing route-selection tests**

Add assertions that a legacy owner uses the configured container hostname while a personalized user remains loopback-routed:

```ts
assert.deepEqual(routesForTenant(legacyOwner, "http://iva:8723"), {
  webhook: "http://iva:8723/eve/v1/telegram",
  acceptance: "http://iva:8723/eve/v1/telegram/accepted",
  reset: "http://iva:8723/eve/v1/telegram/reset",
});
assert.deepEqual(routesForTenant(user("123"), "http://iva:8723"), {
  webhook: "http://127.0.0.1:8923/eve/v1/telegram",
  acceptance: "http://127.0.0.1:8923/eve/v1/telegram/accepted",
  reset: "http://127.0.0.1:8923/eve/v1/telegram/reset",
});
```

Add a static startup-order test that reads `scripts/poller/main.ts` and proves the reconciliation call appears before `deleteWebhook` and the infinite polling loop.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/poller/tenant-routing.test.ts scripts/poller/startup-routing.test.ts`

Expected: FAIL because `routesForTenant` and the startup reconciliation call are absent.

- [ ] **Step 3: Implement route selection and startup reconciliation**

Implement a normalized trusted-base helper:

```ts
export function routesForTenant(
  user: UserRecord,
  legacyBase: string,
): WorkerRoutes {
  if (!isLegacyOwnerRoute(user)) return workerRoutes(user);
  const base = legacyBase.replace(/\/$/u, "");
  const webhook = `${base}/eve/v1/telegram`;
  return {
    webhook,
    acceptance: `${webhook}/accepted`,
    reset: `${webhook}/reset`,
  };
}
```

In `tenantRoutes`, compute `legacyRoute` once and call `routesForTenant(user, HOST)`. At the start of `main()`, after token/secret validation but before stale-job cleanup and `deleteWebhook`, call the reconciler with `CONTROL_DIR` and `ALLOWED`. Log only `owner routing: created legacy route` or `owner routing: ready`; do not log IDs.

- [ ] **Step 4: Run focused routing tests and verify GREEN**

Run: `node --test scripts/lib/owner-routing.test.ts scripts/poller/tenant-routing.test.ts scripts/poller/startup-routing.test.ts scripts/telegram-poll.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/poller/main.ts scripts/poller/tenant-routing.ts scripts/poller/tenant-routing.test.ts scripts/poller/startup-routing.test.ts
git commit -m "fix(telegram): route the legacy owner across containers" -m "Reconcile owner routing before Telegram polling begins and use the trusted assistant host for the temporary legacy worker. Keep personalized users on their isolated registry-derived loopback routes."
```

### Task 3: Deployment routing readiness gate

**Files:**

- Create: `scripts/production/routing-health.ts`
- Create: `scripts/production/routing-health.test.ts`
- Modify: `deploy/container/deploy.sh`
- Modify: `scripts/production/deploy-script.test.ts`
- Modify: `scripts/production/release-contract.test.ts`

**Interfaces:**

- Consumes: `requireActiveTelegramOwner`, `routesForTenant`, `CONTROL_DIR`, and `HOST`.
- Produces: a silent exit-0 `routing-health.ts` command only when exactly one active owner exists and its worker health endpoint responds; deployment invokes it inside the poller container.

- [ ] **Step 1: Write failing readiness tests**

Test the probe through an exported `checkRoutingHealth` with an injected fetch implementation:

```ts
const result = await checkRoutingHealth({
  controlDir,
  legacyBase: "http://iva:8723",
  fetchImpl: async (url) => {
    assert.equal(url, "http://iva:8723/eve/v1/health");
    return new Response("{}", { status: 200 });
  },
});
assert.equal(result, undefined);
```

Assert failure for missing/inactive owner, non-2xx health, and timeout/network rejection. Extend the deploy harness mock so `docker exec poller-container node scripts/production/routing-health.ts` succeeds only when `MOCK_ROUTING_HEALTH=1`; assert a candidate fails when it is `0`. Add a release-contract assertion for the exact in-container command.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/production/routing-health.test.ts scripts/production/deploy-script.test.ts scripts/production/release-contract.test.ts`

Expected: FAIL because the probe and deployment invocation are absent.

- [ ] **Step 3: Implement the readiness probe and deployment call**

`checkRoutingHealth` must load the effective active owner, derive its routes, replace the webhook suffix with `/eve/v1/health`, fetch it with a five-second abort timeout, and throw a secret-free error on failure. The direct-entry wrapper exits non-zero with only `routing health failed` plus the safe error message.

In `runtime_ok`, after confirming the poller is running with zero restarts, execute:

```bash
docker exec "$poller_id" node scripts/production/routing-health.ts || return 1
```

- [ ] **Step 4: Run focused production tests and verify GREEN**

Run: `node --test scripts/production/routing-health.test.ts scripts/production/deploy-script.test.ts scripts/production/release-contract.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add scripts/production/routing-health.ts scripts/production/routing-health.test.ts deploy/container/deploy.sh scripts/production/deploy-script.test.ts scripts/production/release-contract.test.ts
git commit -m "fix(deploy): require usable Telegram owner routing" -m "Run a bounded routing probe inside the poller container so a healthy Eve process cannot activate while the configured owner has no reachable route. Extend the deployment harness to cover the fail-closed gate."
```

### Task 4: Verification, documentation audit, review, and release

**Files:**

- Modify only if evidence requires it: `README.md`, `README.ru.md`, `docs/deploy.md`, `docs/configuration.md`

**Interfaces:**

- Consumes: Tasks 1-3 and the repository publication workflow.
- Produces: fresh local verification, reviewed documentation, protected-main PR, deployed immutable SHA, and production round-trip evidence.

- [ ] **Step 1: Run complete local verification**

Run in order:

```bash
npm test
npm run test:coverage
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:security
npm run test:release
npm run test:deploy
git diff --check
```

Run relevant Python userbot tests from `services/telegram-userbot`:

```bash
uv run --with-requirements requirements.in python -m unittest test_health.py test_container_supervisor.py
```

Expected: every command exits zero. Record any platform skip separately rather than calling it a pass.

- [ ] **Step 2: Audit README and operational documentation**

Use `beautify-github-readme` in audit mode because the fix will change protected `main`. Update documentation only if the final behavior or operations differ from the current documented migration and deployment contracts. Validate any changed Markdown with repository checks.

- [ ] **Step 3: Request independent code review**

Review the diff from `962e8dd5c3dea9ba16dea75860b72772f2c076b5` to branch HEAD against the approved specification. Fix every Critical or Important issue and rerun affected checks.

- [ ] **Step 4: Recover current production before publication if still silent**

Using the current immutable image, invoke the new idempotent reconciliation inside the poller container, validate the generated mode-0600 route without printing its contents, restart only `telegram-poll`, and verify zero restarts after settling. Confirm a fresh owner `/menu` and `/tasks` round trip; if human-originated input is required, report that exact checkpoint rather than synthesizing an owner message.

- [ ] **Step 5: Publish through protected main**

Push `strongf/fix-telegram-owner-routing`, open a ready PR with Summary, Changes, Motivation, Testing, and Notes, wait for required `verify`, merge without bypassing protection, and wait for protected-main CI plus Deploy.

- [ ] **Step 6: Perform production postflight**

Confirm local `HEAD`, `origin/main`, active image label/SHA, routing readiness, Eve health, Telegram identity, userbot health, poller/userbot restart counts, and fresh `/menu` plus `/tasks` responses agree. Do not claim release success from GitHub status alone.
