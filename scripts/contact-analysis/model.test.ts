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
      generateObjectImpl: ((options: Record<string, unknown>) => {
        received = options;
        return Promise.resolve({ object: batch });
      }) as never,
    },
  );

  assert.deepEqual(result, batch);
  assert.equal(received?.model, model);
  assert.equal(received?.system, "PRIVATE CHAT SKILL");
  assert.equal(received?.maxOutputTokens, 16_384);
  assert.equal(received?.maxRetries, 0);
  assert.ok(received?.abortSignal instanceof AbortSignal);
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

test("structured analysis aborts a model call at its bounded deadline", async () => {
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
        timeoutMs: 5,
        generateObjectImpl: ((options: { abortSignal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener(
              "abort",
              () =>
                reject(
                  options.abortSignal.reason instanceof Error
                    ? options.abortSignal.reason
                    : new Error("model call aborted"),
                ),
              { once: true },
            );
          })) as never,
      },
    ),
    (error: unknown) =>
      error instanceof DOMException && error.name === "TimeoutError",
  );
});

test("structured analysis enforces the deadline when the provider ignores abort", async () => {
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
        timeoutMs: 5,
        generateObjectImpl: (() =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  object: {
                    schemaVersion: 1,
                    chatId: 44,
                    rollingSummary: "late result",
                    observations: [],
                  },
                }),
              40,
            ),
          )) as never,
      },
    ),
    (error: unknown) =>
      error instanceof DOMException && error.name === "TimeoutError",
  );
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
        generateObjectImpl: (() =>
          Promise.resolve({
            object: {
              schemaVersion: 1,
              chatId: 44,
              rollingSummary: "",
              observations: [{ predicate: "invented" }],
            },
          })) as never,
      },
    ),
  );
});
