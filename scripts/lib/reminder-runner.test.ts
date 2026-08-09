import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReminder,
  getReminder,
  mutateReminderStore,
} from "./reminder-store.ts";
import { runReminderTick } from "./reminder-runner.ts";

const createdAt = Date.parse("2026-08-09T10:00:00.000Z");
const dueAt = Date.parse("2026-08-09T11:00:00.000Z");

async function dataDir() {
  return mkdtemp(join(tmpdir(), "iva-reminder-runner-"));
}

void test("due one-off is delivered only to the fixed private user and completed", async () => {
  const data = await dataDir();
  const created = await createReminder(
    data,
    {
      idempotencyKey: "once-1",
      message: "Call Mom",
      timezone: "Europe/Moscow",
      schedule: { kind: "once", at: new Date(dueAt).toISOString() },
    },
    { now: () => createdAt },
  );
  const calls: Array<{ chatId: string; message: string }> = [];

  const report = await runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => dueAt,
    deliver: (chatId, message) => {
      calls.push({ chatId, message });
      return Promise.resolve({ ok: true, error: "" });
    },
  });

  assert.deepEqual(calls, [{ chatId: "101", message: "Call Mom" }]);
  assert.equal(report.delivered, 1);
  assert.equal((await getReminder(data, created.job.id))?.state, "completed");
});

void test("concurrent ticks reserve one occurrence only once", async () => {
  const data = await dataDir();
  await createReminder(
    data,
    {
      idempotencyKey: "dedupe-1",
      message: "Only once",
      timezone: "UTC",
      schedule: { kind: "once", at: new Date(dueAt).toISOString() },
    },
    { now: () => createdAt },
  );
  let deliveries = 0;
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliveryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const deliver = async () => {
    deliveries += 1;
    started();
    await wait;
    return { ok: true, error: "" };
  };

  const first = runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => dueAt,
    deliver,
  });
  await deliveryStarted;
  const second = await runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => dueAt,
    deliver,
  });
  release();
  await first;

  assert.equal(deliveries, 1);
  assert.equal(second.delivered, 0);
});

void test("failed delivery records bounded retry state", async () => {
  const data = await dataDir();
  const created = await createReminder(
    data,
    {
      idempotencyKey: "retry-1",
      message: "Retry me",
      timezone: "UTC",
      schedule: { kind: "once", at: new Date(dueAt).toISOString() },
    },
    { now: () => createdAt },
  );
  await runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => dueAt,
    deliver: () => Promise.resolve({ ok: false, error: "x".repeat(2000) }),
  });

  const job = await getReminder(data, created.job.id);
  assert.equal(job?.state, "active");
  assert.equal(job?.failureCount, 1);
  assert.equal(job?.retryAt, dueAt + 5 * 60_000);
  assert.ok((job?.lastError?.length ?? 0) <= 500);
});

void test("missed recurring occurrences coalesce to one future occurrence", async () => {
  const data = await dataDir();
  const created = await createReminder(
    data,
    {
      idempotencyKey: "daily-1",
      message: "Daily",
      timezone: "UTC",
      schedule: { kind: "cron", expression: "0 8 * * *" },
    },
    { now: () => Date.parse("2026-08-08T07:00:00.000Z") },
  );
  const late = Date.parse("2026-08-12T12:00:00.000Z");
  await runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => late,
    deliver: () => Promise.resolve({ ok: true, error: "" }),
  });

  const job = await getReminder(data, created.job.id);
  assert.equal(job?.lastDeliveredAt, late);
  assert.equal(job?.nextRunAt, Date.parse("2026-08-13T08:00:00.000Z"));
});

