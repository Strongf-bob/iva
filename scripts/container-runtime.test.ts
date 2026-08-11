import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createContainerRuntime,
  requireContainerRuntimeReady,
  type ManagedRuntimeChild,
  type RuntimeExit,
} from "./container-runtime.ts";
import {
  resolveContainerControlPaths,
  submitContainerCommand,
  writeContainerRuntimeStatus,
} from "./lib/container-worker-control.ts";
import {
  defaultUserLimits,
  parseTelegramUserId,
  type UserRecord,
  type UserRegistry,
} from "./lib/user-registry.ts";

function user(
  rawId: string,
  status: UserRecord["status"] = "active",
): UserRecord {
  return {
    id: parseTelegramUserId(rawId)!,
    role: "user",
    status,
    port: 8800 + Number(rawId),
    limits: defaultUserLimits(),
    createdAt: "2026-08-11T10:00:00.000Z",
  };
}

function registry(users: UserRecord[]): UserRegistry {
  return { schema: "iva-users/v1", revision: 1, users };
}

type DeferredChild = ManagedRuntimeChild & {
  finish: (exit?: RuntimeExit) => void;
  signals: NodeJS.Signals[];
};

function child(pid: number): DeferredChild {
  let finish!: (exit: RuntimeExit) => void;
  const exited = new Promise<RuntimeExit>((resolve) => {
    finish = resolve;
  });
  const signals: NodeJS.Signals[] = [];
  return {
    pid,
    exited,
    signals,
    stop(signal) {
      signals.push(signal);
    },
    finish(exit = { code: 0, signal: null }) {
      finish(exit);
    },
  };
}

function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  users: UserRecord[],
  {
    now = () => 1_000,
    commandNow = Date.now,
  }: { now?: () => number; commandNow?: () => number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "iva-container-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlDir = join(root, "control");
  const started: string[] = [];
  const children = new Map<string, DeferredChild>();
  let nextPid = 100;
  let currentRegistry = registry(users);
  const launch = (key: string) => {
    const launched = child(nextPid++);
    started.push(key);
    children.set(key, launched);
    return launched;
  };
  const runtime = createContainerRuntime({
    controlDir,
    supervisorPid: 99,
    now,
    commandNow,
    readRegistry: () => Promise.resolve(currentRegistry),
    launchPoller: () => launch("poller"),
    launchWorker: (record) => Promise.resolve(launch(`worker:${record.id}`)),
    shutdownTimeoutMs: 1_000,
  });
  return {
    root,
    controlDir,
    runtime,
    started,
    children,
    setRegistry(users: UserRecord[]) {
      currentRegistry = registry(users);
    },
  };
}

void test("startup launches the poller and every routable worker exactly once", async (t) => {
  const f = fixture(t, [
    user("1"),
    user("2", "provisioning"),
    user("3", "blocked"),
  ]);

  await f.runtime.start();
  await f.runtime.tick();

  assert.deepEqual(f.started, ["worker:1", "worker:2", "poller"]);
  assert.deepEqual(f.runtime.status(), {
    schema: "iva-container-runtime-status/v1",
    supervisorPid: 99,
    updatedAt: "1970-01-01T00:00:01.000Z",
    poller: { state: "running", pid: 102, restarts: 0 },
    workers: {
      "1": { state: "running", pid: 100, port: 8801, restarts: 0 },
      "2": { state: "running", pid: 101, port: 8802, restarts: 0 },
    },
  });
});

void test("an invalid registry fails before the poller starts", async (t) => {
  const f = fixture(t, []);
  const runtime = createContainerRuntime({
    controlDir: f.controlDir,
    readRegistry: () => Promise.reject(new Error("invalid user registry")),
    launchPoller: () => {
      throw new Error("poller must not launch");
    },
    launchWorker: () => Promise.reject(new Error("worker must not launch")),
  });

  await assert.rejects(() => runtime.start(), /invalid user registry/u);
});

