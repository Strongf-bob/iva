/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; injected async boundaries intentionally use synchronous fakes. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "../lib/ts-esm-hooks.ts";
import type { TelegramDialog, TelegramMessage } from "./types.ts";

const { runPrivateContactBackfill } = await import("./backfill.ts");

const message = (id: number): TelegramMessage => ({
  id,
  senderId: 42,
  timestamp: `2026-08-10T00:${String(id).padStart(2, "0")}:00Z`,
  text: `message ${id}`,
  replyToMessageId: null,
  mentionedUserIds: [],
  mentionedUsernames: [],
  mediaKind: null,
});

test("private backfill traverses oldest first to a fixed high-water without other chat kinds", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialogs: TelegramDialog[] = [
    { id: 42, kind: "private", title: "Person", username: null },
    { id: 77, kind: "bot", title: "Bot", username: "bot" },
    { id: -100, kind: "group", title: "Group", username: null },
  ];
  const analyzed: number[][] = [];
  const reduced: number[][] = [];
  let pageCalls = 0;
  const report = await runPrivateContactBackfill({
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    backupDir: join(root, "backup"),
    runId: "run-1",
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs, nextOffset: null }),
      messageWindow: async (chatId) => ({
        messages: [],
        latestMessageId: chatId === 42 ? 5 : 99,
        skippedMessages: 0,
      }),
      messages: async (chatId, afterId) => {
        assert.equal(chatId, 42);
        pageCalls++;
        const ids = afterId === 0 ? [1, 2] : afterId === 2 ? [3, 4] : [5, 6];
        return { messages: ids.map(message), nextAfterId: ids.at(-1)! };
      },
    },
    analyzePageImpl: async (input) => {
      analyzed.push(input.messages.map((item) => item.id));
      return {
        schemaVersion: 1,
        chatId: input.dialog.id,
        rollingSummary: `through ${input.messages.at(-1)!.id}`,
        observations: [],
        questions: [],
      };
    },
    reduceBatchImpl: async (input) => {
      reduced.push(
        input.batch.observations.flatMap((item) =>
          item.evidence.map((evidence) => evidence.messageId),
        ),
      );
      return { writtenFiles: [], observationIds: [] };
    },
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    backupFiles: [],
    sleepImpl: async () => {},
  });

  assert.deepEqual(analyzed, [[1, 2], [3, 4], [5]]);
  assert.equal(reduced.length, 4);
  assert.equal(pageCalls, 3);
  assert.equal(report.privateChats, 1);
  assert.equal(report.processedMessages, 5);
  assert.equal(report.skippedMessages, 0);
  assert.equal(report.failedChats, 0);
});

test("a failed durable reduction keeps the cursor and resumes the same page once", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  const analyzed: number[][] = [];
  const reduced: number[][] = [];
  let fail = true;
  const options = {
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    backupDir: join(root, "backup"),
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs: [dialog], nextOffset: null }),
      messageWindow: async () => ({
        messages: [],
        latestMessageId: 2,
        skippedMessages: 0,
      }),
      messages: async (_chatId: number, afterId: number) => ({
        messages: [1, 2].filter((id) => id > afterId).map(message),
        nextAfterId: 2,
      }),
    },
    analyzePageImpl: async (input: {
      dialog: TelegramDialog;
      messages: TelegramMessage[];
    }) => {
      analyzed.push(input.messages.map((item) => item.id));
      return {
        schemaVersion: 1 as const,
        chatId: input.dialog.id,
        rollingSummary: "through 2",
        observations: [],
        questions: [],
      };
    },
    reduceBatchImpl: async (input: { batch: { rollingSummary: string } }) => {
      if (input.batch.rollingSummary === "through 2" && fail) {
        fail = false;
        throw new Error("injected_reduce_failure");
      }
      if (input.batch.rollingSummary === "through 2") reduced.push([1, 2]);
      return { writtenFiles: [], observationIds: [] };
    },
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    backupFiles: [],
  };

  const first = await runPrivateContactBackfill(options);
  const second = await runPrivateContactBackfill(options);

  assert.equal(first.failedChats, 1);
  assert.equal(second.failedChats, 0);
  assert.equal(second.processedMessages, 2);
  assert.deepEqual(analyzed, [
    [1, 2],
    [1, 2],
  ]);
  assert.deepEqual(reduced, [[1, 2]]);
});

test("an API page is split into complete context-bounded model chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  const chunks: number[][] = [];
  const longMessage = (id: number): TelegramMessage => ({
    ...message(id),
    text: "x".repeat(7_000),
  });
  await runPrivateContactBackfill({
    root,
    vault: join(root, "vault"),
    backupDir: join(root, "backup"),
    runId: "chunk-run",
    contextTokens: 24_000,
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs: [dialog], nextOffset: null }),
      messageWindow: async () => ({
        messages: [],
        latestMessageId: 2,
        skippedMessages: 0,
      }),
      messages: async () => ({
        messages: [longMessage(1), longMessage(2)],
        nextAfterId: 2,
      }),
    },
    analyzePageImpl: async (input) => {
      chunks.push(input.messages.map((item) => item.id));
      return {
        schemaVersion: 1,
        chatId: 42,
        rollingSummary: "summary",
        observations: [],
        questions: [],
      };
    },
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
  });
  assert.deepEqual(chunks, [[1], [2]]);
});

test("a private dialog with no messages still rerenders its legacy card", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  let reductions = 0;
  const report = await runPrivateContactBackfill({
    root,
    vault: join(root, "vault"),
    backupDir: join(root, "backup"),
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs: [dialog], nextOffset: null }),
      messageWindow: async () => ({
        messages: [],
        latestMessageId: 0,
        skippedMessages: 0,
      }),
      messages: async () => ({ messages: [], nextAfterId: 0 }),
    },
    analyzePageImpl: async () => {
      throw new Error("model_must_not_run");
    },
    reduceBatchImpl: async () => {
      reductions++;
      return { writtenFiles: [], observationIds: [] };
    },
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
  });
  assert.equal(report.completedChats, 1);
  assert.equal(reductions, 1);
});