void test("inactive users are skipped and expired leases recover", async () => {
  const data = await dataDir();
  const created = await createReminder(
    data,
    {
      idempotencyKey: "lease-1",
      message: "Recover",
      timezone: "UTC",
      schedule: { kind: "once", at: new Date(dueAt).toISOString() },
    },
    { now: () => createdAt },
  );
  await mutateReminderStore(data, (store) => {
    const job = store.jobs.find(
      (candidate) => candidate.id === created.job.id,
    )!;
    job.state = "delivering";
    job.occurrenceAt = dueAt;
    job.lastAttemptAt = dueAt;
    job.leaseUntil = dueAt + 1;
    job.updatedAt = new Date(dueAt).toISOString();
  });
  const recoveryAt = dueAt + 1;
  let deliveries = 0;
  await runReminderTick({
    users: [{ id: "101", status: "blocked", dataDir: data }],
    now: () => recoveryAt,
    deliver: () => {
      deliveries += 1;
      return Promise.resolve({ ok: true, error: "" });
    },
  });
  assert.equal(deliveries, 0);
  await runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => recoveryAt,
    deliver: () => {
      deliveries += 1;
      return Promise.resolve({ ok: true, error: "" });
    },
  });
  assert.equal(deliveries, 1);
});

void test("one corrupt tenant does not block reminders for another tenant", async () => {
  const corrupt = await dataDir();
  const healthy = await dataDir();
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(join(corrupt, "reminders.json"), "{broken"),
  );
  await createReminder(
    healthy,
    {
      idempotencyKey: "healthy-1",
      message: "Still deliver",
      timezone: "UTC",
      schedule: { kind: "once", at: new Date(dueAt).toISOString() },
    },
    { now: () => createdAt },
  );
  const calls: string[] = [];

  const report = await runReminderTick({
    users: [
      { id: "101", status: "active", dataDir: corrupt },
      { id: "202", status: "active", dataDir: healthy },
    ],
    now: () => dueAt,
    deliver: (chatId) => {
      calls.push(chatId);
      return Promise.resolve({ ok: true, error: "" });
    },
  });

  assert.deepEqual(calls, ["202"]);
  assert.equal(report.userFailures, 1);
  assert.equal(report.delivered, 1);
});

void test("registry authorization is revalidated after reservation and before I/O", async () => {
  const data = await dataDir();
  const created = await createReminder(
    data,
    {
      idempotencyKey: "blocked-race-1",
      message: "Do not deliver",
      timezone: "UTC",
      schedule: { kind: "once", at: new Date(dueAt).toISOString() },
    },
    { now: () => createdAt },
  );
  let deliveries = 0;

  const report = await runReminderTick({
    users: [{ id: "101", status: "active", dataDir: data }],
    now: () => dueAt,
    authorize: () => Promise.resolve(false),
    deliver: () => {
      deliveries += 1;
      return Promise.resolve({ ok: true, error: "" });
    },
  });

  assert.equal(deliveries, 0);
  assert.equal(report.delivered, 0);
  assert.equal((await getReminder(data, created.job.id))?.state, "active");
});

void test("post-delivery recurrence failure is durable and never replays", async () => {
  const data = await dataDir();
  const created = await createReminder(
    data,
    {
      idempotencyKey: "recurrence-failure-1",
      message: "Deliver once",
      timezone: "UTC",
      schedule: { kind: "cron", expression: "0 8 * * *" },
    },
    { now: () => Date.parse("2026-08-09T07:00:00.000Z") },
  );
  let deliveries = 0;
  const options = {
    users: [{ id: "101", status: "active" as const, dataDir: data }],
    now: () => Date.parse("2026-08-09T08:00:00.000Z"),
    nextOccurrence: () => {
      throw new Error("injected recurrence failure");
    },
    deliver: () => {
      deliveries += 1;
      return Promise.resolve({ ok: true, error: "" });
    },
  };

  const first = await runReminderTick(options);
  const second = await runReminderTick(options);

  assert.equal(deliveries, 1);
  assert.equal(first.delivered, 1);
  assert.equal(first.userFailures, 1);
  assert.equal(second.delivered, 0);
  const job = await getReminder(data, created.job.id);
  assert.equal(job?.state, "cancelled");
  assert.equal(job?.nextRunAt, null);
  assert.match(job?.lastError ?? "", /recurrence disabled/u);
});
