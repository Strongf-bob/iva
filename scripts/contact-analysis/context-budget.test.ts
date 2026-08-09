/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";

import { messageCharacterBudget } from "./context-budget.ts";

test("context budget reserves output and prompt space then rounds down", () => {
  assert.equal(
    messageCharacterBudget({
      contextTokens: 131_072,
      skillChars: 4_000,
      envelopeChars: 2_000,
    }),
    270_000,
  );
});

test("context budget rejects unsafe inputs and clamps the sidecar limit", () => {
  assert.throws(
    () =>
      messageCharacterBudget({
        contextTokens: 20_480,
        skillChars: 100_000,
        envelopeChars: 100_000,
      }),
    /context budget leaves no room/u,
  );
  assert.equal(
    messageCharacterBudget({
      contextTokens: 1_000_000,
      skillChars: 1,
      envelopeChars: 1,
    }),
    500_000,
  );
});

test("context budget enforces the exact minimum rounded message window", () => {
  assert.throws(
    () =>
      messageCharacterBudget({
        contextTokens: 40_197,
        skillChars: 0,
        envelopeChars: 0,
      }),
    /context budget leaves no room/u,
  );
  assert.equal(
    messageCharacterBudget({
      contextTokens: 40_198,
      skillChars: 0,
      envelopeChars: 0,
    }),
    10_000,
  );
});
