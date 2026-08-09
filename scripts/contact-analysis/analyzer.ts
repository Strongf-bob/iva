import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { analyzeStructured, type ModelAnalysisInput } from "./model.ts";
import {
  AnalysisBatchSchema,
  AnalysisPageSchema,
  type AnalysisBatch,
  type AnalysisPage,
  type ChatKind,
  type TelegramDialog,
  type TelegramMessage,
} from "./types.ts";

const SKILL_BY_KIND: Record<ChatKind, string> = {
  private: "telegram-person-profile",
  bot: "telegram-person-profile",
  group: "telegram-group-profile",
  channel: "telegram-channel-profile",
};

export function skillPathFor(kind: ChatKind): string {
  return fileURLToPath(
    new URL(
      `../../agent/skills/${SKILL_BY_KIND[kind]}/SKILL.md`,
      import.meta.url,
    ),
  );
}

export function chunkMessages(
  messages: readonly TelegramMessage[],
  maxChars = 60_000,
): TelegramMessage[][] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TypeError("maxChars must be a safe positive integer");
  }
  const chunks: TelegramMessage[][] = [];
  let current: TelegramMessage[] = [];
  let currentChars = 0;

  for (const message of messages) {
    const messageChars = JSON.stringify(message).length;
    if (current.length > 0 && currentChars + messageChars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(message);
    currentChars += messageChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function validateEvidence(
  rawBatch: AnalysisBatch,
  allowedMessages: readonly TelegramMessage[],
  allowedSubjects: ReadonlySet<string>,
): AnalysisBatch {
  const batch = AnalysisBatchSchema.parse(rawBatch);
  const messagesById = new Map(
    allowedMessages.map((message) => [message.id, message]),
  );

  for (const observation of batch.observations) {
    for (const [label, identifier] of [
      ["subject", observation.subjectId],
      ["object", observation.objectId],
      ["assertedBy", observation.assertedById],
    ] as const) {
      if (identifier !== undefined && !allowedSubjects.has(identifier)) {
        throw new Error(`${label} ${identifier} was not allowed`);
      }
    }
    if (observation.contextChatId !== batch.chatId) {
      throw new Error(
        `context chat ${observation.contextChatId} did not match batch chat ${batch.chatId}`,
      );
    }
    for (const evidence of observation.evidence) {
      const message = messagesById.get(evidence.messageId);
      if (message === undefined) {
        throw new Error(
          `evidence message ${evidence.messageId} was not present in the input page`,
        );
      }
      if (evidence.chatId !== batch.chatId) {
        throw new Error(
          `evidence chat ${evidence.chatId} did not match batch chat ${batch.chatId}`,
        );
      }
      if (evidence.timestamp !== message.timestamp) {
        throw new Error(
          `evidence timestamp for message ${evidence.messageId} did not match the input`,
        );
      }
    }
  }
  for (const question of batch.questions ?? []) {
    if (!allowedSubjects.has(question.subjectId)) {
      throw new Error(`question subject ${question.subjectId} was not allowed`);
    }
    if (question.contextChatId !== batch.chatId) {
      throw new Error(
        `question context chat ${question.contextChatId} did not match batch chat ${batch.chatId}`,
      );
    }
    for (const evidence of question.evidence) {
      const message = messagesById.get(evidence.messageId);
      if (message === undefined) {
        throw new Error(
          `question evidence message ${evidence.messageId} was not present in the input page`,
        );
      }
      if (evidence.chatId !== batch.chatId) {
        throw new Error(
          `question evidence chat ${evidence.chatId} did not match batch chat ${batch.chatId}`,
        );
      }
      if (evidence.timestamp !== message.timestamp) {
        throw new Error(
          `question evidence timestamp for message ${evidence.messageId} did not match the input`,
        );
      }
    }
  }
  return batch;
}

export interface AnalyzePageInput {
  ownerUserId: number;
  dialog: TelegramDialog;
  rollingSummary: string;
  messages: TelegramMessage[];
  allowedSubjects: ReadonlySet<string>;
  skillText?: string;
  maxChars?: number;
}

export interface AnalyzePageDependencies {
  readSkillText?: (path: string) => Promise<string>;
  analyzeStructuredImpl?: (input: ModelAnalysisInput) => Promise<AnalysisBatch>;
}

export async function analyzePage(
  input: AnalyzePageInput,
  dependencies: AnalyzePageDependencies = {},
): Promise<AnalysisPage> {
  const readSkillText =
    dependencies.readSkillText ?? ((path) => readFile(path, "utf8"));
  const run = dependencies.analyzeStructuredImpl ?? analyzeStructured;
  const skillText =
    input.skillText ?? (await readSkillText(skillPathFor(input.dialog.kind)));
  const batch = await run({
    skillText,
    ownerUserId: input.ownerUserId,
    dialog: input.dialog,
    rollingSummary: input.rollingSummary,
    messages: input.messages,
  });
  if (batch.chatId !== input.dialog.id) {
    throw new Error(
      `analysis batch chat ${batch.chatId} did not match dialog ${input.dialog.id}`,
    );
  }
  const validated = validateEvidence(
    batch,
    input.messages,
    input.allowedSubjects,
  );

  return AnalysisPageSchema.parse({
    schemaVersion: 1,
    chatId: input.dialog.id,
    rollingSummary: validated.rollingSummary,
    observations: validated.observations,
    questions: validated.questions ?? [],
  });
}
