import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import { nextCronOccurrence } from "./reminder-cron.ts";
import {
  REMINDER_SCHEMA,
  parseReminderCreateInput,
  type ReminderCreateInput,
  type ReminderJob,
  type ReminderStore,
} from "./reminder-schema.ts";

const ReminderJobSchema: z.ZodType<ReminderJob> = z.strictObject({
  id: z.uuid(),
  idempotencyKey: z.string(),
  message: z.string(),
  timezone: z.string(),
  schedule: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("once"), at: z.string() }),
    z.strictObject({ kind: z.literal("cron"), expression: z.string() }),
  ]),
  state: z.enum(["active", "delivering", "completed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.number().finite().nullable(),
  occurrenceAt: z.number().finite().nullable(),
  leaseUntil: z.number().finite().nullable(),
  lastAttemptAt: z.number().finite().nullable(),
  lastDeliveredAt: z.number().finite().nullable(),
  failureCount: z.number().int().nonnegative(),
  retryAt: z.number().finite().nullable(),
  lastError: z.string().max(1000).nullable(),
});

const StoreSchema: z.ZodType<ReminderStore> = z.strictObject({
  schema: z.literal(REMINDER_SCHEMA),
  revision: z.number().int().nonnegative(),
  jobs: z.array(ReminderJobSchema),
});

const emptyStore = (): ReminderStore => ({
  schema: REMINDER_SCHEMA,
  revision: 0,
  jobs: [],
});

function parseStore(value: unknown): ReminderStore {
  const parsed = StoreSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid reminder store: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function reminderFile(dataDir: string): string {
  return join(resolve(dataDir), "reminders.json");
}

export async function loadReminderStore(
  dataDir: string,
): Promise<ReminderStore> {
  return parseStore(
    await loadJsonStrict<unknown>(reminderFile(dataDir), emptyStore()),
  );
}

export async function mutateReminderStore<T>(
  dataDir: string,
  mutate: (store: ReminderStore) => T,
): Promise<T> {
  const file = reminderFile(dataDir);
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    const store = await loadReminderStore(dataDir);
    const before = JSON.stringify(store);
    const result = mutate(store);
    if (JSON.stringify(store) !== before) {
      store.revision += 1;
      await saveJsonAtomic(file, store);
    }
    return result;
  } finally {
    releaseLock(lock, token);
  }
}

export async function createReminder(
  dataDir: string,
  value: unknown,
  { now = () => Date.now() }: { now?: () => number } = {},
): Promise<{ created: boolean; job: ReminderJob }> {
  const timestamp = now();
  const input = parseReminderCreateInput(value, timestamp);
  return mutateReminderStore(dataDir, (store) => {
    const existing = store.jobs.find(
      (job) => job.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { created: false, job: existing };
    const nextRunAt =
      input.schedule.kind === "once"
        ? Date.parse(input.schedule.at)
        : nextCronOccurrence(
            input.schedule.expression,
            input.timezone,
            timestamp,
          );
    const iso = new Date(timestamp).toISOString();
    const job: ReminderJob = {
      ...input,
      id: randomUUID(),
      state: "active",
      createdAt: iso,
      updatedAt: iso,
      nextRunAt,
      occurrenceAt: null,
      leaseUntil: null,
      lastAttemptAt: null,
      lastDeliveredAt: null,
      failureCount: 0,
      retryAt: null,
      lastError: null,
    };
    store.jobs.push(job);
    return { created: true, job };
  });
}

export async function listReminders(
  dataDir: string,
  { includeInactive = false }: { includeInactive?: boolean } = {},
): Promise<ReminderJob[]> {
  const jobs = (await loadReminderStore(dataDir)).jobs;
  return jobs.filter((job) => includeInactive || job.state === "active");
}

export async function getReminder(
  dataDir: string,
  id: string,
): Promise<ReminderJob | null> {
  return (
    (await loadReminderStore(dataDir)).jobs.find((job) => job.id === id) ?? null
  );
}

export async function cancelReminder(
  dataDir: string,
  id: string,
): Promise<ReminderJob> {
  return mutateReminderStore(dataDir, (store) => {
    const job = store.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`reminder ${id} not found`);
    if (job.state === "completed")
      throw new Error("completed reminder cannot be cancelled");
    job.state = "cancelled";
    job.nextRunAt = null;
    job.retryAt = null;
    job.leaseUntil = null;
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

export type { ReminderCreateInput, ReminderJob, ReminderStore };
