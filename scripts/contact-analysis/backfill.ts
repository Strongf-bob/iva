import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { runContactMemoryTransaction } from "../../agent/lib/contact-memory-transaction.ts";
import {
  analyzePage,
  chunkMessages,
  skillPathFor,
  type AnalyzePageInput,
} from "./analyzer.ts";
import {
  backfillPaths,
  createBackfillBackup,
  ensureBackfillBackupFiles,
  loadBackfillManifest,
  loadBackfillState,
  recordBackfillPostimages,
  saveBackfillState,
  verifyBackfillBackup,
  type BackfillManifest,
  type BackfillState,
} from "./backfill-state.ts";
import { messageCharacterBudget } from "./context-budget.ts";
import { isAuthorizationLoss, withTransientRetries } from "./coordinator.ts";
import {
  updateQuestionWorkbook,
  type UpdateQuestionWorkbookInput,
  type UpdateQuestionWorkbookResult,
} from "./question-workbook.ts";
import {
  reduceBatch,
  reduceBatchFiles,
  contactCardPath,
  type ReduceBatchInput,
  type ReduceResult,
} from "./reducer.ts";
import { loadState, saveState, statePaths } from "./state.ts";
import {
  personTaskReconciliationFiles,
  reconcilePersonTasks,
} from "../contact-memory/reconcile.ts";
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
  reduceBatchFilesImpl?: (input: ReduceBatchInput) => string[];
  updateQuestionWorkbookImpl?: (
    input: UpdateQuestionWorkbookInput,
  ) => Promise<UpdateQuestionWorkbookResult>;
  readSkillTextImpl?: (dialog: TelegramDialog) => Promise<string>;
  contextTokens?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  reconcilePersonTaskFilesImpl?: typeof personTaskReconciliationFiles;
  reconcilePersonTasksImpl?: typeof reconcilePersonTasks;
  today?: string;
}

