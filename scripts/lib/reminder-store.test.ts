import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelReminder,
  createReminder,
  listReminders,
  loadReminderStore,
  reminderFile,
} from "./reminder-store.ts";

const now = Date.parse("2026-08-09T10:00:00.000Z");
const input = {
  idempotencyKey: "turn-8:reminder-1",
  message: "Call Mom",
  timezone: "Europe/Moscow",
  schedule: { kind: "once" as const, at: "2026-08-09T11:00:00.000Z" },
};

async function fixture() {
  return mkdtemp(join(tmpdir(), "iva-reminders-"));
}

void test("create is durable and idempotent", async () => {
  const dataDir = await fixture();
  const first = await createReminder(dataDir, input, { now: () => now });
  const second = await createReminder(dataDir, input, { now: () => now + 1 });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.job.id, second.job.id);
  assert.equal((await listReminders(dataDir)).length, 1);
  const onDisk = JSON.parse(await readFile(reminderFile(dataDir), "utf8")) as {
    schema: string;
    revision: number;
  };
  assert.equal(onDisk.schema, "iva-reminders/v1");
  assert.equal(onDisk.revision, 1);
});

void test("cancellation is scoped to the supplied personal data directory", async () => {
  const firstDir = await fixture();
  const secondDir = await fixture();
  const created = await createReminder(firstDir, input, { now: () => now });
  await createReminder(secondDir, input, { now: () => now });

  assert.equal(
    (await cancelReminder(firstDir, created.job.id)).state,
    "cancelled",
  );
  assert.equal((await listReminders(firstDir)).length, 0);
  assert.equal((await listReminders(secondDir)).length, 1);
});

void test("corrupt reminder data is preserved and rejected", async () => {
  const dataDir = await fixture();
  const file = reminderFile(dataDir);
  await writeFile(file, "{broken", "utf8");

  await assert.rejects(() => loadReminderStore(dataDir), /invalid JSON/u);
  await assert.rejects(() => loadReminderStore(dataDir), /invalid JSON/u);
  assert.equal(existsSync(file), true);
  assert.equal(await readFile(file, "utf8"), "{broken");
});

void test("JSON-valid stores fail closed on schedule and state invariants", async () => {
  const dataDir = await fixture();
  const file = reminderFile(dataDir);
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "corrupt-semantic-1",
    message: "Never send",
    timezone: "Not/AZone",
    schedule: { kind: "cron", expression: "0 8 * * *" },
    state: "active",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    nextRunAt: now,
    occurrenceAt: null,
    leaseUntil: null,
    lastAttemptAt: null,
    lastDeliveredAt: null,
    failureCount: 0,
    retryAt: null,
    lastError: null,
  };
  await writeFile(
    file,
    JSON.stringify({ schema: "iva-reminders/v1", revision: 1, jobs: [base] }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /timezone/u);

  await writeFile(
    file,
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [
        {
          ...base,
          timezone: "UTC",
          state: "delivering",
          occurrenceAt: null,
          leaseUntil: null,
        },
      ],
    }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /state invariants/u);
});

void test("retry and lease metadata cannot make a reminder run before its schedule", async () => {
  const dataDir = await fixture();
  const file = reminderFile(dataDir);
  const nextRunAt = Date.parse("2026-08-10T10:00:00.000Z");
  const base = {
    id: "00000000-0000-4000-8000-000000000002",
    idempotencyKey: "corrupt-timing-1",
    message: "Never early",
    timezone: "UTC",
    schedule: { kind: "once", at: "2026-08-10T10:00:00.000Z" },
    state: "active",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    nextRunAt,
    occurrenceAt: null,
    leaseUntil: null,
    lastAttemptAt: null,
    lastDeliveredAt: null,
    failureCount: 0,
    retryAt: 0,
    lastError: null,
  };
  await writeFile(
    file,
    JSON.stringify({ schema: "iva-reminders/v1", revision: 1, jobs: [base] }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /retry invariants/u);

  await writeFile(
    file,
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [
        {
          ...base,
          state: "delivering",
          occurrenceAt: nextRunAt,
          retryAt: null,
          leaseUntil: nextRunAt - 1,
        },
      ],
    }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /lease invariants/u);
});

