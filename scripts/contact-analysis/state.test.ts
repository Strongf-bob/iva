/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ContactAnalysisStateSchema,
  loadState,
  saveState,
  statePaths,
  withPipelineLock,
} from "./state.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-state-"));
  return { root, paths: statePaths(root, "data", 7) };
}

test("missing state creates an account-scoped empty import without message text", async () => {
  const { paths } = await fixture();
  const state = await loadState(paths);

  assert.deepEqual(state, {
    schemaVersion: 1,
    accountUserId: 7,
    jobs: {},
  });
  assert.equal(JSON.stringify(state).includes("messages"), false);
});

test("account IDs use separate private namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-state-"));
  const first = statePaths(root, "data", 7);
  const second = statePaths(root, "data", 8);

  assert.notEqual(first.accountDir, second.accountDir);
  assert.match(first.accountDir, /telegram-user-7$/u);
  assert.match(second.accountDir, /telegram-user-8$/u);
});

test("state saves atomically with private file and directory modes", async () => {
  const { paths } = await fixture();
  const state = ContactAnalysisStateSchema.parse({
    schemaVersion: 1,
    accountUserId: 7,
    jobs: {
      "-1001": {
        chatId: -1001,
        kind: "group",
        title: "Team",
        committedThrough: 12,
        contextSummary: "project context",
        skippedMessages: 4,
        status: "ready",
        attempts: 0,
        lastErrorCode: null,
      },
    },
  });

  await saveState(paths, state);

  assert.equal((await stat(paths.accountDir)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.jobsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(paths.stateFile, "utf8")), state);
  assert.deepEqual((await readdir(paths.accountDir)).sort(), [
    "jobs",
    "state.json",
  ]);
});

test("invalid JSON and schema-invalid state are quarantined and rejected", async () => {
  const first = await fixture();
  await saveState(first.paths, {
    schemaVersion: 1,
    accountUserId: 7,
    jobs: {},
  });
  await writeFile(first.paths.stateFile, "{broken", { mode: 0o600 });
  await assert.rejects(() => loadState(first.paths), /damaged/u);
  assert.equal(existsSync(first.paths.stateFile), false);

  const second = await fixture();
  await saveState(second.paths, {
    schemaVersion: 1,
    accountUserId: 7,
    jobs: {},
  });
  await writeFile(
    second.paths.stateFile,
    JSON.stringify({ schemaVersion: 1, accountUserId: 999, jobs: {} }),
  );
  await assert.rejects(() => loadState(second.paths), /schema validation/u);
  assert.equal(existsSync(second.paths.stateFile), false);
  assert.ok(
    (await readdir(second.paths.accountDir)).some((name) =>
      name.startsWith("state.json.trash-schema-"),
    ),
  );
});

test("pipeline lock is exclusive and always released", async () => {
  const { paths } = await fixture();

  const result = await withPipelineLock(paths, async () => {
    assert.equal(existsSync(paths.lockFile), true);
    await assert.rejects(
      writeFile(paths.lockFile, "second", { flag: "wx" }),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(existsSync(paths.lockFile), false);
});
