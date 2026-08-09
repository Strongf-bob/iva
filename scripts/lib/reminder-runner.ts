import { nextCronOccurrence } from "./reminder-cron.ts";
import { mutateReminderStore, type ReminderJob } from "./reminder-store.ts";

const DEFAULT_LEASE_MS = 2 * 60_000;
const MAX_DELIVERIES_PER_USER = 20;
const MAX_ERROR_LENGTH = 500;

export type ReminderUser = {
  id: string;
  status: "active" | "blocked" | "provisioning";
  dataDir: string;
};

export type ReminderDeliveryResult = { ok: boolean; error: string };

export type ReminderTickReport = {
  users: number;
  delivered: number;
  failed: number;
  recovered: number;
};

type ReservedReminder = { job: ReminderJob; recovered: boolean };

function retryDelay(failureCount: number): number {
  return Math.min(
    5 * 60_000 * 2 ** Math.max(0, failureCount - 1),
    6 * 60 * 60_000,
  );
}

async function reserveDueReminder(
  dataDir: string,
  now: number,
  leaseMs: number,
): Promise<ReservedReminder | null> {
  return mutateReminderStore(dataDir, (store) => {
    const due = store.jobs
      .filter((job) => {
        if (job.state === "delivering") {
          return job.leaseUntil !== null && job.leaseUntil <= now;
        }
        if (job.state !== "active" || job.nextRunAt === null) return false;
        return (job.retryAt ?? job.nextRunAt) <= now;
      })
      .sort(
        (left, right) =>
          (left.retryAt ?? left.nextRunAt ?? Infinity) -
          (right.retryAt ?? right.nextRunAt ?? Infinity),
      )[0];
    if (!due) return null;
    const recovered = due.state === "delivering";
    due.state = "delivering";
    due.occurrenceAt ??= due.nextRunAt;
    due.leaseUntil = now + leaseMs;
    due.lastAttemptAt = now;
    due.updatedAt = new Date(now).toISOString();
    return { job: structuredClone(due), recovered };
  });
}

function nextRecurringRun(
  job: ReminderJob,
  occurrenceAt: number,
  now: number,
): number {
  if (job.schedule.kind !== "cron")
    throw new Error("reminder is not recurring");
  let next = occurrenceAt;
  for (let skipped = 0; skipped < 1000; skipped += 1) {
    next = nextCronOccurrence(job.schedule.expression, job.timezone, next);
    if (next > now) return next;
  }
  return nextCronOccurrence(job.schedule.expression, job.timezone, now);
}

async function finishDelivery(
  dataDir: string,
  reserved: ReminderJob,
  result: ReminderDeliveryResult,
  now: number,
): Promise<void> {
  await mutateReminderStore(dataDir, (store) => {
    const job = store.jobs.find((candidate) => candidate.id === reserved.id);
    if (
      !job ||
      job.state !== "delivering" ||
      job.occurrenceAt !== reserved.occurrenceAt
    ) {
      return;
    }
    job.leaseUntil = null;
    job.updatedAt = new Date(now).toISOString();
    if (!result.ok) {
      job.state = "active";
      job.failureCount += 1;
      job.retryAt = now + retryDelay(job.failureCount);
      job.lastError = result.error.slice(0, MAX_ERROR_LENGTH);
      return;
    }
    job.lastDeliveredAt = now;
    job.lastError = null;
    job.failureCount = 0;
    job.retryAt = null;
    if (job.schedule.kind === "once") {
      job.state = "completed";
      job.nextRunAt = null;
    } else {
      job.state = "active";
      job.nextRunAt = nextRecurringRun(job, job.occurrenceAt as number, now);
    }
    job.occurrenceAt = null;
  });
}

export async function runReminderTick({
  users,
  deliver,
  now = () => Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
  log = () => {},
}: {
  users: readonly ReminderUser[];
  deliver: (chatId: string, message: string) => Promise<ReminderDeliveryResult>;
  now?: () => number;
  leaseMs?: number;
  log?: (...parts: unknown[]) => void;
}): Promise<ReminderTickReport> {
  const report: ReminderTickReport = {
    users: 0,
    delivered: 0,
    failed: 0,
    recovered: 0,
  };
  for (const user of users) {
    if (user.status !== "active") continue;
    report.users += 1;
    for (let count = 0; count < MAX_DELIVERIES_PER_USER; count += 1) {
      const at = now();
      const reserved = await reserveDueReminder(user.dataDir, at, leaseMs);
      if (!reserved) break;
      if (reserved.recovered) report.recovered += 1;
      let result: ReminderDeliveryResult;
      try {
        result = await deliver(user.id, reserved.job.message);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await finishDelivery(user.dataDir, reserved.job, result, now());
      if (result.ok) report.delivered += 1;
      else report.failed += 1;
      log(
        "reminder-scheduler:",
        reserved.job.id,
        result.ok ? "delivered" : "failed",
      );
    }
  }
  return report;
}
