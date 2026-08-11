/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations; injected async boundaries intentionally use synchronous fakes. */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  incrementalStateAfterRollback,
  rollbackPrivateBackfill,
  runContactAnalysisCommand,
} from "./contact-analysis.ts";
const {
  backfillPaths,
  createBackfillBackup,
  loadBackfillState,
  recordBackfillPostimages,
  saveBackfillState,
} = await import("./contact-analysis/backfill-state.ts");
const { loadState, saveState, statePaths } =
  await import("./contact-analysis/state.ts");

test("status reads local checkpoints without Telegram or model calls", async () => {
  const output: string[] = [];
  let syncCalls = 0;
  const code = await runContactAnalysisCommand(["status", "--json"], {
    env: {},
    root: "/tmp/iva",
    writeOutput: (line) => output.push(line),
    readStatusImpl: async () => ({
      accounts: 1,
      completedChats: 2,
      pendingChats: 1,
      failedChats: 0,
    }),
    runContactAnalysisImpl: async () => {
      syncCalls++;
      throw new Error("must not run");
    },
  });

  assert.equal(code, 0);
  assert.equal(syncCalls, 0);
  assert.deepEqual(JSON.parse(output[0]!), {
    accounts: 1,
    completedChats: 2,
    pendingChats: 1,
    failedChats: 0,
  });
});

test("sync refuses every mode except explicitly read-only", async () => {
  for (const mode of [undefined, "all", "write", "read_only"]) {
    let ran = false;
    const output: string[] = [];
    const code = await runContactAnalysisCommand(["sync"], {
      env: mode === undefined ? {} : { TELEGRAM_EXPOSED_TOOLS: mode },
      root: "/tmp/iva",
      writeOutput: (line) => output.push(line),
      runContactAnalysisImpl: async () => {
        ran = true;
        throw new Error("must not run");
      },
    });
    assert.equal(code, 1);
    assert.equal(ran, false);
    assert.match(output[0]!, /telegram_contact_analysis_requires_read_only/u);
  }
});

