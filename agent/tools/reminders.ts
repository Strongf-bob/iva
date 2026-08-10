import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeReminderCommand } from "../../scripts/reminder-scheduler.ts";

const ReminderSchedule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: z.string().min(1).max(64) }),
  z.strictObject({
    kind: z.literal("cron"),
    expression: z.string().min(1).max(128),
  }),
]);
const CreateAction = z.strictObject({
  action: z.literal("create"),
  idempotencyKey: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  timezone: z.string().min(1).max(128),
  schedule: ReminderSchedule,
});
const ReminderAction = z.discriminatedUnion("action", [
  CreateAction,
  z.strictObject({
    action: z.literal("list"),
    includeInactive: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("get"), id: z.uuid() }),
  z.strictObject({ action: z.literal("cancel"), id: z.uuid() }),
  z.strictObject({ action: z.literal("status") }),
]);

export const reminderToolInputSchema = z.strictObject({
  action: z.enum(["create", "list", "get", "cancel", "status"]),
  idempotencyKey: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(4000).optional(),
  timezone: z.string().min(1).max(128).optional(),
  schedule: z
    .strictObject({
      kind: z.enum(["once", "cron"]),
      at: z.string().min(1).max(64).optional(),
      expression: z.string().min(1).max(128).optional(),
    })
    .optional(),
  includeInactive: z.boolean().optional(),
  id: z.uuid().optional(),
});

export async function executeReminderTool(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => Date.now(),
): Promise<Record<string, unknown> & { ok: boolean }> {
  const input = ReminderAction.parse(value);
  if (input.action === "create") {
    const create = {
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      timezone: input.timezone,
      schedule: input.schedule,
    };
    return executeReminderCommand(["create"], env, {
      now,
      readInput: () => Promise.resolve(JSON.stringify(create)),
    });
  }
  if (input.action === "list") {
    return executeReminderCommand(
      input.includeInactive ? ["list", "--all"] : ["list"],
      env,
      { now },
    );
  }
  return executeReminderCommand(
    input.action === "status" ? ["status"] : [input.action, input.id],
    env,
    { now },
  );
}

export default defineTool({
  description:
    "Создать, показать, проверить или отменить личное напоминание. Доставка всегда идёт в приватный чат текущего пользователя; произвольный chat_id не поддерживается.",
  inputSchema: reminderToolInputSchema,
  execute: (input) => executeReminderTool(input),
});
