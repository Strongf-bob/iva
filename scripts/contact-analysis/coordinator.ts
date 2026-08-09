import { readFile } from "node:fs/promises";
import { ZodError } from "zod";

import {
  analyzePage,
  skillPathFor,
  type AnalyzePageInput,
} from "./analyzer.ts";
import { messageCharacterBudget } from "./context-budget.ts";
import {
  updateQuestionWorkbook,
  type UpdateQuestionWorkbookInput,
  type UpdateQuestionWorkbookResult,
} from "./question-workbook.ts";
import {
  reduceBatch,
  type ReduceBatchInput,
  type ReduceResult,
} from "./reducer.ts";
import {
  loadState,
  saveState,
  statePaths,
  type ContactAnalysisState,
} from "./state.ts";
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

export type SettledItem<T> =
  | { item: T; status: "fulfilled"; value: T }
  | { item: T; status: "rejected"; reason: unknown };

export async function runWorkerPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<T>,
): Promise<SettledItem<T>[]>;
export async function runWorkerPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<
  Array<
    | { item: T; status: "fulfilled"; value: R }
    | { item: T; status: "rejected"; reason: unknown }
  >
>;
export async function runWorkerPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<
  Array<
    | { item: T; status: "fulfilled"; value: R }
    | { item: T; status: "rejected"; reason: unknown }
  >
> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new TypeError("concurrency must be a safe positive integer");
  }
  const results = new Array<
    | { item: T; status: "fulfilled"; value: R }
    | { item: T; status: "rejected"; reason: unknown }
  >(items.length);
  let nextIndex = 0;
  const loops = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) return;
        const item = items[index];
        try {
          results[index] = {
            item,
            status: "fulfilled",
            value: await worker(item),
          };
        } catch (reason) {
          results[index] = { item, status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(loops);
  return results;
}

export interface ContactAnalysisReport {
  completedChats: number;
  pendingChats: number;
  blockedChats: number;
  failedChats: number;
  processedMessages: number;
  unsupportedMedia: number;
  skippedMessages: number;
  generatedQuestions: number;
}

export interface RunContactAnalysisOptions {
  root?: string;
  dataDir?: string;
  tokenPath?: string;
  vault?: string;
  client?: TelegramAnalysisClient;
  concurrency?: number;
  analyzePageImpl?: (input: AnalyzePageInput) => Promise<AnalysisPage>;
  reduceBatchImpl?: (input: ReduceBatchInput) => Promise<ReduceResult>;
  updateQuestionWorkbookImpl?: (
    input: UpdateQuestionWorkbookInput,
  ) => Promise<UpdateQuestionWorkbookResult>;
  readSkillTextImpl?: (dialog: TelegramDialog) => Promise<string>;
  contextTokens?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function isAuthorizationLoss(error: unknown): boolean {
  return errorMessage(error) === "telegram_analysis_http_409";
}

function isPermanentAnalysisFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    error instanceof ZodError ||
    /(?:invalid_response|invalid_parameters|was not allowed|was not present|did not match)/u.test(
      message,
    )
  );
}

function sanitizedErrorCode(error: unknown): string {
  const message = errorMessage(error);
  if (/^telegram_analysis_[a-z0-9_]+$/u.test(message)) return message;
  if (error instanceof ZodError) return "contact_analysis_validation_failed";
  return "contact_analysis_failed";
}

function retryAfterMilliseconds(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const retryAfter = (error as Error & { retryAfterSeconds?: unknown })
    .retryAfterSeconds;
  return typeof retryAfter === "number" && retryAfter > 0
    ? retryAfter * 1000
    : null;
}

async function withTransientRetries<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<T> {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (isAuthorizationLoss(error)) {
        throw new Error("telegram_analysis_authorization_lost", {
          cause: error,
        });
      }
      if (isPermanentAnalysisFailure(error) || attempt >= delays.length) {
        throw error;
      }
      await sleep(retryAfterMilliseconds(error) ?? delays[attempt]);
    }
  }
}

async function inventoryDialogs(
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
    dialogs.push(...page.dialogs);
    if (page.nextOffset === null) return dialogs;
    if (page.nextOffset <= offset) {
      throw new Error("telegram_analysis_invalid_dialog_cursor");
    }
    offset = page.nextOffset;
  }
}

function upsertJobs(
  state: ContactAnalysisState,
  dialogs: readonly TelegramDialog[],
): void {
  for (const dialog of dialogs) {
    const key = String(dialog.id);
    const existing = state.jobs[key];
    state.jobs[key] = {
      chatId: dialog.id,
      kind: dialog.kind,
      title: dialog.title,
      committedThrough: existing?.committedThrough ?? 0,
      contextSummary: existing?.contextSummary ?? "",
      skippedMessages: existing?.skippedMessages ?? 0,
      status: "ready",
      attempts: existing?.attempts ?? 0,
      lastErrorCode: null,
    };
  }
}

function allowedSubjects(
  ownerUserId: number,
  dialog: TelegramDialog,
  messages: readonly TelegramMessage[],
): Set<string> {
  const subjects = new Set<string>([
    canonicalUserId(ownerUserId),
    canonicalChatId(dialog.id),
  ]);
  if (["private", "bot"].includes(dialog.kind) && dialog.id > 0) {
    subjects.add(canonicalUserId(dialog.id));
  }
  for (const message of messages) {
    if (message.senderId !== null)
      subjects.add(canonicalUserId(message.senderId));
    for (const userId of message.mentionedUserIds) {
      subjects.add(canonicalUserId(userId));
    }
  }
  return subjects;
}

