import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeReminderCommand } from "../../scripts/reminder-scheduler.ts";

const CreateAction = z.strictObject({
  action: z.literal("create"),
  idempotencyKey: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  timezone: z.string().min(1).max(128),
  schedule: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("once"), at: z.string().min(1).max(64) }),
    z.strictObject({
      kind: z.literal("cron"),
      expression: z.string().min(1).max(128),
    }),
  ]),
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
  inputSchema: ReminderAction,
  execute: (input) => executeReminderTool(input),
});
