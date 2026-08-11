import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  analyzePage,
  chunkMessages,
  skillPathFor,
  type AnalyzePageInput,
} from "./analyzer.ts";
import {
  createBackfillBackup,
  loadBackfillState,
  saveBackfillState,
  backfillPaths,
  type BackfillState,
} from "./backfill-state.ts";
import { messageCharacterBudget } from "./context-budget.ts";
import {
  updateQuestionWorkbook,
  type UpdateQuestionWorkbookInput,
  type UpdateQuestionWorkbookResult,
} from "./question-workbook.ts";
import {
  reduceBatch,
  contactCardPath,
  type ReduceBatchInput,
  type ReduceResult,
} from "./reducer.ts";
import {
  createTelegramAnalysisClient,
  type TelegramAnalysisClient,
} from "./telegram-client.ts";
import {
  canonicalChatId,
  canonicalUserId,
  type AnalysisPage,
  type TelegramDialog,
  type TelegramMessage,
} from "./types.ts";

export interface PrivateBackfillReport {
  privateChats: number;
  completedChats: number;
  failedChats: number;
  processedMessages: number;
  skippedMessages: 0;
}

export interface RunPrivateContactBackfillOptions {
  root?: string;
  dataDir?: string;
  tokenPath?: string;
  vault?: string;
  backupDir: string;
  backupFiles?: readonly string[];
  dryRun?: boolean;
  runId?: string;
  client?: TelegramAnalysisClient;
  analyzePageImpl?: (input: AnalyzePageInput) => Promise<AnalysisPage>;
  reduceBatchImpl?: (input: ReduceBatchInput) => Promise<ReduceResult>;
  updateQuestionWorkbookImpl?: (
    input: UpdateQuestionWorkbookInput,
  ) => Promise<UpdateQuestionWorkbookResult>;
  readSkillTextImpl?: (dialog: TelegramDialog) => Promise<string>;
  contextTokens?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

async function inventoryPrivateDialogs(
  client: TelegramAnalysisClient,
): Promise<TelegramDialog[]> {
  const dialogs: TelegramDialog[] = [];
  let offset = 0;
  for (;;) {
    const page = await client.dialogs(offset, 100);
    dialogs.push(...page.dialogs.filter((dialog) => dialog.kind === "private"));
    if (page.nextOffset === null) return dialogs;
    if (page.nextOffset <= offset)
      throw new Error("telegram_backfill_invalid_dialog_cursor");
    offset = page.nextOffset;
  }
}

function allowedSubjects(
  ownerUserId: number,
  dialog: TelegramDialog,
  messages: readonly TelegramMessage[],
): Set<string> {
  const subjects = new Set([
    canonicalUserId(ownerUserId),
    canonicalUserId(dialog.id),
    canonicalChatId(dialog.id),
  ]);
  for (const message of messages) {
    if (message.senderId !== null)
      subjects.add(canonicalUserId(message.senderId));
    for (const userId of message.mentionedUserIds)
      subjects.add(canonicalUserId(userId));
  }
  return subjects;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]+$/u.test(message)
    ? message
    : "telegram_private_backfill_failed";
}