export async function runContactAnalysis({
  root = process.cwd(),
  dataDir = "data",
  tokenPath,
  vault = process.env.ASSISTANT_VAULT_DIR ?? `${root}/vault`,
  client = createTelegramAnalysisClient({ root, dataDir, tokenPath }),
  concurrency = 3,
  analyzePageImpl = analyzePage,
  reduceBatchImpl = reduceBatch,
  updateQuestionWorkbookImpl = updateQuestionWorkbook,
  readSkillTextImpl = (dialog) => readFile(skillPathFor(dialog.kind), "utf8"),
  contextTokens = Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131_072),
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: RunContactAnalysisOptions = {}): Promise<ContactAnalysisReport> {
  let account;
  try {
    account = await withTransientRetries(() => client.account(), sleepImpl);
  } catch (error) {
    if (
      isAuthorizationLoss(error) ||
      errorMessage(error) === "telegram_analysis_authorization_lost"
    ) {
      throw new Error("telegram_analysis_authorization_lost", {
        cause: error,
      });
    }
    throw error;
  }
  const paths = statePaths(root, dataDir, account.userId);
  const state = await loadState(paths);
  const dialogs = await inventoryDialogs(client, sleepImpl);
  upsertJobs(state, dialogs);

  let persistChain = Promise.resolve();
  const persist = async () => {
    const snapshot = structuredClone(state);
    const pending = persistChain.then(() => saveState(paths, snapshot));
    persistChain = pending.catch(() => {});
    await pending;
  };
  await persist();

  let reducerChain = Promise.resolve();
  const enqueueReduction = (
    graphInput: ReduceBatchInput,
    workbookInput: UpdateQuestionWorkbookInput,
  ) => {
    const pending = reducerChain.then(async () => {
      const graph = await reduceBatchImpl(graphInput);
      const workbook = await updateQuestionWorkbookImpl(workbookInput);
      return { graph, workbook };
    });
    reducerChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  let processedMessages = 0;
  let unsupportedMedia = 0;
  let skippedMessages = 0;
  let generatedQuestions = 0;
  const sortedDialogs = [...dialogs].sort((left, right) => left.id - right.id);

  const results = await runWorkerPool(
    sortedDialogs,
    concurrency,
    async (dialog) => {
      const job = state.jobs[String(dialog.id)];
      if (!job) throw new Error("contact analysis job was not inventoried");
      job.status = "running";
      try {
        const skillText = await readSkillTextImpl(dialog);
        const envelopeChars = JSON.stringify({
          ownerUserId: account.userId,
          dialog,
          rollingSummary: job.contextSummary,
          messages: [],
        }).length;
        const maxChars = messageCharacterBudget({
          contextTokens,
          skillChars: skillText.length,
          envelopeChars,
        });
        const page = await withTransientRetries(
          () => client.messageWindow(dialog.id, job.committedThrough, maxChars),
          sleepImpl,
        );
        if (
          page.latestMessageId < job.committedThrough ||
          (page.messages.length > 0 &&
            (page.latestMessageId <= job.committedThrough ||
              page.messages.some(
                (message, index) =>
                  message.id <= job.committedThrough ||
                  message.id > page.latestMessageId ||
                  (index > 0 && message.id <= page.messages[index - 1].id),
              )))
        ) {
          throw new Error("telegram_analysis_invalid_message_cursor");
        }
        if (page.messages.length > 0) {
          const batch = await analyzePageImpl({
            ownerUserId: account.userId,
            dialog,
            rollingSummary: job.contextSummary,
            messages: page.messages,
            allowedSubjects: allowedSubjects(
              account.userId,
              dialog,
              page.messages,
            ),
            skillText,
          });
          await enqueueReduction(
            {
              vault,
              ownerUserId: account.userId,
              dialog,
              batch,
            },
            {
              vault,
              dialog,
              questions: batch.questions ?? [],
            },
          );
          job.contextSummary = batch.rollingSummary;
          processedMessages += page.messages.length;
          unsupportedMedia += page.messages.filter(
            (message) => message.mediaKind !== null,
          ).length;
          generatedQuestions += batch.questions?.length ?? 0;
        }
        job.committedThrough = page.latestMessageId;
        job.skippedMessages += page.skippedMessages;
        skippedMessages += page.skippedMessages;
        job.status = "complete";
        job.attempts = 0;
        job.lastErrorCode = null;
        await persist();
        return dialog;
      } catch (error) {
        job.status = "retry";
        job.attempts += 1;
        job.lastErrorCode = sanitizedErrorCode(error);
        await persist();
        throw error;
      }
    },
  );
  await reducerChain;
  await persistChain;

  const failedChats = results.filter(
    (result) => result.status === "rejected",
  ).length;
  const completedChats = results.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const pendingChats = Object.values(state.jobs).filter((job) =>
    ["ready", "running"].includes(job.status),
  ).length;
  return {
    completedChats,
    pendingChats,
    blockedChats: 0,
    failedChats,
    processedMessages,
    unsupportedMedia,
    skippedMessages,
    generatedQuestions,
  };
}
