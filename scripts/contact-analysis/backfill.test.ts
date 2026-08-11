/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; injected async boundaries intentionally use synchronous fakes. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "../lib/ts-esm-hooks.ts";
import type { TelegramDialog, TelegramMessage } from "./types.ts";

const { runPrivateContactBackfill } = await import("./backfill.ts");
const {
  backfillPaths,
  loadBackfillManifest,
  loadBackfillState,
  saveBackfillState,
} = await import("./backfill-state.ts");
const { loadState, statePaths } = await import("./state.ts");
const { TelegramAnalysisError } = await import("./telegram-client.ts");

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
    backupDir: `${root}-backup`,
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
    backupDir: `${root}-backup`,
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
    backupDir: `${root}-backup`,
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
    backupDir: `${root}-backup`,
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

test("dynamic reducer destinations are backed up before their first write", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const vault = join(root, "vault");
  const backupDir = `${root}-backup`;
  const dynamic = join(vault, "cards", "projects", "dynamic.md");
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  await runPrivateContactBackfill({
    root,
    vault,
    backupDir,
    runId: "dynamic-run",
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs: [dialog], nextOffset: null }),
      messageWindow: async () => ({
        messages: [],
        latestMessageId: 1,
        skippedMessages: 0,
      }),
      messages: async () => ({ messages: [message(1)], nextAfterId: 1 }),
    },
    analyzePageImpl: async () => ({
      schemaVersion: 1,
      chatId: 42,
      rollingSummary: "done",
      observations: [],
      questions: [],
    }),
    reduceBatchFilesImpl: (input) =>
      input.batch.rollingSummary === "done"
        ? [dynamic]
        : [join(vault, "cards", "contacts", "telegram-user-42.md")],
    reduceBatchImpl: async (input) => {
      if (input.batch.rollingSummary !== "done")
        return { writtenFiles: [], observationIds: [] };
      const manifest = await loadBackfillManifest(backupDir);
      const item = manifest.files.find((candidate) =>
        candidate.path.endsWith("cards/projects/dynamic.md"),
      );
      assert.equal(item?.existed, false);
      await mkdir(join(vault, "cards", "projects"), { recursive: true });
      await writeFile(dynamic, "generated\n");
      return { writtenFiles: [dynamic], observationIds: [] };
    },
    updateQuestionWorkbookImpl: async () => ({
      file: join(vault, "inbox", "contact-analysis-questions.md"),
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
  });

  const manifest = await loadBackfillManifest(backupDir);
  const item = manifest.files.find((candidate) =>
    candidate.path.endsWith("cards/projects/dynamic.md"),
  );
  assert.equal(item?.mutationRecorded, true);
  assert.equal(await readFile(dynamic, "utf8"), "generated\n");
});

test("a frozen job remains resumable when the dialog disappears from later inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const backupDir = `${root}-backup`;
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: "person",
  };
  let dialogsVisible = true;
  let messagesAvailable = false;
  const options = {
    root,
    vault: join(root, "vault"),
    backupDir,
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({
        dialogs: dialogsVisible ? [dialog] : [],
        nextOffset: null,
      }),
      messageWindow: async () => ({
        messages: [],
        latestMessageId: 1,
        skippedMessages: 0,
      }),
      messages: async () => {
        if (!messagesAvailable) throw new Error("transient_page_failure");
        return { messages: [message(1)], nextAfterId: 1 };
      },
    },
    analyzePageImpl: async () => ({
      schemaVersion: 1 as const,
      chatId: 42,
      rollingSummary: "done",
      observations: [],
      questions: [],
    }),
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    sleepImpl: async () => {},
  };

  const failed = await runPrivateContactBackfill(options);
  dialogsVisible = false;
  messagesAvailable = true;
  const resumed = await runPrivateContactBackfill(options);
  assert.equal(failed.failedChats, 1);
  assert.equal(resumed.completedChats, 1);
  assert.equal(resumed.processedMessages, 1);
});

test("completion hands every frozen high-water to incremental sync state", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  await runPrivateContactBackfill({
    root,
    dataDir: "data",
    vault: join(root, "vault"),
    backupDir: `${root}-backup`,
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
        messages: [message(1), message(2)],
        nextAfterId: 2,
      }),
    },
    analyzePageImpl: async () => ({
      schemaVersion: 1,
      chatId: 42,
      rollingSummary: "through 2",
      observations: [],
      questions: [],
    }),
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
  });

  const incremental = await loadState(statePaths(root, "data", 7));
  assert.equal(incremental.jobs["42"]?.committedThrough, 2);
  assert.equal(incremental.jobs["42"]?.contextSummary, "through 2");
});

