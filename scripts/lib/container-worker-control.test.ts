import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  claimContainerCommands,
  completeContainerCommand,
  readContainerRuntimeStatus,
  recoverClaimedContainerCommands,
  resolveContainerControlPaths,
  submitContainerCommand,
  writeContainerRuntimeStatus,
  type ContainerRuntimeStatus,
} from "./container-worker-control.ts";

function fixture(t: { after: (fn: () => Promise<void>) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "iva-container-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "control");
}

async function waitForClaim(controlDir: string) {
  const deadline = Date.now() + 1_000;
  for (;;) {
    const claimed = claimContainerCommands(controlDir);
    if (claimed.length) return claimed[0];
    if (Date.now() >= deadline) throw new Error("command was not enqueued");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void test("container commands accept only canonical lifecycle inputs", async (t) => {
  const control = fixture(t);

  await assert.rejects(
    () =>
      submitContainerCommand(
        control,
        { action: "start-worker", userId: "../7" },
        { timeoutMs: 10 },
      ),
    /canonical Telegram user id/u,
  );
  await assert.rejects(
    () =>
      submitContainerCommand(
        control,
        { action: "shell", userId: "7" } as never,
        { timeoutMs: 10 },
      ),
    /invalid container command/u,
  );
  await assert.rejects(
    () =>
      submitContainerCommand(
        control,
        { action: "pause-poller", userId: "7" } as never,
        { timeoutMs: 10 },
      ),
    /invalid container command/u,
  );
});

void test("control paths reject symlinks and stay private", async (t) => {
  const control = fixture(t);
  const paths = resolveContainerControlPaths(control);
  mkdirSync(control, { recursive: true });
  symlinkSync(tmpdir(), paths.root);

  await assert.rejects(
    () =>
      submitContainerCommand(
        control,
        { action: "pause-poller" },
        { timeoutMs: 10 },
      ),
    /symbolic link/u,
  );
});

void test("the shared control directory itself cannot be a symlink", async (t) => {
  const root = fixture(t);
  const target = join(dirname(root), "target");
  const control = root;
  mkdirSync(target);
  symlinkSync(target, control);

  await assert.rejects(
    () => submitContainerCommand(control, { action: "pause-poller" }),
    /symbolic link/u,
  );
});

void test("a command is claimed atomically and completed with a private durable receipt", async (t) => {
  const control = fixture(t);
  const pending = submitContainerCommand(
    control,
    { action: "start-worker", userId: "123" },
    { timeoutMs: 1_000, intervalMs: 5 },
  );
  const command = await waitForClaim(control);

  assert.equal(command.action, "start-worker");
  assert.equal(command.userId, "123");
  await completeContainerCommand(control, command, {
    ok: true,
    message: "started",
  });

  const receipt = await pending;
  assert.equal(receipt.operationId, command.operationId);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.message, "started");
  const paths = resolveContainerControlPaths(control);
  assert.equal(
    statSync(join(paths.receipts, `${command.operationId}.json`)).mode & 0o777,
    0o600,
  );
  assert.equal(statSync(paths.root).mode & 0o777, 0o700);
});

void test("completion is idempotent but rejects a conflicting second result", async (t) => {
  const control = fixture(t);
  const pending = submitContainerCommand(
    control,
    { action: "stop-worker", userId: "123" },
    { timeoutMs: 1_000, intervalMs: 5 },
  );
  const command = await waitForClaim(control);
  await completeContainerCommand(control, command, {
    ok: true,
    message: "stopped",
  });
  await completeContainerCommand(control, command, {
    ok: true,
    message: "stopped",
  });
  await assert.rejects(
    () =>
      completeContainerCommand(control, command, {
        ok: false,
        message: "different",
      }),
    /conflicting container command receipt/u,
  );
  assert.equal((await pending).message, "stopped");
});

void test("claimed commands return to the request queue after supervisor recovery", async (t) => {
  const control = fixture(t);
  const pending = submitContainerCommand(
    control,
    { action: "resume-poller" },
    { timeoutMs: 1_000, intervalMs: 5 },
  );
  const first = await waitForClaim(control);
  assert.equal(claimContainerCommands(control).length, 0);

  recoverClaimedContainerCommands(control);
  const replayed = claimContainerCommands(control);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].operationId, first.operationId);
  await completeContainerCommand(control, replayed[0], {
    ok: true,
    message: "running",
  });
  assert.equal((await pending).ok, true);
});

