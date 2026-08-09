/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns test registration; injected async fakes intentionally resolve synchronously. */
import assert from "node:assert/strict";
import test from "node:test";

import type { TelegramAnalysisClient } from "../contact-analysis/telegram-client.ts";
import { createTelegramInboxSource } from "./telegram-source.ts";
import type {
  CollectSourceInput,
  InboxSource,
  ObservationPage,
} from "./types.ts";

const now = "2026-08-09T08:00:00.000Z";

async function collect(
  source: InboxSource,
  cursors: CollectSourceInput["cursors"] = {},
): Promise<ObservationPage[]> {
  const pages: ObservationPage[] = [];
  for await (const page of source.collect({ cursors, now })) pages.push(page);
  return pages;
}

function telegramClient(
  calls: string[],
  accountUserId = 7,
): TelegramAnalysisClient {
  return {
    async account() {
      calls.push("account");
      return { userId: accountUserId, displayName: "Owner", username: "owner" };
    },
    async dialogs(offset, limit) {
      calls.push(`dialogs:${offset}:${limit}`);
      return offset === 0
        ? {
            dialogs: [
              { id: 11, kind: "private", title: "Alice", username: "alice" },
            ],
            nextOffset: null,
          }
        : { dialogs: [], nextOffset: null };
    },
    async messages(chatId, afterId, limit) {
      calls.push(`messages:${chatId}:${afterId}:${limit}`);
      if (afterId >= 41) return { messages: [], nextAfterId: afterId };
      return {
        messages: [
          {
            id: 41,
            senderId: 11,
            timestamp: "2026-08-09T07:55:00.000Z",
            text: "Can you review the plan today?",
            replyToMessageId: 40,
            mentionedUserIds: [7],
            mentionedUsernames: ["owner"],
            mediaKind: null,
          },
        ],
        nextAfterId: 41,
      };
    },
    async messageWindow() {
      throw new Error("messageWindow is not used by unified inbox");
    },
  };
}

test("missing paged Telegram reader fails closed", async () => {
  const calls: string[] = [];
  const client = telegramClient(calls);
  delete client.messages;
  const source = createTelegramInboxSource({
    env: { TELEGRAM_EXPOSED_TOOLS: "read-only", ASSISTANT_USER_ID: "7" },
    client,
  });

  await assert.rejects(
    () => collect(source),
    /unified_inbox_telegram_messages_unavailable/u,
  );
  assert.deepEqual(calls, ["account", "dialogs:0:100"]);
});

test("multi-user non-owner fails before contacting Telegram", async () => {
  const calls: string[] = [];
  const source = createTelegramInboxSource({
    env: {
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "member",
      ASSISTANT_USER_ID: "8",
      TELEGRAM_EXPOSED_TOOLS: "read-only",
    },
    client: telegramClient(calls),
  });

  await assert.rejects(() => collect(source), /unified_inbox_owner_only/u);
  assert.deepEqual(calls, []);
});

test("Telegram source requires the exact read-only exposure before proxy access", async () => {
  for (const exposed of [undefined, "all", "read_only", "write"]) {
    const calls: string[] = [];
    const source = createTelegramInboxSource({
      env: exposed === undefined ? {} : { TELEGRAM_EXPOSED_TOOLS: exposed },
      client: telegramClient(calls),
    });
    await assert.rejects(
      () => collect(source),
      /unified_inbox_telegram_requires_read_only/u,
    );
    assert.deepEqual(calls, []);
  }
});

test("Telegram pages use persisted per-chat afterId and exact evidence", async () => {
  const calls: string[] = [];
  const source = createTelegramInboxSource({
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_USER_ID: "7",
    },
    client: telegramClient(calls),
  });

  const pages = await collect(source, {
    "telegram:11": { key: "telegram:11", value: "40", order: 40 },
  });

  assert.deepEqual(calls, [
    "account",
    "dialogs:0:100",
    "messages:11:40:200",
    "messages:11:41:200",
  ]);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]?.cursor, {
    key: "telegram:11",
    value: "41",
    order: 41,
  });
  assert.equal(pages[0]?.sourceAccountId, "7");
  assert.equal(pages[0]?.observations[0]?.externalId, "11:41");
  assert.equal(pages[0]?.observations[0]?.replyToExternalId, "11:40");
  assert.deepEqual(pages[0]?.observations[0]?.evidence, {
    source: "telegram",
    externalId: "11:41",
    timestamp: "2026-08-09T07:55:00.000Z",
    locator: "Telegram chat 11 message 41",
  });
});

test("owner identity mismatch and non-advancing Telegram cursors fail closed", async () => {
  const mismatch = createTelegramInboxSource({
    env: {
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      ASSISTANT_USER_ID: "8",
    },
    client: telegramClient([]),
  });
  await assert.rejects(
    () => collect(mismatch),
    /unified_inbox_owner_identity_mismatch/u,
  );

  const client = telegramClient([]);
  client.messages = async () => ({
    messages: [
      {
        id: 41,
        senderId: 11,
        timestamp: "2026-08-09T07:55:00.000Z",
        text: "message",
        replyToMessageId: null,
        mentionedUserIds: [],
        mentionedUsernames: [],
        mediaKind: null,
      },
    ],
    nextAfterId: 40,
  });
  const invalidCursor = createTelegramInboxSource({
    env: { TELEGRAM_EXPOSED_TOOLS: "read-only", ASSISTANT_USER_ID: "7" },
    client,
  });
  await assert.rejects(
    () =>
      collect(invalidCursor, {
        "telegram:11": { key: "telegram:11", value: "40", order: 40 },
      }),
    /unified_inbox_telegram_cursor_invalid/u,
  );
});
