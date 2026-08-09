/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations; injected async boundaries intentionally use synchronous fakes. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZodError } from "zod";

import "../lib/ts-esm-hooks.ts";
import { loadState, statePaths } from "./state.ts";
import type {
  AnalysisBatch,
  TelegramDialog,
  TelegramMessage,
} from "./types.ts";

const { runContactAnalysis, runWorkerPool } = await import("./coordinator.ts");

function dialog(id: number): TelegramDialog {
  return {
    id,
    kind: "private",
    title: `Person ${id}`,
    username: `person${id}`,
  };
}

function message(chatId: number, id: number): TelegramMessage {
  return {
    id,
    senderId: chatId,
    timestamp: `2026-08-08T00:00:${String(id).padStart(2, "0")}Z`,
    text: `chat ${chatId} page ${id}`,
    replyToMessageId: null,
    mentionedUserIds: [],
    mentionedUsernames: [],
    mediaKind: id === 2 ? "voice" : null,
  };
}

function fakeClient(accountUserId = 7, inaccessible = new Set<number>()) {
  const dialogs = [1, 2, 3, 4, 5].map(dialog);
  return {
    account: async () => ({
      userId: accountUserId,
      displayName: "Owner",
      username: "owner",
    }),
    dialogs: async (offset: number, limit: number) => ({
      dialogs: dialogs.slice(offset, offset + limit),
      nextOffset: offset + limit < dialogs.length ? offset + limit : null,
    }),
    messages: async (chatId: number, afterId: number) => {
      if (inaccessible.has(chatId)) {
        throw new Error("telegram_analysis_http_404");
      }
      const nextId = afterId + 1;
      return nextId <= 3
        ? { messages: [message(chatId, nextId)], nextAfterId: nextId }
        : { messages: [], nextAfterId: afterId };
    },
  };
}

function analyzed(chatId: number, pageId: number): AnalysisBatch {
  return {
    schemaVersion: 1,
    chatId,
    rollingSummary: `page:${pageId}`,
    observations: [],
  };
}

test("fixed worker pool preserves result order with bounded concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const results = await runWorkerPool([1, 2, 3, 4, 5], 3, async (item) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return item * 2;
  });

  assert.equal(maximum, 3);
  assert.deepEqual(
    results.map((result) =>
      result.status === "fulfilled" ? result.value : "failed",
    ),
    [2, 4, 6, 8, 10],
  );
});

test("five chats run three at once while pages and reducer stay sequential", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-coordinator-"));
  let activeChats = 0;
  let maxConcurrentChats = 0;
  let reducerActive = 0;
  let reducerMaxConcurrency = 0;
  const pageOrder = new Map<number, number[]>();

  const report = await runContactAnalysis({
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    client: fakeClient(),
    analyzePageImpl: async (input) => {
      const pageId = input.messages[0]!.id;
      const pages = pageOrder.get(input.dialog.id) ?? [];
      pages.push(pageId);
      pageOrder.set(input.dialog.id, pages);
      activeChats++;
      maxConcurrentChats = Math.max(maxConcurrentChats, activeChats);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeChats--;
      return analyzed(input.dialog.id, pageId);
    },
    reduceBatchImpl: async () => {
      reducerActive++;
      reducerMaxConcurrency = Math.max(reducerMaxConcurrency, reducerActive);
      await new Promise<void>((resolve) => setImmediate(resolve));
      reducerActive--;
      return { writtenFiles: [], observationIds: [] };
    },
    sleepImpl: async () => {},
  });

  assert.equal(maxConcurrentChats, 3);
  assert.equal(reducerMaxConcurrency, 1);
  for (const id of [1, 2, 3, 4, 5]) {
    assert.deepEqual(pageOrder.get(id), [1, 2, 3]);
  }
  assert.deepEqual(report, {
    completedChats: 5,
    pendingChats: 0,
    blockedChats: 0,
    failedChats: 0,
    processedMessages: 15,
    unsupportedMedia: 5,
  });
});

