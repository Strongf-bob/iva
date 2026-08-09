import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeReminderTool } from "../agent/tools/reminders.ts";

void test("reminders tool creates a scoped job without accepting a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-reminder-tool-"));
  const result = await executeReminderTool(
    {
      action: "create",
      idempotencyKey: "tool-1",
      message: "Tool reminder",
      timezone: "UTC",
      schedule: { kind: "once", at: "2026-08-10T11:00:00.000Z" },
    },
    {
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_USER_ID: "101",
      ASSISTANT_PERSONAL_ROOT: root,
      ASSISTANT_DATA_DIR: join(root, "runtime", "data"),
    },
    () => Date.parse("2026-08-09T10:00:00.000Z"),
  );
  assert.equal(result.ok, true);
  assert.equal("chatId" in result, false);
});