void test("stop receipt is returned only after the exact worker exits", async (t) => {
  const f = fixture(t, [user("1")]);
  await f.runtime.start();
  f.setRegistry([user("1", "blocked")]);
  const pendingReceipt = submitContainerCommand(
    f.controlDir,
    { action: "stop-worker", userId: "1" },
    { timeoutMs: 1_000, intervalMs: 5 },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  let settled = false;
  void pendingReceipt.finally(() => {
    settled = true;
  });

  const tick = f.runtime.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  assert.deepEqual(f.children.get("worker:1")?.signals, ["SIGTERM"]);

  f.children.get("worker:1")?.finish();
  await tick;
  assert.equal((await pendingReceipt).ok, true);
  assert.equal(f.runtime.status().workers["1"], undefined);
});

void test("one worker crash enters bounded backoff without affecting another", async (t) => {
  let clock = 1_000;
  const f = fixture(t, [user("1"), user("2")], { now: () => clock });
  await f.runtime.start();
  f.children.get("worker:1")?.finish({ code: 1, signal: null });
  await Promise.resolve();

  await f.runtime.tick();
  assert.equal(f.runtime.status().workers["1"].state, "backoff");
  assert.equal(f.runtime.status().workers["2"].state, "running");
  assert.equal(f.started.filter((key) => key === "worker:1").length, 1);

  clock = 2_000;
  await f.runtime.tick();
  assert.equal(f.started.filter((key) => key === "worker:1").length, 2);
  assert.equal(f.runtime.status().workers["1"].restarts, 1);
});

void test("shutdown terminates poller and workers and waits for their exits", async (t) => {
  const f = fixture(t, [user("1")]);
  await f.runtime.start();
  const stopping = f.runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(f.children.get("poller")?.signals, ["SIGTERM"]);
  assert.deepEqual(f.children.get("worker:1")?.signals, ["SIGTERM"]);
  f.children.get("poller")?.finish();
  f.children.get("worker:1")?.finish();
  await stopping;
  assert.equal(f.runtime.status().poller.state, "stopped");
});

void test("readiness probes every routable worker on its exact loopback port", async (t) => {
  const f = fixture(t, [user("1"), user("2")]);
  await f.runtime.start();
  const probed: string[] = [];

  await requireContainerRuntimeReady(f.controlDir, {
    now: () => 1_000,
    readRegistry: () => Promise.resolve(registry([user("1"), user("2")])),
    probeWorker: (record) => {
      probed.push(`http://127.0.0.1:${record.port}/eve/v1/health`);
      return Promise.resolve();
    },
  });

  assert.deepEqual(probed.sort(), [
    "http://127.0.0.1:8801/eve/v1/health",
    "http://127.0.0.1:8802/eve/v1/health",
  ]);
});

void test("readiness rejects a running worker whose loopback health fails", async (t) => {
  const f = fixture(t, [user("1")]);
  await writeContainerRuntimeStatus(f.controlDir, {
    schema: "iva-container-runtime-status/v1",
    supervisorPid: 99,
    updatedAt: "1970-01-01T00:00:01.000Z",
    poller: { state: "running", pid: 100, restarts: 0 },
    workers: {
      "1": { state: "running", pid: 101, port: 8801, restarts: 0 },
    },
  });

  await assert.rejects(
    () =>
      requireContainerRuntimeReady(f.controlDir, {
        now: () => 1_000,
        readRegistry: () => Promise.resolve(registry([user("1")])),
        probeWorker: () => Promise.reject(new Error("unhealthy")),
      }),
    /unhealthy/u,
  );
});

void test("a stale recovered command gets a failed receipt without pausing polling", async (t) => {
  const f = fixture(t, [], { commandNow: () => 20_001 });
  await f.runtime.start();
  const paths = resolveContainerControlPaths(f.controlDir);
  mkdirSync(paths.requests, { recursive: true, mode: 0o700 });
  const operationId = "00000000-0000-4000-8000-000000000099";
  writeFileSync(
    join(paths.requests, `${operationId}.json`),
    `${JSON.stringify({
      schema: "iva-container-command/v1",
      operationId,
      action: "pause-poller",
      userId: null,
      createdAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  const ticking = f.runtime.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (f.children.get("poller")?.signals.length) {
    f.children.get("poller")?.finish();
  }
  await ticking;

  assert.deepEqual(f.children.get("poller")?.signals, []);
  const receipt = JSON.parse(
    readFileSync(join(paths.receipts, `${operationId}.json`), "utf8"),
  ) as { ok: boolean; message: string };
  assert.equal(receipt.ok, false);
  assert.match(receipt.message, /stale/u);
});

void test("deployment pristine readiness rejects any child restart", async (t) => {
  const f = fixture(t, [user("1")]);
  await f.runtime.start();
  const restarted = {
    ...f.runtime.status(),
    workers: {
      "1": { ...f.runtime.status().workers["1"], restarts: 1 },
    },
  };
  const options = {
    now: () => 1_000,
    readRegistry: () => Promise.resolve(registry([user("1")])),
    readStatus: () => restarted,
    probeWorker: () => Promise.resolve(),
  };

  await requireContainerRuntimeReady(f.controlDir, options);
  await assert.rejects(
    () =>
      requireContainerRuntimeReady(f.controlDir, {
        ...options,
        requirePristine: true,
      }),
    /restarted/u,
  );
});
