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
  loadBackfillState,
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
    backupManifest: null,
    jobs: {
      "42": {
        chatId: 42,
        title: "Person",
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
  const root = await mkdtemp(join(tmpdir(), "iva-backfill-backup-"));
  const vault = join(root, "vault");
  const backupDir = join(root, "backup");
  const existing = join(vault, "cards", "contacts", "telegram-user-42.md");
  const initiallyMissing = join(vault, "tasks", "people.md");
  await mkdir(join(vault, "cards", "contacts"), { recursive: true });
  await writeFile(existing, "before\n", { mode: 0o640 });

  const manifest = await createBackfillBackup({
    vault,
    backupDir,
    accountUserId: 7,
    runId: "run-20260811",
    files: [existing, initiallyMissing],
  });

  await verifyBackfillBackup({ vault, backupDir, manifest });
  await writeFile(existing, "after\n");
  await mkdir(join(vault, "tasks"), { recursive: true });
  await writeFile(initiallyMissing, "created\n");
  await restoreBackfillBackup({ vault, backupDir, manifest });

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
  const root = await mkdtemp(join(tmpdir(), "iva-backfill-backup-"));
  const vault = join(root, "vault");
  const outside = join(root, "outside.md");
  const linked = join(vault, "cards", "contacts", "telegram-user-42.md");
  await mkdir(join(vault, "cards", "contacts"), { recursive: true });
  await writeFile(outside, "private\n");
  await symlink(outside, linked);
  await assert.rejects(
    createBackfillBackup({
      vault,
      backupDir: join(root, "backup-linked"),
      accountUserId: 7,
      runId: "run-linked",
      files: [linked],
    }),
    /symlink/u,
  );

  await writeFile(linked, "original\n").catch(() => undefined);
  const ordinary = join(vault, "ordinary.md");
  await writeFile(ordinary, "original\n");
  const backupDir = join(root, "backup");
  const manifest = await createBackfillBackup({
    vault,
    backupDir,
    accountUserId: 7,
    runId: "run-tamper",
    files: [ordinary],
  });
  await chmod(join(backupDir, manifest.files[0].backupPath), 0o600);
  await writeFile(join(backupDir, manifest.files[0].backupPath), "tampered\n");
  await assert.rejects(
    verifyBackfillBackup({ vault, backupDir, manifest }),
    /hash mismatch/u,
  );
});