void test("runtime status is strict, private, and excludes unknown fields", async (t) => {
  const control = fixture(t);
  const status: ContainerRuntimeStatus = {
    schema: "iva-container-runtime-status/v1",
    supervisorPid: 77,
    updatedAt: "2026-08-11T10:00:00.000Z",
    poller: { state: "running", pid: 78, restarts: 0 },
    workers: {
      "123": { state: "running", pid: 79, port: 8800, restarts: 0 },
    },
  };
  await writeContainerRuntimeStatus(control, status);
  assert.deepEqual(readContainerRuntimeStatus(control), status);

  const paths = resolveContainerControlPaths(control);
  assert.equal(statSync(paths.status).mode & 0o777, 0o600);
  writeFileSync(
    paths.status,
    JSON.stringify({
      ...status,
      environment: { TELEGRAM_BOT_TOKEN: "secret" },
    }),
  );
  assert.throws(
    () => readContainerRuntimeStatus(control),
    /invalid container runtime status/u,
  );
  assert.equal(
    readFileSync(paths.status, "utf8").includes("TELEGRAM_BOT_TOKEN"),
    true,
  );
});

void test("command and status records reject non-private modes", async (t) => {
  const control = fixture(t);
  const pending = submitContainerCommand(
    control,
    { action: "pause-poller" },
    { timeoutMs: 50, intervalMs: 5 },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const paths = resolveContainerControlPaths(control);
  const requestName = readdirSync(paths.requests)[0];
  chmodSync(join(paths.requests, requestName), 0o644);
  assert.throws(() => claimContainerCommands(control), /mode 0600/u);
  assert.match(String(await pending), /timed out/u);

  const status: ContainerRuntimeStatus = {
    schema: "iva-container-runtime-status/v1",
    supervisorPid: 77,
    updatedAt: "2026-08-11T10:00:00.000Z",
    poller: { state: "running", pid: 78, restarts: 0 },
    workers: {},
  };
  await writeContainerRuntimeStatus(control, status);
  chmodSync(paths.status, 0o644);
  assert.throws(() => readContainerRuntimeStatus(control), /mode 0600/u);

  const operationId = "00000000-0000-4000-8000-000000000321";
  const completed = submitContainerCommand(
    control,
    { action: "pause-poller" },
    { operationId, timeoutMs: 100, intervalMs: 5 },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const [command] = claimContainerCommands(control);
  await completeContainerCommand(control, command, {
    ok: true,
    message: "paused",
  });
  assert.equal((await completed).ok, true);
  chmodSync(join(paths.receipts, `${operationId}.json`), 0o644);
  await assert.rejects(
    () =>
      submitContainerCommand(
        control,
        { action: "pause-poller" },
        { operationId, timeoutMs: 10 },
      ),
    /mode 0600/u,
  );
});

void test("submission timeout names the durable operation without deleting it", async (t) => {
  const control = fixture(t);
  await assert.rejects(
    () =>
      submitContainerCommand(
        control,
        { action: "pause-poller" },
        { operationId: "00000000-0000-4000-8000-000000000123", timeoutMs: 10 },
      ),
    /00000000-0000-4000-8000-000000000123/u,
  );
  const paths = resolveContainerControlPaths(control);
  assert.equal(
    existsSync(
      join(paths.requests, "00000000-0000-4000-8000-000000000123.json"),
    ),
    true,
  );
});
