import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "iva-scoped-reset-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";

const [{ completeScopedResetState }, status] = await Promise.all([
  import(`./telegram-poll.mjs?reset-test=${Date.now()}`),
  import(`./lib/run-status.mjs?reset-test=${Date.now()}`),
]);

test("scoped reset clears only the target chat status and queue", async () => {
  status.setChatStatus("chat-a:", {
    status: "running",
    continuationToken: "chat-a::",
    sessionId: "session-a",
    turnId: "turn-a",
  });
  status.setChatStatus("chat-b:7", {
    status: "running",
    continuationToken: "chat-b:7:reply",
    sessionId: "session-b",
    turnId: "turn-b",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "chat-a:": ["discard me"],
      "chat-b:7": ["keep me"],
    }),
  );

  await completeScopedResetState("chat-a:", "chat-a::");

  const reset = status.getChatStatus("chat-a:");
  assert.equal(reset.status, "idle");
  assert.equal(reset.continuationToken, "chat-a::");
  assert.equal(reset.sessionId, undefined);
  assert.equal(reset.turnId, undefined);

  const untouched = status.getChatStatus("chat-b:7");
  assert.equal(untouched.status, "running");
  assert.equal(untouched.sessionId, "session-b");
  assert.equal(untouched.continuationToken, "chat-b:7:reply");

  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir, "telegram-queue.json"), "utf8")),
    { "chat-b:7": ["keep me"] },
  );
});
