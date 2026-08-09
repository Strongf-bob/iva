/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registration; injected command fakes intentionally resolve synchronously. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  runUnifiedInboxCommand,
  validateUnifiedInboxPolicy,
} from "./unified-inbox.ts";
import type { UnifiedInboxResult } from "./unified-inbox/pipeline.ts";
import {
  InboxReportSchema,
  PrivateInboxReportEnvelopeSchema,
} from "./unified-inbox/types.ts";

const generatedAt = "2026-08-09T08:00:00.000Z";

function result(partial = false): UnifiedInboxResult {
  const report = InboxReportSchema.parse({
    schemaVersion: 1,
    generatedAt,
    categories: { urgent: [], needsReply: [], informational: [] },
    meetings: [],
    draftProposals: [],
    informationalCount: 0,
    ignorableCount: 0,
    sourceHealth: partial
      ? [
          {
            source: "gmail",
            status: "failed",
            collected: 0,
            errorCode: "unified_inbox_source_failed",
          },
        ]
      : [],
    partial,
  });
  return {
    report,
    envelope: PrivateInboxReportEnvelopeSchema.parse({
      schemaVersion: 1,
      ownerChatId: "7",
      targetChatId: "7",
      chatKind: "private",
      generatedAt,
      text: "📥 Входящие\nНет новых сообщений.",
      report,
    }),
    sourceHealth: report.sourceHealth,
    collected: { newObservations: 0, totalObservations: 0 },
  };
}

test("policy requires read-only Telegram, owner role, and one private owner target", () => {
  const valid = validateUnifiedInboxPolicy({
    TELEGRAM_EXPOSED_TOOLS: "read-only",
    ASSISTANT_MULTI_USER: "1",
    ASSISTANT_ROLE: "owner",
    ASSISTANT_USER_ID: "7",
    TELEGRAM_DIGEST_CHAT_ID: "7",
  });
  assert.deepEqual(valid, { ownerId: "7", targetChatId: "7" });

  for (const env of [
    { ASSISTANT_USER_ID: "7", TELEGRAM_DIGEST_CHAT_ID: "7" },
    {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "member",
      ASSISTANT_USER_ID: "7",
      TELEGRAM_DIGEST_CHAT_ID: "7",
    },
    {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_USER_ID: "7",
      TELEGRAM_DIGEST_CHAT_ID: "8",
    },
  ]) {
    assert.throws(() => validateUnifiedInboxPolicy(env));
  }
});

test("command rejects policy and usage errors before running sources", async () => {
  let calls = 0;
  const output: string[] = [];
  const runImpl = async () => {
    calls += 1;
    return result();
  };

  assert.equal(
    await runUnifiedInboxCommand(["run"], {
      env: {},
      writeOutput: (line) => output.push(line),
      runImpl,
    }),
    1,
  );
  assert.equal(
    await runUnifiedInboxCommand(["send"], {
      env: {
        TELEGRAM_EXPOSED_TOOLS: "read-only",
        ASSISTANT_USER_ID: "7",
        TELEGRAM_DIGEST_CHAT_ID: "7",
      },
      writeOutput: (line) => output.push(line),
      runImpl,
    }),
    1,
  );
  assert.equal(calls, 0);
  assert.deepEqual(output, [
    "unified_inbox_telegram_requires_read_only",
    "unified_inbox_usage_error",
  ]);
});

test("command prints text or JSON but never invokes a delivery sink", async () => {
  const env = {
    TELEGRAM_EXPOSED_TOOLS: "read-only",
    ASSISTANT_USER_ID: "7",
    TELEGRAM_DIGEST_CHAT_ID: "7",
  };
  const textOutput: string[] = [];
  const textCode = await runUnifiedInboxCommand(["run"], {
    env,
    writeOutput: (line) => textOutput.push(line),
    runImpl: async (policy) => {
      assert.deepEqual(policy, { ownerId: "7", targetChatId: "7" });
      return result();
    },
  });
  assert.equal(textCode, 0);
  assert.deepEqual(textOutput, ["📥 Входящие\nНет новых сообщений."]);

  const jsonOutput: string[] = [];
  const jsonCode = await runUnifiedInboxCommand(["run", "--json"], {
    env,
    writeOutput: (line) => jsonOutput.push(line),
    runImpl: async () => result(true),
  });
  assert.equal(jsonCode, 2);
  assert.equal(
    PrivateInboxReportEnvelopeSchema.parse(
      JSON.parse(jsonOutput[0] ?? "null") as unknown,
    ).targetChatId,
    "7",
  );
});

test("command errors expose only fixed local codes", async () => {
  const output: string[] = [];
  const code = await runUnifiedInboxCommand(["run"], {
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_USER_ID: "7",
      TELEGRAM_DIGEST_CHAT_ID: "7",
    },
    writeOutput: (line) => output.push(line),
    runImpl: async () => {
      throw new Error("token=secret alice@example.com");
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(output, ["unified_inbox_failed"]);
});