test("resume verifies the retained backup before another reducer mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const vault = join(root, "vault");
  const backupDir = `${root}-backup`;
  const card = join(vault, "cards", "contacts", "telegram-user-42.md");
  await mkdir(join(vault, "cards", "contacts"), { recursive: true });
  await writeFile(card, "before\n");
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  let fail = true;
  let reductions = 0;
  const options = {
    root,
    vault,
    backupDir,
    runId: "verified-run",
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
    reduceBatchImpl: async () => {
      reductions++;
      if (fail) {
        fail = false;
        throw new Error("injected_reduce_failure");
      }
      return { writtenFiles: [], observationIds: [] };
    },
    reduceBatchFilesImpl: () => [card],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    sleepImpl: async () => {},
  };

  assert.equal((await runPrivateContactBackfill(options)).failedChats, 1);
  const manifest = await loadBackfillManifest(backupDir);
  const blob = manifest.files.find((item) => item.existed)?.backupPath;
  assert.ok(blob);
  await writeFile(join(backupDir, blob), "tampered\n");
  await assert.rejects(runPrivateContactBackfill(options), /hash mismatch/u);
  assert.equal(reductions, 1);
});

test("partial high-water inventory is durable and never recaptured", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  let dialogs: TelegramDialog[] = [
    { id: 42, kind: "private", title: "First", username: null },
    { id: 43, kind: "private", title: "Second", username: null },
  ];
  let secondAvailable = false;
  const sampled: number[] = [];
  const options = {
    root,
    vault: join(root, "vault"),
    backupDir: `${root}-backup`,
    runId: "inventory-run",
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs, nextOffset: null }),
      messageWindow: async (chatId: number) => {
        sampled.push(chatId);
        if (chatId === 43 && !secondAvailable)
          throw new Error("transient_inventory_failure");
        return { messages: [], latestMessageId: 0, skippedMessages: 0 };
      },
      messages: async () => ({ messages: [], nextAfterId: 0 }),
    },
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    sleepImpl: async () => {},
  };

  await assert.rejects(
    runPrivateContactBackfill(options),
    /inventory_failure/u,
  );
  const partial = await loadBackfillState(backfillPaths(root, "data", 7));
  assert.equal(partial?.inventoryComplete, false);
  assert.deepEqual(Object.keys(partial?.jobs ?? {}), ["42"]);
  dialogs = [
    { id: 42, kind: "private", title: "First", username: null },
    { id: 44, kind: "private", title: "New", username: null },
  ];
  secondAvailable = true;
  await runPrivateContactBackfill(options);
  assert.equal(sampled.filter((chatId) => chatId === 42).length, 1);
  assert.ok(sampled.filter((chatId) => chatId === 43).length >= 2);
  assert.equal(sampled.includes(44), false);
  const complete = await loadBackfillState(backfillPaths(root, "data", 7));
  assert.deepEqual(Object.keys(complete?.jobs ?? {}), ["42", "43"]);
});

test("a rolled-back checkpoint starts a fresh run and never reuses completed cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const oldBackup = `${root}-old-backup`;
  const paths = backfillPaths(root, "data", 7);
  await saveBackfillState(paths, {
    schemaVersion: 1,
    accountUserId: 7,
    runId: "old-run",
    phase: "rolled_back",
    vaultDir: join(root, "vault"),
    backupDir: oldBackup,
    backupReady: true,
    inventoryComplete: true,
    incrementalHandoffComplete: false,
    incrementalStateBefore: { schemaVersion: 1, accountUserId: 7, jobs: {} },
    inventory: [{ id: 42, title: "Person", username: null }],
    jobs: {
      "42": {
        chatId: 42,
        title: "Person",
        username: null,
        highWaterId: 1,
        committedThrough: 1,
        contextSummary: "old",
        processedMessages: 1,
        status: "complete",
        lastErrorCode: null,
      },
    },
  });
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  const report = await runPrivateContactBackfill({
    root,
    vault: join(root, "vault"),
    backupDir: `${root}-new-backup`,
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
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
  });
  const fresh = await loadBackfillState(paths);
  assert.equal(report.completedChats, 1);
  assert.notEqual(fresh?.runId, "old-run");
  assert.equal(fresh?.jobs["42"]?.processedMessages, 0);
});

