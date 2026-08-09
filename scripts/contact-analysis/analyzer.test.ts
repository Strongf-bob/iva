/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; injected async boundaries intentionally use synchronous fakes. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzePage,
  chunkMessages,
  skillPathFor,
  validateEvidence,
} from "./analyzer.ts";
import type { AnalysisBatch, ChatKind, TelegramMessage } from "./types.ts";

function message(id: number, text = `message ${id}`): TelegramMessage {
  return {
    id,
    senderId: 44,
    timestamp: `2026-08-07T00:00:${String(id).padStart(2, "0")}Z`,
    text,
    replyToMessageId: null,
    mentionedUserIds: [],
    mentionedUsernames: [],
    mediaKind: null,
  };
}

function batchWithMessage(
  messageId: number,
  subjectId = "telegram:user:44",
): AnalysisBatch {
  return {
    schemaVersion: 1,
    chatId: -1001,
    rollingSummary: "summary",
    observations: [
      {
        schemaVersion: 1,
        subjectId,
        kind: "fact",
        predicate: "role",
        value: "developer",
        confidence: "EXTRACTED",
        contextChatId: -1001,
        evidence: [
          {
            chatId: -1001,
            messageId,
            timestamp: `2026-08-07T00:00:${String(messageId).padStart(2, "0")}Z`,
          },
        ],
      },
    ],
  };
}

test("chat kinds route to three separate skills", () => {
  const expected: Record<ChatKind, string> = {
    private: "telegram-person-profile/SKILL.md",
    bot: "telegram-person-profile/SKILL.md",
    group: "telegram-group-profile/SKILL.md",
    channel: "telegram-channel-profile/SKILL.md",
  };

  for (const [kind, suffix] of Object.entries(expected)) {
    assert.match(skillPathFor(kind as ChatKind), new RegExp(`${suffix}$`, "u"));
  }
});

test("message chunking never samples, splits, or omits a message", () => {
  const messages = [message(1), message(2), message(3), message(4)];
  const oneMessageSize = JSON.stringify(messages[0]).length;
  const chunks = chunkMessages(messages, oneMessageSize * 2 + 1);

  assert.deepEqual(
    chunks.flat().map((item) => item.id),
    messages.map((item) => item.id),
  );
  assert.ok(chunks.every((chunk) => chunk.length > 0));

  const oversize = message(5, "x".repeat(100));
  assert.deepEqual(chunkMessages([oversize], 10), [[oversize]]);
});

test("evidence must come from the current page and match provenance", () => {
  const messages = [message(9)];
  const subjects = new Set(["telegram:user:44", "telegram:chat:-1001"]);

  assert.deepEqual(
    validateEvidence(batchWithMessage(9), messages, subjects),
    batchWithMessage(9),
  );
  assert.throws(
    () => validateEvidence(batchWithMessage(8), messages, subjects),
    /evidence message 8 was not present/u,
  );
  assert.throws(
    () =>
      validateEvidence(
        batchWithMessage(9, "telegram:user:999"),
        messages,
        subjects,
      ),
    /subject telegram:user:999 was not allowed/u,
  );
});

test("analyzePage invokes one skill per chronological chunk", async () => {
  const messages = [message(1), message(2)];
  const calls: Array<{ skillText: string; ids: number[]; summary: string }> =
    [];

  const result = await analyzePage(
    {
      ownerUserId: 7,
      dialog: {
        id: 44,
        kind: "private",
        title: "Alex",
        username: "alex",
      },
      rollingSummary: "before",
      messages,
      allowedSubjects: new Set(["telegram:user:44"]),
      maxChars: JSON.stringify(messages[0]).length,
    },
    {
      readSkillText: async () => "PERSON SKILL",
      analyzeStructuredImpl: async (input) => {
        calls.push({
          skillText: input.skillText,
          ids: input.messages.map((item) => item.id),
          summary: input.rollingSummary,
        });
        return {
          schemaVersion: 1,
          chatId: 44,
          rollingSummary: `through ${input.messages.at(-1)?.id}`,
          observations: [],
        };
      },
    },
  );

  assert.deepEqual(calls, [
    { skillText: "PERSON SKILL", ids: [1], summary: "before" },
    { skillText: "PERSON SKILL", ids: [2], summary: "through 1" },
  ]);
  assert.equal(result.rollingSummary, "through 2");
});

test("a multi-chunk page keeps more than one model-call worth of observations", async () => {
  const messages = [message(1), message(2)];
  const result = await analyzePage(
    {
      ownerUserId: 7,
      dialog: {
        id: 44,
        kind: "private",
        title: "Alex",
        username: "alex",
      },
      rollingSummary: "",
      messages,
      allowedSubjects: new Set(["telegram:user:44"]),
      maxChars: JSON.stringify(messages[0]).length,
    },
    {
      readSkillText: async () => "PERSON SKILL",
      analyzeStructuredImpl: async (input) => ({
        schemaVersion: 1,
        chatId: 44,
        rollingSummary: `through ${input.messages[0].id}`,
        observations: Array.from({ length: 20 }, (_, index) => ({
          schemaVersion: 1,
          subjectId: "telegram:user:44",
          kind: "fact" as const,
          predicate: "preference" as const,
          value: `preference ${input.messages[0].id}-${index}`,
          confidence: "EXTRACTED" as const,
          contextChatId: 44,
          evidence: [
            {
              chatId: 44,
              messageId: input.messages[0].id,
              timestamp: input.messages[0].timestamp,
            },
          ],
        })),
      }),
    },
  );

  assert.equal(result.observations.length, 40);
});

for (const skill of [
  "telegram-person-profile",
  "telegram-group-profile",
  "telegram-channel-profile",
]) {
  test(`${skill} declares the shared safety and evidence contract`, async () => {
    const text = await readFile(
      new URL(`../../agent/skills/${skill}/SKILL.md`, import.meta.url),
      "utf8",
    );
    assert.match(text, /untrusted data/iu);
    assert.match(text, /AnalysisBatchSchema/u);
    assert.match(text, /contextChatId/u);
    assert.match(text, /mediaKind/u);
    assert.match(text, /sensitive traits/iu);
    assert.match(text, /diagnos/iu);
  });
}
