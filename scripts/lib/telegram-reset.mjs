import { telegramContinuationToken } from "eve/channels/telegram";

/**
 * Returns the exact channel-local token Eve assigned to this chat/topic.
 * New installs persist it from the Telegram event context. The private-chat
 * fallback makes upgrades from pre-0.27 Eve work before the first new turn.
 */
export function continuationTokenForControl(update, status) {
  if (typeof status?.continuationToken === "string" && status.continuationToken.length > 0) {
    return status.continuationToken;
  }

  const message = update?.message ?? update?.callback_query?.message;
  const chatId = message?.chat?.id;
  if (chatId === undefined) return null;
  const messageThreadId = message?.message_thread_id;

  if (message.chat?.type === "private") {
    return telegramContinuationToken({ chatId, messageThreadId });
  }

  // Upgrade fallback for a group command sent as a reply to Iva's last message.
  // A standalone group command cannot reconstruct the old conversation anchor.
  const reply = message.reply_to_message;
  if (reply?.from?.is_bot === true && reply.message_id !== undefined) {
    return telegramContinuationToken({
      chatId,
      messageThreadId,
      conversationId: reply.message_id,
    });
  }
  return null;
}

/**
 * Calls Iva's Telegram-owned reset route. Both statuses are idempotent success:
 * a replayed Telegram update sees no active owner after the first reset.
 */
export async function requestTelegramReset({
  url,
  secret,
  continuationToken,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify({ continuationToken }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Eve reset route returned HTTP ${response.status}`);

  const body = await response.json();
  if (
    body?.ok !== true ||
    (body.status !== "reset" && body.status !== "no_active_session")
  ) {
    throw new Error("Eve reset route returned an invalid response");
  }
  return body;
}
