/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations; injected async boundaries intentionally use synchronous fakes. */
import assert from "node:assert/strict";
import test from "node:test";

import { runContactAnalysisCommand } from "./contact-analysis.ts";

test("status reads local checkpoints without Telegram or model calls", async () => {
  const output: string[] = [];
  let syncCalls = 0;
  const code = await runContactAnalysisCommand(["status", "--json"], {
    env: {},
    root: "/tmp/iva",
    writeOutput: (line) => output.push(line),
    readStatusImpl: async () => ({
      accounts: 1,
      completedChats: 2,
      pendingChats: 1,
      failedChats: 0,
    }),
    runContactAnalysisImpl: async () => {
      syncCalls++;
      throw new Error("must not run");
    },
  });

  assert.equal(code, 0);
  assert.equal(syncCalls, 0);
  assert.deepEqual(JSON.parse(output[0]!), {
    accounts: 1,
    completedChats: 2,
    pendingChats: 1,
    failedChats: 0,
  });
});

test("sync refuses every mode except explicitly read-only", async () => {
  for (const mode of [undefined, "all", "write", "read_only"]) {
    let ran = false;
    const output: string[] = [];
    const code = await runContactAnalysisCommand(["sync"], {
      env: mode === undefined ? {} : { TELEGRAM_EXPOSED_TOOLS: mode },
      root: "/tmp/iva",
      writeOutput: (line) => output.push(line),
      runContactAnalysisImpl: async () => {
        ran = true;
        throw new Error("must not run");
      },
    });
    assert.equal(code, 1);
    assert.equal(ran, false);
    assert.match(output[0]!, /telegram_contact_analysis_requires_read_only/u);
  }
});

test("sync runs under the shared pipeline lock and prints a bounded report", async () => {
  const events: string[] = [];
  const output: string[] = [];
  const report = {
    completedChats: 3,
    pendingChats: 0,
    blockedChats: 0,
    failedChats: 0,
    processedMessages: 42,
    unsupportedMedia: 2,
    skippedMessages: 7,
    generatedQuestions: 5,
  };

  const code = await runContactAnalysisCommand(["sync", "--json"], {
    env: { TELEGRAM_EXPOSED_TOOLS: "read-only" },
    root: "/srv/iva",
    writeOutput: (line) => output.push(line),
    withLockImpl: async (root, operation) => {
      events.push(`lock:${root}/.contact-analysis.lock`);
      return operation();
    },
    runContactAnalysisImpl: async (options) => {
      events.push(`run:${options.root}`);
      return report;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(events, [
    "lock:/srv/iva/.contact-analysis.lock",
    "run:/srv/iva",
  ]);
  assert.deepEqual(JSON.parse(output[0]!), report);
});

test("multi-user owner keeps personal checkpoints but reads the shared userbot token", async () => {
  let received;
  const code = await runContactAnalysisCommand(["sync"], {
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "owner",
      ASSISTANT_APP_DIR: "/srv/iva",
      ASSISTANT_DATA_DIR: "/srv/iva-users/7/data",
      ASSISTANT_VAULT_DIR: "/srv/iva-users/7/vault",
    },
    root: "/srv/iva",
    writeOutput: () => {},
    withLockImpl: async (_root, operation) => operation(),
    runContactAnalysisImpl: async (options) => {
      received = options;
      return {
        completedChats: 0,
        pendingChats: 0,
        blockedChats: 0,
        failedChats: 0,
        processedMessages: 0,
        unsupportedMedia: 0,
        skippedMessages: 0,
        generatedQuestions: 0,
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(received, {
    root: "/srv/iva",
    dataDir: "/srv/iva-users/7/data",
    vault: "/srv/iva-users/7/vault",
    tokenPath: "/srv/iva/data/telegram-userbot.token",
  });
});
