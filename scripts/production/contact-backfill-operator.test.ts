import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTACT_BACKFILL_DRY_RUN_SCHEMA,
  backfillManifestMatchesState,
  parseContactBackfillOperatorArgs,
  resolveContactBackfillOperatorContext,
  runContactBackfillOperator,
  summarizeContactBackfillState,
  type OperatorContext,
} from "./contact-backfill-operator.ts";
import type { BackfillState } from "../contact-analysis/backfill-state.ts";
import { ensureUserLayout, resolveUserLayout } from "../lib/user-layout.ts";

void test("operator accepts only the bounded backfill command surface", () => {
  assert.deepEqual(parseContactBackfillOperatorArgs(["dry-run"]), {
    action: "dry-run",
  });
  for (const action of ["apply", "status", "rollback"] as const) {
    assert.deepEqual(
      parseContactBackfillOperatorArgs([action, "run-20260811-a1"]),
      { action, runId: "run-20260811-a1" },
    );
  }
  for (const argv of [
    [],
    ["shell"],
    ["apply"],
    ["dry-run", "extra"],
    ["status", "../escape"],
    ["rollback", "UPPERCASE"],
    ["apply", "trailing-"],
  ]) {
    assert.throws(
      () => parseContactBackfillOperatorArgs(argv),
      /contact_backfill_operator_usage_error/u,
    );
  }
});