void test("persisted recurring nextRunAt must match the cron schedule", async () => {
  const dataDir = await fixture();
  const file = reminderFile(dataDir);
  await writeFile(
    file,
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          idempotencyKey: "corrupt-cron-time-1",
          message: "Never off schedule",
          timezone: "UTC",
          schedule: { kind: "cron", expression: "0 8 * * *" },
          state: "active",
          createdAt: "2026-08-09T06:00:00.000Z",
          updatedAt: "2026-08-09T06:00:00.000Z",
          nextRunAt: Date.parse("2026-08-09T07:23:00.000Z"),
          occurrenceAt: null,
          leaseUntil: null,
          lastAttemptAt: null,
          lastDeliveredAt: null,
          failureCount: 0,
          retryAt: null,
          lastError: null,
        },
      ],
    }),
  );

  await assert.rejects(
    () => loadReminderStore(dataDir),
    /schedule invariants/u,
  );
});

void test("persisted reminder history must be temporally possible", async () => {
  const dataDir = await fixture();
  const file = reminderFile(dataDir);
  const job = {
    id: "00000000-0000-4000-8000-000000000004",
    idempotencyKey: "corrupt-history-1",
    message: "Never before creation",
    timezone: "UTC",
    schedule: { kind: "cron", expression: "0 8 * * *" },
    state: "active",
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    nextRunAt: Date.parse("2026-08-09T08:00:00.000Z"),
    occurrenceAt: null,
    leaseUntil: null,
    lastAttemptAt: null,
    lastDeliveredAt: null,
    failureCount: 0,
    retryAt: null,
    lastError: null,
  };
  await writeFile(
    file,
    JSON.stringify({ schema: "iva-reminders/v1", revision: 1, jobs: [job] }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /history invariants/u);

  await writeFile(
    file,
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [
        {
          ...job,
          createdAt: "2026-08-09T07:00:00.000Z",
          lastDeliveredAt: Date.parse("2026-08-09T09:00:00.000Z"),
          lastAttemptAt: Date.parse("2026-08-09T09:00:00.000Z"),
        },
      ],
    }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /history invariants/u);
});

void test("completed one-off requires an attempt at or after its due time", async () => {
  const dataDir = await fixture();
  await writeFile(
    reminderFile(dataDir),
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [
        {
          id: "00000000-0000-4000-8000-000000000005",
          idempotencyKey: "corrupt-completed-1",
          message: "Impossible completion",
          timezone: "UTC",
          schedule: { kind: "once", at: "2026-08-09T11:00:00.000Z" },
          state: "completed",
          createdAt: "2026-08-09T10:00:00.000Z",
          updatedAt: "2026-08-09T11:00:00.000Z",
          nextRunAt: null,
          occurrenceAt: null,
          leaseUntil: null,
          lastAttemptAt: Date.parse("2026-08-09T10:30:00.000Z"),
          lastDeliveredAt: Date.parse("2026-08-09T11:00:00.000Z"),
          failureCount: 0,
          retryAt: null,
          lastError: null,
        },
      ],
    }),
  );

  await assert.rejects(() => loadReminderStore(dataDir), /history invariants/u);
});

void test("delivery and cancelled one-off history require real due attempts", async () => {
  const dataDir = await fixture();
  const file = reminderFile(dataDir);
  const recurring = {
    id: "00000000-0000-4000-8000-000000000006",
    idempotencyKey: "corrupt-delivery-history-1",
    message: "No phantom delivery",
    timezone: "UTC",
    schedule: { kind: "cron", expression: "0 8 * * *" },
    state: "active",
    createdAt: "2026-08-09T07:00:00.000Z",
    updatedAt: "2026-08-10T07:00:00.000Z",
    nextRunAt: Date.parse("2026-08-10T08:00:00.000Z"),
    occurrenceAt: null,
    leaseUntil: null,
    lastAttemptAt: null,
    lastDeliveredAt: Date.parse("2026-08-09T08:00:00.000Z"),
    failureCount: 0,
    retryAt: null,
    lastError: null,
  };
  await writeFile(
    file,
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [recurring],
    }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /history invariants/u);

  await writeFile(
    file,
    JSON.stringify({
      schema: "iva-reminders/v1",
      revision: 1,
      jobs: [
        {
          ...recurring,
          id: "00000000-0000-4000-8000-000000000007",
          idempotencyKey: "corrupt-cancelled-history-1",
          schedule: { kind: "once", at: "2026-08-10T08:00:00.000Z" },
          state: "cancelled",
          nextRunAt: null,
          lastAttemptAt: Date.parse("2026-08-10T07:30:00.000Z"),
        },
      ],
    }),
  );
  await assert.rejects(() => loadReminderStore(dataDir), /history invariants/u);
});

void test("concurrent creates serialize without losing jobs", async () => {
  const dataDir = await fixture();
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createReminder(
        dataDir,
        {
          ...input,
          idempotencyKey: `parallel-${index}`,
          message: `job ${index}`,
        },
        { now: () => now },
      ),
    ),
  );
  assert.equal((await listReminders(dataDir)).length, 8);
});
