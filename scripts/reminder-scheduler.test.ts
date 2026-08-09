import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeReminderCommand,
  schedulerStatusFile,
  writeSchedulerHeartbeat,
} from "./reminder-scheduler.ts";

void test("CLI create and list use the fixed personal user environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-reminder-cli-"));
  const dataDir = join(root, "runtime", "data");
  const env = {
    ASSISTANT_MULTI_USER: "1",
    ASSISTANT_USER_ID: "101",
    ASSISTANT_PERSONAL_ROOT: root,
    ASSISTANT_DATA_DIR: dataDir,
  };
  const created = await executeReminderCommand(["create"], env, {
    now: () => Date.parse("2026-08-09T10:00:00.000Z"),
    readInput: () =>
      Promise.resolve(
        JSON.stringify({
          idempotencyKey: "cli-1",
          message: "CLI reminder",
          timezone: "UTC",
          schedule: { kind: "once", at: "2026-08-09T11:00:00.000Z" },
        }),
      ),
  });
  const listed = await executeReminderCommand(["list"], env);

  assert.equal(created.ok, true);
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1);
  assert.equal("chatId" in created, false);
});

void test("CLI rejects missing fixed identity and cross-root data paths", async () => {
  await assert.rejects(
    () => executeReminderCommand(["list"], { ASSISTANT_MULTI_USER: "1" }),
    /fixed user identity/u,
  );
  await assert.rejects(
    () =>
      executeReminderCommand(["list"], {
        ASSISTANT_MULTI_USER: "1",
        ASSISTANT_USER_ID: "101",
        ASSISTANT_PERSONAL_ROOT: "/srv/iva/data/users/101",
        ASSISTANT_DATA_DIR: "/srv/iva/data/users/202/runtime/data",
      }),
    /escaped personal root/u,
  );
});

void test("scheduler heartbeat has a stable health contract", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "iva-reminder-health-"));
  const now = Date.parse("2026-08-09T10:00:00.000Z");
  await writeSchedulerHeartbeat(dataDir, {
    now,
    users: 1,
    delivered: 2,
    failed: 1,
    recovered: 0,
  });
  const status = await executeReminderCommand(
    ["health"],
    { ASSISTANT_DATA_DIR: dataDir },
    { now: () => now + 10_000 },
  );
  assert.equal(status.ok, true);
  assert.equal(status.status, "ready");
  assert.match(
    schedulerStatusFile(dataDir),
    /reminder-scheduler-status\.json$/u,
  );
});
