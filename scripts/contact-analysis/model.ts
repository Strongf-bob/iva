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

  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "Contact analysis model call exceeded its deadline",
          "TimeoutError",
        ),
      ),
    timeoutMs,
  );
  try {
    const result = run({
      model,
      schema: AnalysisBatchSchema,
      system: input.skillText,
      prompt,
      abortSignal: controller.signal,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
    });
    const object = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("Contact analysis model call aborted"),
        );
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(result.object).then(
        (value) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(
            error instanceof Error
              ? error
              : new Error("Contact analysis model call failed"),
          );
        },
      );
    });
    return AnalysisBatchSchema.parse(object);
  } finally {
    clearTimeout(deadline);
  }
}