export async function runPrivateContactBackfill({
  root = process.cwd(),
  dataDir = "data",
  tokenPath,
  vault = process.env.ASSISTANT_VAULT_DIR ?? `${root}/vault`,
  backupDir,
  backupFiles = [],
  dryRun = false,
  runId: requestedRunId,
  client = createTelegramAnalysisClient({ root, dataDir, tokenPath }),
  analyzePageImpl = analyzePage,
  reduceBatchImpl = reduceBatch,
  updateQuestionWorkbookImpl = updateQuestionWorkbook,
  readSkillTextImpl = (dialog) => readFile(skillPathFor(dialog.kind), "utf8"),
  contextTokens = Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131_072),
}: RunPrivateContactBackfillOptions): Promise<PrivateBackfillReport> {
  if (!client.messages)
    throw new Error("telegram_private_backfill_messages_unavailable");
  const account = await client.account();
  const dialogs = await inventoryPrivateDialogs(client);
  if (dryRun) {
    for (const dialog of dialogs) await client.messageWindow(dialog.id, 0, 1);
    return {
      privateChats: dialogs.length,
      completedChats: 0,
      failedChats: 0,
      processedMessages: 0,
      skippedMessages: 0,
    };
  }
  const paths = backfillPaths(root, dataDir, account.userId);
  const existing = await loadBackfillState(paths);
  const runId = requestedRunId ?? existing?.runId ?? randomUUID();
  if (existing && existing.runId !== runId && existing.phase !== "complete")
    throw new Error("telegram_private_backfill_already_active");
  const state: BackfillState =
    existing?.runId === runId
      ? existing
      : {
          schemaVersion: 1,
          accountUserId: account.userId,
          runId,
          phase: "inventory",
          backupManifest: null,
          jobs: {},
        };

  for (const dialog of dialogs) {
    if (state.jobs[String(dialog.id)]) continue;
    const highWater = await client.messageWindow(dialog.id, 0, 1);
    state.jobs[String(dialog.id)] = {
      chatId: dialog.id,
      title: dialog.title,
      highWaterId: highWater.latestMessageId,
      committedThrough: 0,
      contextSummary: "",
      processedMessages: 0,
      status: "ready",
      lastErrorCode: null,
    };
  }
  if (!state.backupManifest) {
    state.backupManifest = await createBackfillBackup({
      vault,
      backupDir,
      accountUserId: account.userId,
      runId,
      files:
        backupFiles.length > 0
          ? backupFiles
          : [
              ...dialogs.map((dialog) => contactCardPath(vault, dialog.id)),
              join(vault, "tasks", "people.md"),
              join(vault, "inbox", "contact-analysis-questions.md"),
            ],
    });
  }
  state.phase = "running";
  await saveBackfillState(paths, state);

  let failedChats = 0;
  for (const dialog of dialogs) {
    const job = state.jobs[String(dialog.id)];
    if (!job || job.status === "complete") continue;
    job.status = "running";
    try {
      const skillText = await readSkillTextImpl(dialog);
      await reduceBatchImpl({
        vault,
        ownerUserId: account.userId,
        dialog,
        batch: {
          schemaVersion: 1,
          chatId: dialog.id,
          rollingSummary: job.contextSummary,
          observations: [],
          questions: [],
        },
      });
      const maxChars = messageCharacterBudget({
        contextTokens,
        skillChars: skillText.length,
        envelopeChars: JSON.stringify({
          ownerUserId: account.userId,
          dialog,
          rollingSummary: job.contextSummary,
          messages: [],
        }).length,
      });
      while (job.committedThrough < job.highWaterId) {
        const page = await client.messages(
          dialog.id,
          job.committedThrough,
          200,
        );
        if (
          page.nextAfterId <= job.committedThrough ||
          page.messages.some(
            (message, index) =>
              message.id <= job.committedThrough ||
              (index > 0 && message.id <= page.messages[index - 1].id),
          )
        )
          throw new Error("telegram_private_backfill_invalid_message_cursor");
        const messages = page.messages.filter(
          (message) => message.id <= job.highWaterId,
        );
        if (messages.length === 0)
          throw new Error("telegram_private_backfill_high_water_unreachable");
        for (const chunk of chunkMessages(messages, maxChars)) {
          const batch = await analyzePageImpl({
            ownerUserId: account.userId,
            dialog,
            rollingSummary: job.contextSummary,
            messages: chunk,
            allowedSubjects: allowedSubjects(account.userId, dialog, chunk),
            skillText,
          });
          await reduceBatchImpl({
            vault,
            ownerUserId: account.userId,
            dialog,
            batch,
          });
          await updateQuestionWorkbookImpl({
            vault,
            dialog,
            questions: batch.questions ?? [],
          });
          job.contextSummary = batch.rollingSummary;
          job.committedThrough = chunk.at(-1)!.id;
          job.processedMessages += chunk.length;
          await saveBackfillState(paths, state);
        }
      }
      job.status = "complete";
      job.lastErrorCode = null;
    } catch (error) {
      job.status = "retry";
      job.lastErrorCode = errorCode(error);
      failedChats++;
    }
    await saveBackfillState(paths, state);
  }
  state.phase = failedChats === 0 ? "complete" : "failed";
  await saveBackfillState(paths, state);
  return {
    privateChats: dialogs.length,
    completedChats: Object.values(state.jobs).filter(
      (job) => job.status === "complete",
    ).length,
    failedChats,
    processedMessages: Object.values(state.jobs).reduce(
      (total, job) => total + job.processedMessages,
      0,
    ),
    skippedMessages: 0,
  };
}
