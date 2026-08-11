import assert from "node:assert/strict";
import test from "node:test";

import { parseReminderCreateInput } from "./reminder-schema.ts";

const now = Date.parse("2026-08-09T10:00:00.000Z");

void test("reminder input accepts a future one-off without a destination", () => {
  const parsed = parseReminderCreateInput(
    {
      idempotencyKey: "chat-101:turn-8:reminder-1",
      message: "Позвонить маме",
      timezone: "Europe/Moscow",
      schedule: { kind: "once", at: "2026-08-09T11:00:00.000Z" },
    },
    now,
  );
  assert.equal(parsed.message, "Позвонить маме");
  assert.equal("chatId" in parsed, false);
});

void test("reminder input rejects unsafe or ambiguous schedules", () => {
  assert.throws(
    () =>
      parseReminderCreateInput(
        {
          idempotencyKey: "x",
          message: "past",
          timezone: "Europe/Moscow",
          schedule: { kind: "once", at: "2026-08-09T09:00:00.000Z" },
        },
        now,
      ),
    /future/u,
  );
  assert.throws(
    () =>
      parseReminderCreateInput(
        {
          idempotencyKey: "x",
          message: "bad zone",
          timezone: "Mars/Olympus",
          schedule: { kind: "cron", expression: "0 8 * * *" },
        },
        now,
      ),
    /timezone/u,
  );
  assert.throws(
    () =>
      parseReminderCreateInput(
        {
          idempotencyKey: "x",
          message: "bad cron",
          timezone: "UTC",
          schedule: { kind: "cron", expression: "@daily" },
        },
        now,
      ),
    /five fields/u,
  );
});
