import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createContainerRuntime,
  type ManagedRuntimeChild,
  type RuntimeExit,
} from "./container-runtime.ts";
import { submitContainerCommand } from "./lib/container-worker-control.ts";
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
  { now = () => 1_000 }: { now?: () => number } = {},
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
    readRegistry: async () => currentRegistry,
    launchPoller: () => launch("poller"),
    launchWorker: async (record) => launch(`worker:${record.id}`),
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
    readRegistry: async () => {
      throw new Error("invalid user registry");
    },
    launchPoller: () => {
      throw new Error("poller must not launch");
    },
    launchWorker: async () => {
      throw new Error("worker must not launch");
    },
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
