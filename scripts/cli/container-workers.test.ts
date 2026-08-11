import assert from "node:assert/strict";
import { test } from "node:test";

import { createContainerWorkerLifecycle } from "./container-workers.ts";
import {
  defaultUserLimits,
  parseTelegramUserId,
  type UserRecord,
} from "../lib/user-registry.ts";
import type {
  ContainerCommandInput,
  ContainerRuntimeStatus,
} from "../lib/container-worker-control.ts";

const user: UserRecord = {
  id: parseTelegramUserId("123")!,
  role: "user",
  status: "active",
  port: 8800,
  limits: defaultUserLimits(),
  createdAt: "2026-08-11T10:00:00.000Z",
};

const status = (
  state: "running" | "stopped" | "backoff",
): ContainerRuntimeStatus => ({
  schema: "iva-container-runtime-status/v1",
  supervisorPid: 10,
  updatedAt: "2026-08-11T10:00:00.000Z",
  poller: { state: "running", pid: 11, restarts: 0 },
  workers: {
    "123": {
      state,
      pid: state === "running" ? 12 : null,
      port: 8800,
      restarts: state === "backoff" ? 1 : 0,
    },
  },
});

void test("container lifecycle maps only the fixed worker and poller actions", async () => {
  const calls: ContainerCommandInput[] = [];
  const lifecycle = createContainerWorkerLifecycle(
    { dataDirAbs: () => "/srv/iva/data" },
    {
      submitImpl: async (_control, input) => {
        calls.push(input);
        return {
          schema: "iva-container-receipt/v1",
          operationId: "00000000-0000-4000-8000-000000000001",
          action: input.action,
          userId: "userId" in input ? parseTelegramUserId(input.userId) : null,
          ok: true,
          message: "ok",
          completedAt: "2026-08-11T10:00:00.000Z",
        };
      },
      readStatusImpl: () => status("running"),
      now: () => Date.parse("2026-08-11T10:00:05.000Z"),
    },
  );

  await lifecycle.startWorker(user);
  await lifecycle.stopWorker(user);
  await lifecycle.pauseGateway();
  await lifecycle.resumeGateway();

  assert.deepEqual(calls, [
    { action: "start-worker", userId: "123" },
    { action: "stop-worker", userId: "123" },
    { action: "pause-poller" },
    { action: "resume-poller" },
  ]);
  assert.equal(lifecycle.workerStatus(user), "running");
});

void test("container lifecycle rejects a negative receipt and mismatched status", async () => {
  const lifecycle = createContainerWorkerLifecycle(
    { dataDirAbs: () => "/srv/iva/data" },
    {
      submitImpl: async (_control, input) => ({
        schema: "iva-container-receipt/v1",
        operationId: "00000000-0000-4000-8000-000000000001",
        action: input.action,
        userId: "userId" in input ? parseTelegramUserId(input.userId) : null,
        ok: false,
        message: "not started",
        completedAt: "2026-08-11T10:00:00.000Z",
      }),
      readStatusImpl: () => ({
        ...status("running"),
        workers: { "123": { ...status("running").workers["123"], port: 9999 } },
      }),
      now: () => Date.parse("2026-08-11T10:00:05.000Z"),
    },
  );

  await assert.rejects(
    () => Promise.resolve(lifecycle.startWorker(user)),
    /not started/u,
  );
  assert.equal(lifecycle.workerStatus(user), "mismatch");
});
