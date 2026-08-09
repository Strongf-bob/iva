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
}

interface StreamObjectResultLike {
  object: PromiseLike<unknown>;
}

type StreamObjectImpl = (input: StreamObjectInput) => StreamObjectResultLike;

export interface AnalyzeStructuredDependencies {
  model?: LanguageModel;
  streamObjectImpl?: StreamObjectImpl;
}

const runStreamObject: StreamObjectImpl = (input) => streamObject(input);

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
  });

  return AnalysisBatchSchema.parse(await result.object);
}