test("sync runs under the shared pipeline lock and prints a bounded report", async () => {
  const events: string[] = [];
  const output: string[] = [];
  const report = {
    completedChats: 3,
    pendingChats: 0,
    blockedChats: 0,
    failedChats: 0,
    processedMessages: 42,
    unsupportedMedia: 2,
    skippedMessages: 7,
    generatedQuestions: 5,
  };

  const code = await runContactAnalysisCommand(["sync", "--json"], {
    env: { TELEGRAM_EXPOSED_TOOLS: "read-only" },
    root: "/srv/iva",
    writeOutput: (line) => output.push(line),
    withLockImpl: async (root, operation) => {
      events.push(`lock:${root}/.contact-analysis.lock`);
      return operation();
    },
    runContactAnalysisImpl: async (options) => {
      events.push(`run:${options.root}`);
      return report;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(events, [
    "lock:/srv/iva/data/.contact-analysis.lock",
    "run:/srv/iva",
  ]);
  assert.deepEqual(JSON.parse(output[0]!), report);
});

test("sync stores its advisory lock in writable data outside a read-only app root", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "iva-contact-lock-"));
  const appRoot = join(temporaryRoot, "app");
  const dataRoot = join(temporaryRoot, "data");
  await mkdir(appRoot);
  await chmod(appRoot, 0o500);
  try {
    const code = await runContactAnalysisCommand(["sync"], {
      env: {
        TELEGRAM_EXPOSED_TOOLS: "read-only",
        ASSISTANT_DATA_DIR: dataRoot,
      },
      root: appRoot,
      writeOutput: () => {},
      withLockImpl: async (lockRoot, operation) => {
        await mkdir(lockRoot, { recursive: true, mode: 0o700 });
        const handle = await open(
          join(lockRoot, ".contact-analysis.lock"),
          "a",
        );
        await handle.close();
        return operation();
      },
      runContactAnalysisImpl: async () => ({
        completedChats: 0,
        pendingChats: 0,
        blockedChats: 0,
        failedChats: 0,
        processedMessages: 0,
        unsupportedMedia: 0,
        skippedMessages: 0,
        generatedQuestions: 0,
      }),
    });

    assert.equal(code, 0);
    await access(join(dataRoot, ".contact-analysis.lock"));
  } finally {
    await chmod(appRoot, 0o700);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("multi-user owner keeps personal checkpoints but reads the shared userbot token", async () => {
  let received;
  const code = await runContactAnalysisCommand(["sync"], {
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "owner",
      ASSISTANT_APP_DIR: "/srv/iva",
      ASSISTANT_DATA_DIR: "/srv/iva-users/7/data",
      ASSISTANT_VAULT_DIR: "/srv/iva-users/7/vault",
    },
    root: "/srv/iva",
    writeOutput: () => {},
    withLockImpl: async (_root, operation) => operation(),
    runContactAnalysisImpl: async (options) => {
      received = options;
      return {
        completedChats: 0,
        pendingChats: 0,
        blockedChats: 0,
        failedChats: 0,
        processedMessages: 0,
        unsupportedMedia: 0,
        skippedMessages: 0,
        generatedQuestions: 0,
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(received, {
    root: "/srv/iva",
    dataDir: "/srv/iva-users/7/data",
    vault: "/srv/iva-users/7/vault",
    tokenPath: "/srv/iva/data/telegram-userbot.token",
  });
});

test("rebuild-private requires read-only mode and an explicit backup for apply", async () => {
  const outputs: string[] = [];
  let calls = 0;
  const dependencies = {
    root: "/srv/iva",
    writeOutput: (line: string) => outputs.push(line),
    withLockImpl: async <T>(_root: string, operation: () => Promise<T>) =>
      operation(),
    runPrivateBackfillImpl: async () => {
      calls++;
      return {
        privateChats: 1,
        completedChats: 1,
        failedChats: 0,
        processedMessages: 2,
        skippedMessages: 0 as const,
      };
    },
  };

  assert.equal(
    await runContactAnalysisCommand(["rebuild-private"], {
      ...dependencies,
      env: {},
    }),
    1,
  );
  assert.equal(
    await runContactAnalysisCommand(["rebuild-private"], {
      ...dependencies,
      env: { TELEGRAM_EXPOSED_TOOLS: "read-only" },
    }),
    1,
  );
  assert.equal(
    await runContactAnalysisCommand(
      ["rebuild-private", "--backup-dir", "relative-backup"],
      {
        ...dependencies,
        env: { TELEGRAM_EXPOSED_TOOLS: "read-only" },
      },
    ),
    1,
  );
  assert.equal(calls, 0);
  assert.match(
    outputs.join("\n"),
    /requires_read_only|backup_dir_required|backup_dir_absolute/u,
  );
});

test("rebuild-private dry-run and apply share the lock and pass bounded options", async () => {
  const received: unknown[] = [];
  const events: string[] = [];
  const report = {
    privateChats: 4,
    completedChats: 4,
    failedChats: 0,
    processedMessages: 20,
    skippedMessages: 0 as const,
  };
  const dependencies = {
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_DATA_DIR: "/srv/state",
      ASSISTANT_VAULT_DIR: "/srv/vault",
    },
    root: "/srv/iva",
    writeOutput: () => {},
    withLockImpl: async <T>(root: string, operation: () => Promise<T>) => {
      events.push(root);
      return operation();
    },
    runPrivateBackfillImpl: async (options: unknown) => {
      received.push(options);
      return report;
    },
  };

  assert.equal(
    await runContactAnalysisCommand(
      ["rebuild-private", "--dry-run", "--json"],
      dependencies,
    ),
    0,
  );
  assert.equal(
    await runContactAnalysisCommand(
      [
        "rebuild-private",
        "--backup-dir",
        "/srv/backups/run-1",
        "--run-id",
        "run-1",
      ],
      dependencies,
    ),
    0,
  );
  assert.deepEqual(events, ["/srv/state", "/srv/state"]);
  assert.deepEqual(received, [
    {
      root: "/srv/iva",
      dataDir: "/srv/state",
      vault: "/srv/vault",
      backupDir: "/srv/state/private-backfill-dry-run",
      dryRun: true,
    },
    {
      root: "/srv/iva",
      dataDir: "/srv/state",
      vault: "/srv/vault",
      backupDir: "/srv/backups/run-1",
      runId: "run-1",
      dryRun: false,
    },
  ]);
});

test("rebuild-status is local-only and rollback requires an explicit verified backup", async () => {
  const events: string[] = [];
  const output: string[] = [];
  const dependencies = {
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_DATA_DIR: "/srv/state",
      ASSISTANT_VAULT_DIR: "/srv/vault",
    },
    root: "/srv/iva",
    writeOutput: (line: string) => output.push(line),
    readPrivateBackfillStatusImpl: async () => {
      events.push("status");
      return {
        accounts: 1,
        runs: 1,
        running: 0,
        complete: 1,
        failed: 0,
        rolledBack: 0,
        details: [],
      };
    },
    rollbackPrivateBackfillImpl: async (options: unknown) => {
      events.push(`rollback:${JSON.stringify(options)}`);
    },
    withLockImpl: async <T>(root: string, operation: () => Promise<T>) => {
      events.push(`lock:${root}`);
      return operation();
    },
  };

  assert.equal(
    await runContactAnalysisCommand(["rebuild-status", "--json"], dependencies),
    0,
  );
  assert.equal(
    await runContactAnalysisCommand(["rebuild-rollback"], dependencies),
    1,
  );
  assert.equal(
    await runContactAnalysisCommand(
      ["rebuild-rollback", "--backup-dir", "/srv/backups/run-1"],
      dependencies,
    ),
    1,
  );
  assert.equal(
    await runContactAnalysisCommand(
      [
        "rebuild-rollback",
        "--backup-dir",
        "/srv/backups/run-1",
        "--run-id",
        "run-1",
      ],
      dependencies,
    ),
    0,
  );
  assert.deepEqual(JSON.parse(output[0]!), {
    accounts: 1,
    runs: 1,
    running: 0,
    complete: 1,
    failed: 0,
    rolledBack: 0,
    details: [],
  });
  assert.match(output.join("\n"), /backup_dir_required/u);
  assert.match(output.join("\n"), /run_id_required/u);
  assert.equal(
    events.at(-1),
    'rollback:{"root":"/srv/iva","dataDir":"/srv/state","vault":"/srv/vault","backupDir":"/srv/backups/run-1","runId":"run-1"}',
  );
  assert.ok(events.includes("lock:/srv/state"));
});

test("private rebuild and rollback reject non-owner multi-user workers", async () => {
  let calls = 0;
  const dependencies = {
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "member",
    },
    root: "/srv/iva",
    writeOutput: () => {},
    runPrivateBackfillImpl: async () => {
      calls++;
      throw new Error("must not run");
    },
    rollbackPrivateBackfillImpl: async () => {
      calls++;
    },
  };
  assert.equal(
    await runContactAnalysisCommand(
      ["rebuild-private", "--backup-dir", "/srv/backups/run-1"],
      dependencies,
    ),
    1,
  );
  assert.equal(
    await runContactAnalysisCommand(
      [
        "rebuild-rollback",
        "--backup-dir",
        "/srv/backups/run-1",
        "--run-id",
        "run-1",
      ],
      dependencies,
    ),
    1,
  );
  assert.equal(calls, 0);
});

test("rollback validates identity before mutation and restores vault plus incremental cursor", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "iva-backfill-rollback-"));
  const root = join(workspace, "app");
  const vault = join(root, "vault");
  const backupDir = join(workspace, "backups", "run-1");
  const card = join(vault, "cards", "contacts", "telegram-user-42.md");
  await mkdir(join(vault, "cards", "contacts"), { recursive: true });
  await writeFile(card, "before\n");

  const incrementalPaths = statePaths(root, "data", 7);
  const incrementalBefore = {
    schemaVersion: 1 as const,
    accountUserId: 7,
    jobs: {},
  };
  await saveState(incrementalPaths, incrementalBefore);
  const manifest = await createBackfillBackup({
    root,
    vault,
    backupDir,
    accountUserId: 7,
    runId: "run-1",
    files: [card],
  });
  await writeFile(card, "after\n");
  await recordBackfillPostimages({
    root,
    vault,
    backupDir,
    manifest,
    files: [card],
  });
  const backfillStatePaths = backfillPaths(root, "data", 7);
  await saveBackfillState(backfillStatePaths, {
    schemaVersion: 1,
    accountUserId: 7,
    runId: "run-1",
    phase: "complete",
    vaultDir: vault,
    backupDir,
    backupReady: true,
    inventoryComplete: true,
    incrementalHandoffComplete: true,
    incrementalStateBefore: incrementalBefore,
    inventory: [{ id: 42, title: "Person", username: null }],
    jobs: {
      "42": {
        chatId: 42,
        title: "Person",
        username: null,
        highWaterId: 2,
        committedThrough: 2,
        contextSummary: "done",
        processedMessages: 2,
        status: "complete",
        lastErrorCode: null,
      },
    },
  });
  await saveState(incrementalPaths, {
    schemaVersion: 1,
    accountUserId: 7,
    jobs: {
      "42": {
        chatId: 42,
        kind: "private",
        title: "Person",
        committedThrough: 2,
        contextSummary: "done",
        skippedMessages: 0,
        status: "complete",
        attempts: 0,
        lastErrorCode: null,
      },
    },
  });

  await assert.rejects(
    rollbackPrivateBackfill({
      root,
      dataDir: "data",
      vault,
      backupDir,
      runId: "foreign-run",
    }),
    /identity_mismatch/u,
  );
  assert.equal(await readFile(card, "utf8"), "after\n");

  await assert.rejects(
    rollbackPrivateBackfill({
      root,
      dataDir: "data",
      vault: join(root, "other-vault"),
      backupDir,
      runId: "run-1",
    }),
    /vault_directory_mismatch/u,
  );
  assert.equal(await readFile(card, "utf8"), "after\n");

  await rollbackPrivateBackfill({
    root,
    dataDir: "data",
    vault,
    backupDir,
    runId: "run-1",
  });
  assert.equal(await readFile(card, "utf8"), "before\n");
  assert.deepEqual(await loadState(incrementalPaths), incrementalBefore);
  assert.equal(
    (await loadBackfillState(backfillStatePaths))?.phase,
    "rolled_back",
  );
});

