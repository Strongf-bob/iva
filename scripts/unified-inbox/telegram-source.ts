import type {
  TelegramAnalysisClient,
  TelegramAccount,
  TelegramMessagesPage,
} from "../contact-analysis/telegram-client.ts";
import type {
  TelegramDialog,
  TelegramMessage,
} from "../contact-analysis/types.ts";
import {
  CollectSourceInputSchema,
  InboxObservationSchema,
  ObservationPageSchema,
  canonicalObservationId,
  truncateCodePoints,
  type InboxObservation,
  type InboxParty,
  type InboxSource,
  type ObservationPage,
} from "./types.ts";

export interface TelegramInboxSourceOptions {
  client: TelegramAnalysisClient;
  env?: NodeJS.ProcessEnv;
}

function assertReadOnlyOwner(env: NodeJS.ProcessEnv): void {
  if (env.ASSISTANT_MULTI_USER === "1" && env.ASSISTANT_ROLE !== "owner") {
    throw new Error("unified_inbox_owner_only");
  }
  if (env.TELEGRAM_EXPOSED_TOOLS !== "read-only") {
    throw new Error("unified_inbox_telegram_requires_read_only");
  }
}

async function listDialogs(
  client: TelegramAnalysisClient,
): Promise<TelegramDialog[]> {
  const dialogs: TelegramDialog[] = [];
  let offset = 0;
  for (;;) {
    const page = await client.dialogs(offset, 100);
    dialogs.push(...page.dialogs);
    if (page.nextOffset === null) return dialogs;
    if (page.nextOffset <= offset) {
      throw new Error("unified_inbox_telegram_cursor_invalid");
    }
    offset = page.nextOffset;
  }
}

function party(id: number, label?: string): InboxParty {
  const canonical = `telegram:user:${id}`;
  return {
    id: canonical,
    label: truncateCodePoints(label?.trim() || canonical, 500),
  };
}

function messageParties(
  account: TelegramAccount,
  dialog: TelegramDialog,
  message: TelegramMessage,
): InboxParty[] {
  const parties = new Map<string, InboxParty>();
  parties.set(
    String(account.userId),
    party(account.userId, account.displayName),
  );
  if (message.senderId !== null) {
    parties.set(
      String(message.senderId),
      party(
        message.senderId,
        message.senderId === dialog.id ? dialog.title : undefined,
      ),
    );
  }
  for (const userId of message.mentionedUserIds) {
    parties.set(String(userId), party(userId));
  }
  return [...parties.values()];
}

function normalizeMessage(
  account: TelegramAccount,
  dialog: TelegramDialog,
  message: TelegramMessage,
): InboxObservation {
  const externalId = `${dialog.id}:${message.id}`;
  const identity = {
    source: "telegram" as const,
    sourceAccountId: String(account.userId),
    externalId,
  };
  const mediaFallback = message.mediaKind
    ? `[media: ${message.mediaKind}]`
    : "";
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: `${message.id}:${message.timestamp}`,
    kind: "message",
    occurredAt: message.timestamp,
    updatedAt: message.timestamp,
    title: truncateCodePoints(dialog.title, 500),
    excerpt: truncateCodePoints(message.text || mediaFallback, 4_000),
    actor:
      message.senderId === null
        ? undefined
        : party(
            message.senderId,
            message.senderId === dialog.id ? dialog.title : undefined,
          ),
    participants: messageParties(account, dialog, message),
    threadId: String(dialog.id),
    replyToExternalId:
      message.replyToMessageId === null
        ? undefined
        : `${dialog.id}:${message.replyToMessageId}`,
    evidence: {
      source: "telegram",
      externalId,
      timestamp: message.timestamp,
      locator: `Telegram chat ${dialog.id} message ${message.id}`,
    },
  });
}

function normalizePage(
  account: TelegramAccount,
  dialog: TelegramDialog,
  page: TelegramMessagesPage,
): ObservationPage {
  return ObservationPageSchema.parse({
    schemaVersion: 1,
    source: "telegram",
    sourceAccountId: String(account.userId),
    cursor: {
      key: `telegram:${dialog.id}`,
      value: String(page.nextAfterId),
      order: page.nextAfterId,
    },
    observations: page.messages.map((message) =>
      normalizeMessage(account, dialog, message),
    ),
  });
}

export function createTelegramInboxSource({
  client,
  env = process.env,
}: TelegramInboxSourceOptions): InboxSource {
  return {
    source: "telegram",
    async *collect(rawInput) {
      assertReadOnlyOwner(env);
      const input = CollectSourceInputSchema.parse(rawInput);
      const account = await client.account();
      if (
        env.ASSISTANT_USER_ID !== undefined &&
        env.ASSISTANT_USER_ID !== String(account.userId)
      ) {
        throw new Error("unified_inbox_owner_identity_mismatch");
      }
      const dialogs = await listDialogs(client);
      const readMessages = client.messages;
      if (!readMessages) {
        throw new Error("unified_inbox_telegram_messages_unavailable");
      }
      for (const dialog of dialogs.sort((left, right) => left.id - right.id)) {
        const cursorKey = `telegram:${dialog.id}`;
        let afterId = input.cursors[cursorKey]?.order ?? 0;
        for (;;) {
          const page = await readMessages(dialog.id, afterId, 200);
          if (page.messages.length === 0) {
            if (page.nextAfterId < afterId) {
              throw new Error("unified_inbox_telegram_cursor_invalid");
            }
            break;
          }
          if (page.nextAfterId <= afterId) {
            throw new Error("unified_inbox_telegram_cursor_invalid");
          }
          yield normalizePage(account, dialog, page);
          afterId = page.nextAfterId;
        }
      }
    },
  };
}
