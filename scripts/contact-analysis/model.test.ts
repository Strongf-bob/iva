/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations and provider fakes intentionally narrow generic SDK types. */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";

import { analyzeStructured } from "./model.ts";

const model = { modelId: "fake-model" } as unknown as LanguageModel;

test("structured analysis passes the exact skill and bounded chat context", async () => {
  let received: Record<string, unknown> | undefined;
  const batch = {
    schemaVersion: 1 as const,
    chatId: 44,
    rollingSummary: "Alex usually answers briefly.",
    observations: [],
  };

  const result = await analyzeStructured(
    {
      skillText: "PRIVATE CHAT SKILL",
      ownerUserId: 7,
      dialog: {
        id: 44,
        kind: "private",
        title: "Alex",
        username: "alex",
      },
      rollingSummary: "Earlier summary",
      messages: [
        {
          id: 9,
          senderId: 44,
          timestamp: "2026-08-07T00:00:00Z",
          text: "hello",
          replyToMessageId: null,
          mentionedUserIds: [],
          mentionedUsernames: [],
          mediaKind: null,
        },
      ],
    },
    {
      model,
      streamObjectImpl: ((options: Record<string, unknown>) => {
        received = options;
        return { object: Promise.resolve(batch) };
      }) as never,
    },
  );

  assert.deepEqual(result, batch);
  assert.equal(received?.model, model);
  assert.equal(received?.system, "PRIVATE CHAT SKILL");
  assert.deepEqual(JSON.parse(String(received?.prompt)), {
    ownerUserId: 7,
    dialog: {
      id: 44,
      kind: "private",
      title: "Alex",
      username: "alex",
    },
    rollingSummary: "Earlier summary",
    messages: [
      {
        id: 9,
        senderId: 44,
        timestamp: "2026-08-07T00:00:00Z",
        text: "hello",
        replyToMessageId: null,
        mentionedUserIds: [],
        mentionedUsernames: [],
        mediaKind: null,
      },
    ],
  });
});

test("structured analysis validates provider output again", async () => {
  await assert.rejects(
    analyzeStructured(
      {
        skillText: "PRIVATE CHAT SKILL",
        ownerUserId: 7,
        dialog: {
          id: 44,
          kind: "private",
          title: "Alex",
          username: null,
        },
        rollingSummary: "",
        messages: [],
      },
      {
        model,
        streamObjectImpl: (() => ({
          object: Promise.resolve({
            schemaVersion: 1,
            chatId: 44,
            rollingSummary: "",
            observations: [{ predicate: "invented" }],
          }),
        })) as never,
      },
    ),
  );
});
