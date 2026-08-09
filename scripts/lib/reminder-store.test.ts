import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
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

  await assert.rejects(() => loadReminderStore(dataDir), /damaged/u);
  assert.equal(existsSync(file), false);
  assert.ok(
    readdirSync(dataDir).some((name) =>
      name.startsWith("reminders.json.corrupt-"),
    ),
  );
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
