/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "../lib/ts-esm-hooks.ts";

const {
  BackfillStateSchema,
  backfillPaths,
  createBackfillBackup,
  ensureBackfillBackupFiles,
  loadBackfillState,
  recordBackfillPostimages,
  restoreBackfillBackup,
  saveBackfillState,
  verifyBackfillBackup,
} = await import("./backfill-state.ts");

test("backfill state is account-scoped, atomic, and private", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-backfill-state-"));
  const paths = backfillPaths(root, "data", 7);
  const state = BackfillStateSchema.parse({
    schemaVersion: 1,
    accountUserId: 7,
    runId: "run-20260811",
    phase: "running",
    backupDir: "/srv/backups/run-20260811",
    backupReady: true,
    inventoryComplete: true,
    incrementalHandoffComplete: false,
    incrementalStateBefore: { schemaVersion: 1, accountUserId: 7, jobs: {} },
    jobs: {
      "42": {
        chatId: 42,
        title: "Person",
        username: null,
        highWaterId: 500,
        committedThrough: 200,
        contextSummary: "summary",
        processedMessages: 200,
        status: "running",
        lastErrorCode: null,
      },
    },
  });

  await saveBackfillState(paths, state);

  assert.deepEqual(await loadBackfillState(paths), state);
  assert.equal((await stat(paths.accountDir)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.stateFile)).mode & 0o777, 0o600);
  assert.notEqual(paths.stateFile, backfillPaths(root, "data", 8).stateFile);
});

test("backup verifies hashes and restores existing and initially missing files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "iva-backfill-backup-"));
  const root = join(workspace, "app");
  await mkdir(root);
  const vault = join(root, "vault");
  const backupDir = join(workspace, "backup");
  const existing = join(vault, "cards", "contacts", "telegram-user-42.md");
  const initiallyMissing = join(vault, "tasks", "people.md");
  await mkdir(join(vault, "cards", "contacts"), { recursive: true });
  await writeFile(existing, "before\n", { mode: 0o640 });

  const manifest = await createBackfillBackup({
    root,
    vault,
    backupDir,
    accountUserId: 7,
    runId: "run-20260811",
    files: [existing, initiallyMissing],
  });

  await verifyBackfillBackup({ root, vault, backupDir, manifest });
  await writeFile(existing, "after\n");
  await mkdir(join(vault, "tasks"), { recursive: true });
  await writeFile(initiallyMissing, "created\n");
  const recorded = await recordBackfillPostimages({
    root,
    vault,
    backupDir,
    manifest,
    files: [existing, initiallyMissing],
  });
  await restoreBackfillBackup({
    root,
    vault,
    backupDir,
    manifest: recorded,
  });

  assert.equal(await readFile(existing, "utf8"), "before\n");
  assert.equal((await stat(existing)).mode & 0o777, 0o640);
  assert.equal(existsSync(initiallyMissing), false);
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(backupDir, "manifest.json"))).mode & 0o777,
    0o600,
  );
});

test("backup verification rejects tampering and symlinked sources", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "iva-backfill-backup-"));
  const root = join(workspace, "app");
  await mkdir(root);
  const vault = join(root, "vault");
  const outside = join(root, "outside.md");
  const linked = join(vault, "cards", "contacts", "telegram-user-42.md");
  await mkdir(join(vault, "cards", "contacts"), { recursive: true });
  await writeFile(outside, "private\n");
  await symlink(outside, linked);
  await assert.rejects(
    createBackfillBackup({
      root,
      vault,
      backupDir: join(workspace, "backup-linked"),
      accountUserId: 7,
      runId: "run-linked",
      files: [linked],
    }),
    /symlink/u,
  );

  await writeFile(linked, "original\n").catch(() => undefined);
  const ordinary = join(vault, "ordinary.md");
  await writeFile(ordinary, "original\n");
  const backupDir = join(workspace, "backup");
  const manifest = await createBackfillBackup({
    root,
    vault,
    backupDir,
    accountUserId: 7,
    runId: "run-tamper",
    files: [ordinary],
  });
  await chmod(join(backupDir, manifest.files[0].backupPath), 0o600);
  await writeFile(join(backupDir, manifest.files[0].backupPath), "tampered\n");
  await assert.rejects(
    verifyBackfillBackup({ root, vault, backupDir, manifest }),
    /hash mismatch/u,
  );
});

test("backup expands before dynamic writes and rollback refuses later owner edits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "iva-backfill-dynamic-"));
  const root = join(workspace, "app");
  const vault = join(root, "vault");
  const backupDir = join(workspace, "backups", "run-1");
  const dynamic = join(vault, "cards", "projects", "dynamic.md");
  await mkdir(root);

  let manifest = await createBackfillBackup({
    root,
    vault,
    backupDir,
    accountUserId: 7,
    runId: "run-1",
    files: [],
  });
  manifest = await ensureBackfillBackupFiles({
    root,
    vault,
    backupDir,
    manifest,
    files: [dynamic],
  });
  await mkdir(join(vault, "cards", "projects"), { recursive: true });
  await writeFile(dynamic, "generated\n");
  manifest = await recordBackfillPostimages({
    root,
    vault,
    backupDir,
    manifest,
    files: [dynamic],
  });
  await writeFile(dynamic, "owner edit\n");

  await assert.rejects(
    restoreBackfillBackup({ root, vault, backupDir, manifest }),
    /rollback conflict/u,
  );
  assert.equal(await readFile(dynamic, "utf8"), "owner edit\n");
});

test("backup rejects tracked and symlink-redirected destinations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "iva-backfill-location-"));
  const root = join(workspace, "app");
  const vault = join(root, "vault");
  const outside = join(workspace, "outside");
  await mkdir(root);
  await mkdir(outside);

  await assert.rejects(
    createBackfillBackup({
      root,
      vault,
      backupDir: join(root, "tracked-backup"),
      accountUserId: 7,
      runId: "tracked",
      files: [],
    }),
    /outside the application root/u,
  );

  const linked = join(workspace, "linked-backup");
  await symlink(outside, linked);
  await assert.rejects(
    createBackfillBackup({
      root,
      vault,
      backupDir: linked,
      accountUserId: 7,
      runId: "linked",
      files: [],
    }),
    /symlink/u,
  );
});

test("state schema rejects mismatched job cursors and manifest identity", () => {
  assert.throws(
    () =>
      BackfillStateSchema.parse({
        schemaVersion: 1,
        accountUserId: 7,
        runId: "run-1",
        phase: "running",
        backupDir: "/srv/backups/run-1",
        backupReady: false,
        inventoryComplete: true,
        incrementalHandoffComplete: false,
        incrementalStateBefore: {
          schemaVersion: 1,
          accountUserId: 7,
          jobs: {},
        },
        jobs: {
          "42": {
            chatId: 43,
            title: "Wrong",
            username: null,
            highWaterId: 10,
            committedThrough: 11,
            contextSummary: "",
            processedMessages: 0,
            status: "ready",
            lastErrorCode: null,
          },
        },
      }),
    /job/u,
  );
});