void test("operator status is aggregate-only and proves terminal invariants", () => {
  const summary = summarizeContactBackfillState(
    {
      schemaVersion: 1,
      accountUserId: 99887766,
      runId: "run-20260811-a1",
      phase: "complete",
      vaultDir: "/app/data/users/112233/vault",
      backupDir: "/app/data/private-backfill-backups/112233/run-20260811-a1",
      backupReady: true,
      inventoryComplete: true,
      incrementalHandoffComplete: true,
      incrementalStateBefore: {
        schemaVersion: 1,
        accountUserId: 99887766,
        jobs: {},
      },
      inventory: [
        { id: 7_654_321, title: "Private A", username: "private_a" },
        { id: 8_765_432, title: "Private B", username: null },
      ],
      jobs: {
        "7654321": {
          chatId: 7_654_321,
          title: "Private A",
          username: "private_a",
          highWaterId: 30,
          committedThrough: 30,
          contextSummary: "private summary",
          processedMessages: 20,
          pending: null,
          status: "complete",
          lastErrorCode: null,
        },
        "8765432": {
          chatId: 8_765_432,
          title: "Private B",
          username: null,
          highWaterId: 8,
          committedThrough: 8,
          contextSummary: "another private summary",
          processedMessages: 8,
          pending: null,
          status: "complete",
          lastErrorCode: null,
        },
      },
    },
    true,
  );

  assert.deepEqual(summary, {
    schema: "iva-contact-backfill-operator/v1",
    runId: "run-20260811-a1",
    phase: "complete",
    backupReady: true,
    backupVerified: true,
    inventoryComplete: true,
    incrementalHandoffComplete: true,
    privateChats: 2,
    completedChats: 2,
    pendingChats: 0,
    failedChats: 0,
    processedMessages: 28,
    skippedMessages: 0,
    pendingBatches: 0,
    highWaterReachedChats: 2,
    errorCodes: [],
  });
  const encoded = JSON.stringify(summary);
  for (const secret of [
    "99887766",
    "112233",
    "7654321",
    "8765432",
    "Private A",
    "private_a",
    "private summary",
    "/app/data",
  ]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

void test("backup verification is bound to the exact run and Telegram account", () => {
  const state = { runId: "run-a", accountUserId: 123 };
  assert.equal(
    backfillManifestMatchesState({ runId: "run-a", accountUserId: 123 }, state),
    true,
  );
  assert.equal(
    backfillManifestMatchesState({ runId: "run-b", accountUserId: 123 }, state),
    false,
  );
  assert.equal(
    backfillManifestMatchesState({ runId: "run-a", accountUserId: 456 }, state),
    false,
  );
});

void test("operator resolves exactly the active owner into an isolated worker environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-backfill-operator-"));
  const appRoot = join(root, "app");
  const data = join(root, "data");
  const control = join(data, "control");
  const users = join(data, "users");
  for (const directory of [
    appRoot,
    join(appRoot, ".output"),
    join(appRoot, "node_modules"),
    join(appRoot, "scripts"),
    control,
    users,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(appRoot, "package.json"), "{}\n");
  const ownerId = "123456789";
  writeFileSync(
    join(control, "users.json"),
    JSON.stringify({
      schema: "iva-users/v1",
      revision: 1,
      users: [
        {
          id: ownerId,
          role: "owner",
          status: "active",
          port: 8800,
          limits: {
            concurrentTurns: 1,
            requestsPerHour: 30,
            requestsPerDay: 100,
            llmTokensPerDay: 500000,
            audioSecondsPerDay: 1800,
            attachmentBytes: 20971520,
            storageBytes: 1073741824,
          },
          createdAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    }),
    { mode: 0o600 },
  );
  ensureUserLayout(resolveUserLayout(users, ownerId as never), appRoot);

  const context = await resolveContactBackfillOperatorContext({
    IVA_RUNTIME: "container",
    ASSISTANT_APP_DIR: appRoot,
    ASSISTANT_DATA_DIR: data,
    TELEGRAM_EXPOSED_TOOLS: "read-only",
  });

  assert.equal(context.prepared.user.role, "owner");
  assert.equal(context.prepared.env.ASSISTANT_ROLE, "owner");
  assert.equal(
    context.prepared.env.ASSISTANT_DATA_DIR,
    join(users, ownerId, "runtime", "data"),
  );
  assert.equal(
    context.prepared.env.ASSISTANT_VAULT_DIR,
    join(users, ownerId, "vault"),
  );
  assert.equal(context.prepared.env.TELEGRAM_EXPOSED_TOOLS, "read-only");
});

void test("operator maps every action to fixed CLI argv and a derived backup path", async () => {
  const calls: string[][] = [];
  const context = {
    appRoot: "/app",
    globalDataDir: "/app/data",
    prepared: { user: { id: "123456789" } },
  } as unknown as OperatorContext;
  const state = { runId: "run-a" } as BackfillState;
  const dependencies = {
    resolveContext: () => Promise.resolve(context),
    runCli: (_context: OperatorContext, argv: readonly string[]) => {
      calls.push([...argv]);
      return Promise.resolve({
        privateChats: 3,
        completedChats: 0,
        failedChats: 0,
        processedMessages: 0,
        skippedMessages: 0,
      });
    },
    loadState: () => Promise.resolve(state),
    summarizeState: () => Promise.resolve({ summarized: true } as never),
  };

  assert.deepEqual(
    await runContactBackfillOperator(["dry-run"], dependencies),
    {
      schema: CONTACT_BACKFILL_DRY_RUN_SCHEMA,
      privateChats: 3,
      completedChats: 0,
      failedChats: 0,
      processedMessages: 0,
      skippedMessages: 0,
    },
  );
  assert.deepEqual(
    await runContactBackfillOperator(["status", "run-a"], dependencies),
    { summarized: true },
  );
  assert.deepEqual(
    await runContactBackfillOperator(["apply", "run-a"], dependencies),
    { summarized: true },
  );
  assert.deepEqual(
    await runContactBackfillOperator(["rollback", "run-a"], dependencies),
    { summarized: true },
  );

  const backup = "/app/data/private-backfill-backups/123456789/run-a";
  assert.deepEqual(calls, [
    ["rebuild-private", "--dry-run", "--json"],
    ["rebuild-private", "--backup-dir", backup, "--run-id", "run-a", "--json"],
    ["rebuild-rollback", "--backup-dir", backup, "--run-id", "run-a"],
  ]);
});
