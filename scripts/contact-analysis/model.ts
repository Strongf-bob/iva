import { streamObject, type LanguageModel } from "ai";

import { createTextModel } from "../../agent/provider.ts";
import {
  AnalysisBatchSchema,
  TelegramDialogSchema,
  TelegramMessageSchema,
  type AnalysisBatch,
  type TelegramDialog,
  type TelegramMessage,
} from "./types.ts";

export interface ModelAnalysisInput {
  skillText: string;
  ownerUserId: number;
  dialog: TelegramDialog;
  rollingSummary: string;
  messages: TelegramMessage[];
}

interface StreamObjectInput {
  model: LanguageModel;
  schema: typeof AnalysisBatchSchema;
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
  maxOutputTokens: number;
  maxRetries: number;
}

interface StreamObjectResultLike {
  object: PromiseLike<unknown>;
}

type StreamObjectImpl = (input: StreamObjectInput) => StreamObjectResultLike;

export interface AnalyzeStructuredDependencies {
  model?: LanguageModel;
  streamObjectImpl?: StreamObjectImpl;
  timeoutMs?: number;
}

const runStreamObject: StreamObjectImpl = (input) => streamObject(input);
const DEFAULT_MODEL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_TOKENS = 16_384;

export async function analyzeStructured(
  input: ModelAnalysisInput,
  dependencies: AnalyzeStructuredDependencies = {},
): Promise<AnalysisBatch> {
  const dialog = TelegramDialogSchema.parse(input.dialog);
  const messages = input.messages.map((message) =>
    TelegramMessageSchema.parse(message),
  );
  const model = dependencies.model ?? createTextModel();
  const run = dependencies.streamObjectImpl ?? runStreamObject;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15 * 60_000
  ) {
    throw new TypeError(
      "contact analysis model timeout must be an integer from 1 to 900000",
    );
  }
  const prompt = JSON.stringify({
    ownerUserId: input.ownerUserId,
    dialog,
    rollingSummary: input.rollingSummary,
    messages,
  });

  const result = run({
    model,
    schema: AnalysisBatchSchema,
    system: input.skillText,
    prompt,
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
  });

  return AnalysisBatchSchema.parse(await result.object);
}
