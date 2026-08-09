import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

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

interface GenerateObjectInput {
  model: LanguageModel;
  schema: typeof AnalysisBatchSchema;
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
  maxOutputTokens: number;
  maxRetries: number;
}

interface GenerateObjectResultLike {
  object: unknown;
}

type GenerateObjectImpl = (
  input: GenerateObjectInput,
) => PromiseLike<GenerateObjectResultLike>;

export interface AnalyzeStructuredDependencies {
  model?: LanguageModel;
  generateObjectImpl?: GenerateObjectImpl;
  timeoutMs?: number;
}

const runGenerateObject: GenerateObjectImpl = (input) => generateObject(input);
const DEFAULT_MODEL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_TOKENS = 16_384;
const ANALYSIS_BATCH_JSON_SCHEMA = z.toJSONSchema(AnalysisBatchSchema);
const ANALYSIS_BATCH_RESPONSE_RULES = [
  "Every observation must contain exactly one of value or objectId, never both and never neither.",
  "An external_owner_claim observation must contain assertedById.",
  "Relationship metadata is required for commitment observations and forbidden for every other predicate.",
  "A birthday observation must use value YYYY-MM-DD or --MM-DD and confidence EXTRACTED.",
] as const;

export async function analyzeStructured(
  input: ModelAnalysisInput,
  dependencies: AnalyzeStructuredDependencies = {},
): Promise<AnalysisBatch> {
  const dialog = TelegramDialogSchema.parse(input.dialog);
  const messages = input.messages.map((message) =>
    TelegramMessageSchema.parse(message),
  );
  const model = dependencies.model ?? createTextModel();
  const run = dependencies.generateObjectImpl ?? runGenerateObject;
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
    responseSchema: ANALYSIS_BATCH_JSON_SCHEMA,
    responseRules: ANALYSIS_BATCH_RESPONSE_RULES,
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
    const result = await new Promise<GenerateObjectResultLike>(
      (resolve, reject) => {
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
        Promise.resolve(
          run({
            model,
            schema: AnalysisBatchSchema,
            system: input.skillText,
            prompt,
            abortSignal: controller.signal,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            maxRetries: 0,
          }),
        ).then(
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
      },
    );
    return AnalysisBatchSchema.parse(result.object);
  } finally {
    clearTimeout(deadline);
  }
}
