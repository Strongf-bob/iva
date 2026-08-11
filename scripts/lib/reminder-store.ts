import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import {
  acquireLock,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import { nextCronOccurrence } from "./reminder-cron.ts";
import {
  REMINDER_SCHEMA,
  ReminderCreateInputSchema,
  parseReminderCreateInput,
  validateReminderSchedule,
  type ReminderCreateInput,
  type ReminderJob,
  type ReminderStore,
} from "./reminder-schema.ts";

const ReminderJobSchema: z.ZodType<ReminderJob> = z.strictObject({
  id: z.uuid(),
  ...ReminderCreateInputSchema.shape,
  state: z.enum(["active", "delivering", "completed", "cancelled"]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  nextRunAt: z.number().finite().nonnegative().nullable(),
  occurrenceAt: z.number().finite().nonnegative().nullable(),
  leaseUntil: z.number().finite().nonnegative().nullable(),
  lastAttemptAt: z.number().finite().nonnegative().nullable(),
  lastDeliveredAt: z.number().finite().nonnegative().nullable(),
  failureCount: z.number().int().nonnegative(),
  retryAt: z.number().finite().nonnegative().nullable(),
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
  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const job of parsed.data.jobs) {
    validateReminderSchedule(job);
    if (ids.has(job.id) || idempotencyKeys.has(job.idempotencyKey)) {
      throw new Error("invalid reminder store: duplicate reminder identity");
    }
    ids.add(job.id);
    idempotencyKeys.add(job.idempotencyKey);

    const inactive = job.state === "completed" || job.state === "cancelled";
    const createdAt = Date.parse(job.createdAt);
    const updatedAt = Date.parse(job.updatedAt);
    const scheduleAt =
      job.schedule.kind === "once" ? Date.parse(job.schedule.at) : null;
    const historyValid =
      updatedAt >= createdAt &&
      (job.lastAttemptAt === null ||
        (job.lastAttemptAt >= createdAt && job.lastAttemptAt <= updatedAt)) &&
      (job.lastDeliveredAt === null ||
        (job.lastAttemptAt !== null &&
          job.lastDeliveredAt >= createdAt &&
          job.lastDeliveredAt <= updatedAt)) &&
      (inactive ||
        (job.nextRunAt !== null &&
          job.nextRunAt > createdAt &&
          (job.lastDeliveredAt === null ||
            job.nextRunAt > job.lastDeliveredAt))) &&
      (scheduleAt === null || scheduleAt > createdAt) &&
      (job.state !== "completed" ||
        (scheduleAt !== null &&
          job.lastAttemptAt !== null &&
          job.lastAttemptAt >= scheduleAt &&
          job.lastDeliveredAt !== null &&
          job.lastDeliveredAt >= job.lastAttemptAt &&
          job.failureCount === 0 &&
          job.lastError === null)) &&
      (job.schedule.kind !== "once" ||
        inactive ||
        job.lastDeliveredAt === null) &&
      (job.schedule.kind !== "once" ||
        job.state !== "cancelled" ||
        (job.lastDeliveredAt === null &&
          (job.lastAttemptAt === null ||
            (scheduleAt !== null && job.lastAttemptAt >= scheduleAt))));
    if (!historyValid) {
      throw new Error(
        `invalid reminder store: state invariants: history invariants failed for reminder ${job.id}`,
      );
    }
    if (job.state === "active" && job.retryAt !== null) {
      const retryValid =
        job.failureCount > 0 &&
        job.lastAttemptAt !== null &&
        job.lastAttemptAt >= (job.nextRunAt ?? Infinity) &&
        job.retryAt > job.lastAttemptAt &&
        job.occurrenceAt === job.nextRunAt &&
        job.lastError !== null;
      if (!retryValid) {
        throw new Error(
          `invalid reminder store: state invariants: retry invariants failed for reminder ${job.id}`,
        );
      }
    }
    if (
      job.state === "active" &&
      job.retryAt === null &&
      (job.failureCount !== 0 || job.lastError !== null)
    ) {
      throw new Error(
        `invalid reminder store: state invariants: retry invariants failed for reminder ${job.id}`,
      );
    }
    if (job.state === "delivering") {
      const lastAttemptAt = job.lastAttemptAt;
      const leaseValid =
        job.nextRunAt !== null &&
        lastAttemptAt !== null &&
        lastAttemptAt >= job.nextRunAt &&
        job.leaseUntil !== null &&
        job.leaseUntil > lastAttemptAt;
      if (!leaseValid) {
        throw new Error(
          `invalid reminder store: state invariants: lease invariants failed for reminder ${job.id}`,
        );
      }
      // leaseValid proves this before the retry correlation below.
      if (lastAttemptAt === null) {
        throw new Error("unreachable reminder lease validation state");
      }
      const retryValid =
        job.retryAt === null
          ? job.failureCount === 0 && job.lastError === null
          : job.failureCount > 0 &&
            job.retryAt <= lastAttemptAt &&
            job.lastError !== null;
      if (!retryValid) {
        throw new Error(
          `invalid reminder store: state invariants: retry invariants failed for reminder ${job.id}`,
        );
      }
    }
    const activeValid =
      job.state === "active" &&
      job.nextRunAt !== null &&
      (job.retryAt === null
        ? job.occurrenceAt === null
        : job.occurrenceAt === job.nextRunAt) &&
      job.leaseUntil === null;
    const deliveringValid =
      job.state === "delivering" &&
      job.nextRunAt !== null &&
      job.occurrenceAt === job.nextRunAt &&
      job.leaseUntil !== null;
    const inactiveValid =
      inactive &&
      job.nextRunAt === null &&
      job.occurrenceAt === null &&
      job.leaseUntil === null &&
      job.retryAt === null;
    if (!activeValid && !deliveringValid && !inactiveValid) {
      throw new Error(
        `invalid reminder store: state invariants failed for reminder ${job.id}`,
      );
    }
    if (
      job.schedule.kind === "once" &&
      !inactive &&
      job.nextRunAt !== Date.parse(job.schedule.at)
    ) {
      throw new Error(
        `invalid reminder store: schedule invariants failed for reminder ${job.id}`,
      );
    }
    if (
      job.schedule.kind === "cron" &&
      !inactive &&
      (job.nextRunAt === null ||
        job.nextRunAt !==
          nextCronOccurrence(
            job.schedule.expression,
            job.timezone,
            job.lastDeliveredAt ?? createdAt,
          ))
    ) {
      throw new Error(
        `invalid reminder store: schedule invariants failed for reminder ${job.id}`,
      );
    }
  }
  return parsed.data;
}

export function reminderFile(dataDir: string): string {
  return join(resolve(dataDir), "reminders.json");
}

export async function loadReminderStore(
  dataDir: string,
): Promise<ReminderStore> {
  const file = reminderFile(dataDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`reminder store has invalid JSON: ${file}`);
  }
  return parseStore(parsed);
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
      parseStore(store);
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
    job.occurrenceAt = null;
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

export type { ReminderCreateInput, ReminderJob, ReminderStore };
