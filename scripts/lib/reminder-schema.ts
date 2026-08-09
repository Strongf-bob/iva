import { z } from "zod";

import { nextCronOccurrence, parseCronExpression } from "./reminder-cron.ts";
import { validateTimeZone } from "./timezone.ts";

export const REMINDER_SCHEMA = "iva-reminders/v1" as const;

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/u, "idempotency key contains unsafe characters");
const MessageSchema = z.string().trim().min(1).max(4000);
const TimeZoneSchema = z.string().trim().min(1).max(128);
const OnceScheduleSchema = z.strictObject({
  kind: z.literal("once"),
  at: z.iso.datetime({ offset: true }),
});
const CronScheduleSchema = z.strictObject({
  kind: z.literal("cron"),
  expression: z.string().trim().min(1).max(128),
});

export const ReminderCreateInputSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  message: MessageSchema,
  timezone: TimeZoneSchema,
  schedule: z.discriminatedUnion("kind", [OnceScheduleSchema, CronScheduleSchema]),
});

export type ReminderCreateInput = z.infer<typeof ReminderCreateInputSchema>;
export type ReminderState = "active" | "delivering" | "completed" | "cancelled";

export type ReminderJob = ReminderCreateInput & {
  id: string;
  state: ReminderState;
  createdAt: string;
  updatedAt: string;
  nextRunAt: number | null;
  occurrenceAt: number | null;
  leaseUntil: number | null;
  lastAttemptAt: number | null;
  lastDeliveredAt: number | null;
  failureCount: number;
  retryAt: number | null;
  lastError: string | null;
};

export type ReminderStore = {
  schema: typeof REMINDER_SCHEMA;
  revision: number;
  jobs: ReminderJob[];
};

export function parseReminderCreateInput(
  value: unknown,
  now = Date.now(),
): ReminderCreateInput {
  const parsed = ReminderCreateInputSchema.parse(value);
  if (!validateTimeZone(parsed.timezone)) {
    throw new Error("reminder timezone is invalid");
  }
  if (parsed.schedule.kind === "once") {
    if (Date.parse(parsed.schedule.at) <= now) {
      throw new Error("one-off reminder must be in the future");
    }
  } else {
    parseCronExpression(parsed.schedule.expression);
    nextCronOccurrence(parsed.schedule.expression, parsed.timezone, now);
  }
  return parsed;
}