async function inventoryPrivateDialogs(
  client: TelegramAnalysisClient,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<TelegramDialog[]> {
  const dialogs: TelegramDialog[] = [];
  let offset = 0;
  for (;;) {
    const page = await withTransientRetries(
      () => client.dialogs(offset, 100),
      sleep,
    );
    dialogs.push(...page.dialogs.filter((dialog) => dialog.kind === "private"));
    if (page.nextOffset === null) return dialogs;
    if (page.nextOffset <= offset)
      throw new Error("telegram_private_backfill_invalid_dialog_cursor");
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

function dialogFromJob(job: BackfillState["jobs"][string]): TelegramDialog {
  return {
    id: job.chatId,
    kind: "private",
    title: job.title,
    username: job.username,
  };
}

function atomicChunkGroups(
  chunks: readonly TelegramMessage[][],
): TelegramMessage[][][] {
  const groups: TelegramMessage[][][] = [];
  for (let index = 0; index < chunks.length;) {
    const group = [chunks[index]];
    const ids = new Set(chunks[index].map((message) => message.id));
    let next = index + 1;
    while (
      next < chunks.length &&
      chunks[next].some((message) => ids.has(message.id))
    ) {
      group.push(chunks[next]);
      for (const message of chunks[next]) ids.add(message.id);
      next++;
    }
    groups.push(group);
    index = next;
  }
  return groups;
}

function resolvedDataDir(root: string, dataDir: string): string {
  return isAbsolute(dataDir) ? dataDir : join(root, dataDir);
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
  reduceBatchFilesImpl = reduceBatchFiles,
  updateQuestionWorkbookImpl = updateQuestionWorkbook,
  readSkillTextImpl = (dialog) => readFile(skillPathFor(dialog.kind), "utf8"),
  contextTokens = Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131_072),
  sleepImpl = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  reconcilePersonTaskFilesImpl = personTaskReconciliationFiles,
  reconcilePersonTasksImpl = reconcilePersonTasks,
  today = new Date().toLocaleDateString("sv-SE", {
    timeZone: process.env.ASSISTANT_TIMEZONE ?? "UTC",
  }),
}: RunPrivateContactBackfillOptions): Promise<PrivateBackfillReport> {
  if (!client.messages)
    throw new Error("telegram_private_backfill_messages_unavailable");
  const account = await withTransientRetries(() => client.account(), sleepImpl);
  if (dryRun) {
    const dialogs = await inventoryPrivateDialogs(client, sleepImpl);
    for (const dialog of dialogs)
      await withTransientRetries(
        () => client.messageWindow(dialog.id, 0, 1),
        sleepImpl,
      );
    return {
      privateChats: dialogs.length,
      completedChats: 0,
      failedChats: 0,
      processedMessages: 0,
      skippedMessages: 0,
    };
  }

  {
    const normalizedVault = resolve(vault);
    const normalizedBackupDir = resolve(backupDir);
    const paths = backfillPaths(root, dataDir, account.userId);
    const incrementalPaths = statePaths(
      root,
      resolvedDataDir(root, dataDir),
      account.userId,
    );
    const existing = await loadBackfillState(paths);
    const rolledBack = existing?.phase === "rolled_back";
    const runId =
      requestedRunId ??
      (existing && !rolledBack ? existing.runId : randomUUID());
    if (
      existing &&
      existing.runId !== runId &&
      !["complete", "rolled_back"].includes(existing.phase)
    )
      throw new Error("telegram_private_backfill_already_active");
    if (rolledBack && existing?.runId === runId)
      throw new Error("telegram_private_backfill_rolled_back_run_is_terminal");

    let state: BackfillState;
    if (existing?.runId === runId) {
      state = existing;
    } else {
      const incrementalStateBefore = await loadState(incrementalPaths);
      state = {
        schemaVersion: 1,
        accountUserId: account.userId,
        runId,
        phase: "inventory",
        vaultDir: normalizedVault,
        backupDir: normalizedBackupDir,
        backupReady: false,
        inventoryComplete: false,
        incrementalHandoffComplete: false,
        incrementalStateBefore,
        inventory: [],
        jobs: {},
      };
      const dialogs = await inventoryPrivateDialogs(client, sleepImpl);
      state.inventory = dialogs.map(({ id, title, username }) => ({
        id,
        title,
        username,
      }));
      await saveBackfillState(paths, state);
    }
    if (state.vaultDir !== normalizedVault)
      throw new Error("telegram_private_backfill_vault_directory_mismatch");
    if (state.backupDir !== normalizedBackupDir)
      throw new Error("telegram_private_backfill_backup_directory_mismatch");

    if (!state.inventoryComplete) {
      for (const frozen of state.inventory) {
        const dialog: TelegramDialog = { ...frozen, kind: "private" };
        if (state.jobs[String(dialog.id)]) continue;
        const highWater = await withTransientRetries(
          () => client.messageWindow(dialog.id, 0, 1),
          sleepImpl,
        );
        state.jobs[String(dialog.id)] = {
          chatId: dialog.id,
          title: dialog.title,
          username: dialog.username,
          highWaterId: highWater.latestMessageId,
          committedThrough: 0,
          contextSummary: "",
          processedMessages: 0,
          status: "ready",
          lastErrorCode: null,
        };
        await saveBackfillState(paths, state);
      }
      state.inventoryComplete = true;
      await saveBackfillState(paths, state);
    }

    const frozenDialogs = Object.values(state.jobs)
      .map(dialogFromJob)
      .sort((left, right) => left.id - right.id);
    const workbookFile = join(vault, "inbox", "contact-analysis-questions.md");
    const initialFiles =
      backupFiles.length > 0
        ? backupFiles
        : [
            ...frozenDialogs.map((dialog) => contactCardPath(vault, dialog.id)),
            join(vault, "tasks", "people.md"),
            workbookFile,
          ];
    let manifest: BackfillManifest;
    if (state.backupReady) {
      manifest = await loadBackfillManifest(state.backupDir);
      if (
        manifest.accountUserId !== state.accountUserId ||
        manifest.runId !== state.runId
      )
        throw new Error("telegram_private_backfill_backup_identity_mismatch");
      await verifyBackfillBackup({
        root,
        vault,
        backupDir: state.backupDir,
        manifest,
      });
    } else {
      manifest = await createBackfillBackup({
        root,
        vault,
        backupDir: state.backupDir,
        accountUserId: account.userId,
        runId,
        files: [],
      });
      await runContactMemoryTransaction(vault, [...initialFiles], async () => {
        manifest = await ensureBackfillBackupFiles({
          root,
          vault,
          backupDir: state.backupDir,
          manifest,
          files: initialFiles,
        });
      });
      state.backupReady = true;
      state.phase = "running";
      await saveBackfillState(paths, state);
    }
    state.phase = "running";
    await saveBackfillState(paths, state);

    const applyBatches = async (
      dialog: TelegramDialog,
      batches: readonly AnalysisPage[],
      commit: (candidate: BackfillState) => void,
    ): Promise<void> => {
      const graphInputs: ReduceBatchInput[] = batches.map((batch) => ({
        vault,
        ownerUserId: account.userId,
        dialog,
        batch,
      }));
      const files = [
        ...new Set([
          ...graphInputs.flatMap((input) => reduceBatchFilesImpl(input)),
          workbookFile,
        ]),
      ].sort();
      await runContactMemoryTransaction(vault, files, async () => {
        manifest = await ensureBackfillBackupFiles({
          root,
          vault,
          backupDir: state.backupDir,
          manifest,
          files,
        });
        for (const graphInput of graphInputs) {
          await reduceBatchImpl({ ...graphInput, transactionLocked: true });
          await updateQuestionWorkbookImpl({
            vault,
            dialog,
            questions: graphInput.batch.questions ?? [],
          });
        }
        manifest = await recordBackfillPostimages({
          root,
          vault,
          backupDir: state.backupDir,
          manifest,
          files,
        });
      });
      const candidate = structuredClone(state);
      commit(candidate);
      await saveBackfillState(paths, candidate);
      state = candidate;
    };

    for (const dialog of frozenDialogs) {
      const job = state.jobs[String(dialog.id)];
      if (!job || job.status === "complete") continue;
      job.status = "running";
      await saveBackfillState(paths, state);
      try {
        const skillText = await readSkillTextImpl(dialog);
        await applyBatches(
          dialog,
          [
            {
              schemaVersion: 1,
              chatId: dialog.id,
              rollingSummary: job.contextSummary,
              observations: [],
              questions: [],
            },
          ],
          () => {},
        );
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
        while (
          state.jobs[String(dialog.id)].committedThrough < job.highWaterId
        ) {
          const currentJob = state.jobs[String(dialog.id)];
          const page = await withTransientRetries(
            () => client.messages!(dialog.id, currentJob.committedThrough, 200),
            sleepImpl,
          );
          if (
            page.nextAfterId <= currentJob.committedThrough ||
            page.messages.some(
              (message, index) =>
                message.id <= currentJob.committedThrough ||
                (index > 0 && message.id <= page.messages[index - 1].id),
            )
          )
            throw new Error("telegram_private_backfill_invalid_message_cursor");
          const messages = page.messages.filter(
            (message) => message.id <= currentJob.highWaterId,
          );
          if (messages.length === 0)
            throw new Error("telegram_private_backfill_high_water_unreachable");
          const chunks = chunkMessages(messages, maxChars);
          for (const group of atomicChunkGroups(chunks)) {
            const batches: AnalysisPage[] = [];
            let rollingSummary = state.jobs[String(dialog.id)].contextSummary;
            for (const chunk of group) {
              const batch = await withTransientRetries(
                () =>
                  analyzePageImpl({
                    ownerUserId: account.userId,
                    dialog,
                    rollingSummary,
                    messages: chunk,
                    allowedSubjects: allowedSubjects(
                      account.userId,
                      dialog,
                      chunk,
                    ),
                    skillText,
                  }),
                sleepImpl,
              );
              batches.push(batch);
              rollingSummary = batch.rollingSummary;
            }
            const completedIds = new Set(
              group.flatMap((chunk) => chunk.map((message) => message.id)),
            );
            const committedThrough = Math.max(...completedIds);
            await applyBatches(dialog, batches, (candidate) => {
              const candidateJob = candidate.jobs[String(dialog.id)];
              candidateJob.contextSummary = rollingSummary;
              candidateJob.committedThrough = committedThrough;
              candidateJob.processedMessages += completedIds.size;
            });
          }
        }
        const candidate = structuredClone(state);
        candidate.jobs[String(dialog.id)].status = "complete";
        candidate.jobs[String(dialog.id)].lastErrorCode = null;
        await saveBackfillState(paths, candidate);
        state = candidate;
      } catch (error) {
        const candidate = structuredClone(state);
        candidate.jobs[String(dialog.id)].status = "retry";
        candidate.jobs[String(dialog.id)].lastErrorCode = errorCode(error);
        candidate.phase = "failed";
        await saveBackfillState(paths, candidate);
        state = candidate;
        if (
          isAuthorizationLoss(error) ||
          errorCode(error) === "telegram_analysis_authorization_lost"
        )
          throw error;
      }
    }

    const failedJobs = Object.values(state.jobs).filter(
      (job) => job.status !== "complete",
    );
    if (failedJobs.length === 0) {
      const personPaths = frozenDialogs.map((dialog) =>
        relative(vault, contactCardPath(vault, dialog.id)).replace(
          /\.md$/u,
          "",
        ),
      );
      const files = reconcilePersonTaskFilesImpl({ vault, personPaths });
      if (files.length > 0) {
        await runContactMemoryTransaction(vault, files, async () => {
          manifest = await ensureBackfillBackupFiles({
            root,
            vault,
            backupDir: state.backupDir,
            manifest,
            files,
          });
          await reconcilePersonTasksImpl({
            vault,
            today,
            personPaths,
            transactionLocked: true,
          });
          manifest = await recordBackfillPostimages({
            root,
            vault,
            backupDir: state.backupDir,
            manifest,
            files,
          });
        });
      }
    }
    if (failedJobs.length === 0 && !state.incrementalHandoffComplete) {
      const incremental = await loadState(incrementalPaths);
      for (const job of Object.values(state.jobs)) {
        const key = String(job.chatId);
        const prior = incremental.jobs[key];
        if (prior && prior.committedThrough > job.highWaterId) continue;
        incremental.jobs[key] = {
          chatId: job.chatId,
          kind: "private",
          title: job.title,
          committedThrough: job.highWaterId,
          contextSummary: job.contextSummary,
          skippedMessages: prior?.skippedMessages ?? 0,
          status: "complete",
          attempts: prior?.attempts ?? 0,
          lastErrorCode: null,
        };
      }
      await saveState(incrementalPaths, incremental);
      state.incrementalHandoffComplete = true;
    }
    state.phase = failedJobs.length === 0 ? "complete" : "failed";
    await saveBackfillState(paths, state);
    return {
      privateChats: Object.keys(state.jobs).length,
      completedChats: Object.values(state.jobs).filter(
        (job) => job.status === "complete",
      ).length,
      failedChats: failedJobs.length,
      processedMessages: Object.values(state.jobs).reduce(
        (total, job) => total + job.processedMessages,
        0,
      ),
      skippedMessages: 0,
    };
  }
}