test("transient Telegram failures honor retry-after while authorization loss aborts the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  const sleeps: number[] = [];
  let calls = 0;
  await runPrivateContactBackfill({
    root,
    vault: join(root, "vault"),
    backupDir: `${root}-retry-backup`,
    client: {
      account: async () => ({
        userId: 7,
        displayName: "Owner",
        username: null,
      }),
      dialogs: async () => ({ dialogs: [dialog], nextOffset: null }),
      messageWindow: async () => ({
        messages: [],
        latestMessageId: 1,
        skippedMessages: 0,
      }),
      messages: async () => {
        calls++;
        if (calls === 1)
          throw new TelegramAnalysisError("telegram_analysis_http_503", 2);
        return { messages: [message(1)], nextAfterId: 1 };
      },
    },
    analyzePageImpl: async () => ({
      schemaVersion: 1,
      chatId: 42,
      rollingSummary: "done",
      observations: [],
      questions: [],
    }),
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });
  assert.deepEqual(sleeps, [2000]);

  await assert.rejects(
    runPrivateContactBackfill({
      root: `${root}-auth`,
      vault: join(`${root}-auth`, "vault"),
      backupDir: `${root}-auth-backup`,
      client: {
        account: async () => ({
          userId: 7,
          displayName: "Owner",
          username: null,
        }),
        dialogs: async () => ({ dialogs: [dialog], nextOffset: null }),
        messageWindow: async () => ({
          messages: [],
          latestMessageId: 1,
          skippedMessages: 0,
        }),
        messages: async () => {
          throw new TelegramAnalysisError("telegram_analysis_http_409");
        },
      },
      reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
      reduceBatchFilesImpl: () => [],
      updateQuestionWorkbookImpl: async () => ({
        file: "questions",
        questionIds: [],
      }),
      readSkillTextImpl: async () => "skill",
      sleepImpl: async () => {},
    }),
    /authorization_lost/u,
  );
});

test("oversized message fragments commit atomically under one evidence cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  const oversized = { ...message(1), text: "x".repeat(180_000) };
  let allowAllFragments = false;
  let analyzedInAttempt = 0;
  let reductions = 0;
  const options = {
    root,
    vault: join(root, "vault"),
    backupDir: `${root}-backup`,
    runId: "fragment-run",
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
        latestMessageId: 1,
        skippedMessages: 0,
      }),
      messages: async () => ({ messages: [oversized], nextAfterId: 1 }),
    },
    analyzePageImpl: async () => {
      analyzedInAttempt++;
      if (!allowAllFragments && analyzedInAttempt > 1)
        throw new Error("fragment_analysis_failure");
      return {
        schemaVersion: 1 as const,
        chatId: 42,
        rollingSummary: `fragment ${analyzedInAttempt}`,
        observations: [],
        questions: [],
      };
    },
    reduceBatchImpl: async () => {
      reductions++;
      return { writtenFiles: [], observationIds: [] };
    },
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    sleepImpl: async () => {},
  };

  const failed = await runPrivateContactBackfill(options);
  const checkpoint = await loadBackfillState(backfillPaths(root, "data", 7));
  assert.equal(failed.failedChats, 1);
  assert.equal(checkpoint?.jobs["42"]?.committedThrough, 0);
  assert.equal(reductions, 1, "only the empty legacy rerender may commit");

  allowAllFragments = true;
  analyzedInAttempt = 0;
  const resumed = await runPrivateContactBackfill(options);
  assert.equal(resumed.processedMessages, 1);
  assert.ok(
    reductions > 2,
    "all fragments reduce only after analysis succeeds",
  );
});

test("final person-task reconciliation is included in the verified rollback set", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-private-backfill-"));
  const vault = join(root, "vault");
  const backupDir = `${root}-backup`;
  const tasksFile = join(vault, "tasks", "people.md");
  await mkdir(join(vault, "tasks"), { recursive: true });
  await writeFile(tasksFile, "before\n");
  const dialog: TelegramDialog = {
    id: 42,
    kind: "private",
    title: "Person",
    username: null,
  };
  await runPrivateContactBackfill({
    root,
    vault,
    backupDir,
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
    reduceBatchImpl: async () => ({ writtenFiles: [], observationIds: [] }),
    reduceBatchFilesImpl: () => [],
    updateQuestionWorkbookImpl: async () => ({
      file: "questions",
      questionIds: [],
    }),
    readSkillTextImpl: async () => "skill",
    reconcilePersonTaskFilesImpl: () => [tasksFile],
    reconcilePersonTasksImpl: async () => {
      const manifest = await loadBackfillManifest(backupDir);
      assert.equal(
        manifest.files.find((item) => item.path === "tasks/people.md")
          ?.sha256 !== null,
        true,
      );
      await writeFile(tasksFile, "after\n");
      return { changedFiles: [tasksFile] };
    },
  });
  const manifest = await loadBackfillManifest(backupDir);
  assert.equal(
    manifest.files.find((item) => item.path === "tasks/people.md")
      ?.mutationRecorded,
    true,
  );
});
