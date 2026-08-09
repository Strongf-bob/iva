export interface MessageCharacterBudgetInput {
  contextTokens: number;
  skillChars: number;
  envelopeChars: number;
}

const OUTPUT_RESERVE_TOKENS = 16_384;
const SAFETY_RESERVE_TOKENS = 4_096;
const CONSERVATIVE_CHARS_PER_TOKEN = 3;
const BUDGET_ROUNDING_CHARS = 10_000;
const MAX_SIDECAR_WINDOW_CHARS = 500_000;

function safeNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a safe nonnegative integer`);
  }
  return value;
}

export function messageCharacterBudget({
  contextTokens,
  skillChars,
  envelopeChars,
}: MessageCharacterBudgetInput): number {
  safeNonnegativeInteger(contextTokens, "contextTokens");
  safeNonnegativeInteger(skillChars, "skillChars");
  safeNonnegativeInteger(envelopeChars, "envelopeChars");
  const available =
    (contextTokens - OUTPUT_RESERVE_TOKENS - SAFETY_RESERVE_TOKENS) *
      CONSERVATIVE_CHARS_PER_TOKEN -
    skillChars -
    envelopeChars;
  const rounded =
    Math.floor(available / BUDGET_ROUNDING_CHARS) * BUDGET_ROUNDING_CHARS;
  if (rounded < 1)
    throw new Error("context budget leaves no room for messages");
  return Math.min(rounded, MAX_SIDECAR_WINDOW_CHARS);
}