test("rollback preserves incremental progress newer than the frozen high-water", () => {
  const before = {
    schemaVersion: 1 as const,
    accountUserId: 7,
    jobs: {},
  };
  const current = {
    schemaVersion: 1 as const,
    accountUserId: 7,
    jobs: {
      "42": {
        chatId: 42,
        kind: "private" as const,
        title: "Person",
        committedThrough: 5,
        contextSummary: "newer sync",
        skippedMessages: 0,
        status: "complete" as const,
        attempts: 0,
        lastErrorCode: null,
      },
    },
  };
  const backfill = {
    schemaVersion: 1 as const,
    accountUserId: 7,
    runId: "run-1",
    phase: "complete" as const,
    vaultDir: "/srv/vault",
    backupDir: "/srv/backups/run-1",
    backupReady: true,
    inventoryComplete: true,
    incrementalHandoffComplete: true,
    incrementalStateBefore: before,
    inventory: [{ id: 42, title: "Person", username: null }],
    jobs: {
      "42": {
        chatId: 42,
        title: "Person",
        username: null,
        highWaterId: 2,
        committedThrough: 2,
        contextSummary: "backfill",
        processedMessages: 2,
        status: "complete" as const,
        lastErrorCode: null,
      },
    },
  };

  assert.deepEqual(incrementalStateAfterRollback(current, backfill), current);
  const divergent = structuredClone(current);
  divergent.jobs["42"].committedThrough = 2;
  divergent.jobs["42"].contextSummary = "owner edit";
  assert.throws(
    () => incrementalStateAfterRollback(divergent, backfill),
    /incremental_state_conflict/u,
  );
});