test("cursor advances only after reduction and a resumed page is reduced once", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-coordinator-"));
  const analyzedPages: number[] = [];
  const reducedPages: number[] = [];
  let crash = true;
  const common = {
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    client: {
      ...fakeClient(),
      dialogs: async () => ({ dialogs: [dialog(1)], nextOffset: null }),
    },
    analyzePageImpl: async (input: {
      dialog: TelegramDialog;
      messages: TelegramMessage[];
    }) => {
      const pageId = input.messages[0]!.id;
      analyzedPages.push(pageId);
      return analyzed(input.dialog.id, pageId);
    },
    reduceBatchImpl: async (input: { batch: AnalysisBatch }) => {
      const pageId = Number(input.batch.rollingSummary.slice("page:".length));
      if (pageId === 2 && crash) {
        crash = false;
        throw new Error("simulated_before_durable_reduce");
      }
      reducedPages.push(pageId);
      return { writtenFiles: [], observationIds: [] };
    },
    sleepImpl: async () => {},
  };

  const first = await runContactAnalysis(common);
  assert.equal(first.failedChats, 1);
  assert.equal(
    (await loadState(statePaths(root, "data", 7))).jobs["1"]?.committedThrough,
    1,
  );

  const second = await runContactAnalysis(common);
  assert.equal(second.completedChats, 1);
  assert.deepEqual(analyzedPages, [1, 2, 2, 3]);
  assert.deepEqual(reducedPages, [1, 2, 3]);
  assert.equal(
    (await loadState(statePaths(root, "data", 7))).jobs["1"]?.committedThrough,
    3,
  );
});

test("validation and inaccessible-chat failures stay isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-coordinator-"));
  const calls = new Map<number, number>();

  const report = await runContactAnalysis({
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    client: fakeClient(7, new Set([3])),
    analyzePageImpl: async (input) => {
      calls.set(input.dialog.id, (calls.get(input.dialog.id) ?? 0) + 1);
      if (input.dialog.id === 2) throw new ZodError([]);
      return analyzed(input.dialog.id, input.messages[0]!.id);
    },
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    sleepImpl: async () => {},
  });

  assert.equal(report.completedChats, 3);
  assert.equal(report.failedChats, 2);
  assert.equal(calls.get(2), 1);
  assert.equal(
    calls.has(4),
    true,
    "a failed chat must release its worker slot",
  );
});

test("a non-advancing message cursor fails before analysis", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-coordinator-"));
  let analysisCalls = 0;
  let messageCalls = 0;
  const report = await runContactAnalysis({
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    client: {
      ...fakeClient(),
      dialogs: async () => ({ dialogs: [dialog(1)], nextOffset: null }),
      messages: async () => {
        messageCalls++;
        if (messageCalls > 1) {
          throw new Error("telegram_analysis_invalid_message_cursor");
        }
        return { messages: [message(1, 1)], nextAfterId: 0 };
      },
    },
    analyzePageImpl: async () => {
      analysisCalls++;
      return analyzed(1, 1);
    },
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    sleepImpl: async () => {},
  });

  assert.equal(report.failedChats, 1);
  assert.equal(analysisCalls, 0);
  assert.equal(
    (await loadState(statePaths(root, "data", 7))).jobs["1"]?.lastErrorCode,
    "telegram_analysis_invalid_message_cursor",
  );
});

test("authorization loss blocks the account and account IDs never share state", async () => {
  const blockedRoot = await mkdtemp(join(tmpdir(), "iva-contact-coordinator-"));
  await assert.rejects(
    runContactAnalysis({
      root: blockedRoot,
      client: {
        ...fakeClient(),
        account: async () => {
          throw new Error("telegram_analysis_http_409");
        },
      },
      sleepImpl: async () => {},
    }),
    /telegram_analysis_authorization_lost/u,
  );

  const root = await mkdtemp(join(tmpdir(), "iva-contact-coordinator-"));
  for (const accountUserId of [7, 8]) {
    await runContactAnalysis({
      root,
      dataDir: "data",
      vault: join(root, "vault"),
      client: {
        ...fakeClient(accountUserId),
        dialogs: async () => ({ dialogs: [], nextOffset: null }),
      },
      sleepImpl: async () => {},
    });
  }
  assert.notEqual(
    statePaths(root, "data", 7).stateFile,
    statePaths(root, "data", 8).stateFile,
  );
  assert.equal((await loadState(statePaths(root, "data", 7))).accountUserId, 7);
  assert.equal((await loadState(statePaths(root, "data", 8))).accountUserId, 8);
});
