export type TelegramRichResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type TelegramRichDeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "rejected"; status: number; body: unknown }
  | { kind: "ambiguous"; error: unknown };

/**
 * Classify a single rich-message attempt without retrying an ambiguous write.
 * A transport error can arrive after Telegram accepted the message, so callers
 * may fall back only after a definitive API rejection.
 */
export async function attemptTelegramRichDelivery(
  request: () => Promise<TelegramRichResponse>,
): Promise<TelegramRichDeliveryOutcome> {
  try {
    const response = await request();
    return response.ok
      ? { kind: "delivered" }
      : {
          kind: "rejected",
          status: response.status,
          body: response.body,
        };
  } catch (error) {
    return { kind: "ambiguous", error };
  }
}

type TelegramReplyHandle = Pick<
  TelegramHandle,
  "chatId" | "messageThreadId" | "request" | "post"
>;

export async function deliverTelegramCompletedMessage(
  message: string,
  telegram: TelegramReplyHandle,
  recordDelivery: (delivered: boolean) => void,
): Promise<void> {
  const guard = scanOutbound(message);
  if (!guard.clean) {
    console.error(
      "[security] outbound leak redacted:",
      guard.findings
        .map((finding) => `${finding.type}:${finding.name}`)
        .join(", "),
    );
  }

  if (needsRichMessage(guard.text)) {
    const outcome = await attemptTelegramRichDelivery(() =>
      telegram.request("sendRichMessage", {
        chat_id: telegram.chatId,
        rich_message: { markdown: guard.text },
        ...(telegram.messageThreadId !== undefined
          ? { message_thread_id: telegram.messageThreadId }
          : {}),
      }),
    );
    if (outcome.kind === "delivered") {
      recordDelivery(true);
      return;
    }
    if (outcome.kind === "rejected") {
      console.error(
        "[telegram] sendRichMessage отвергнут, фолбэк HTML:",
        outcome.status,
        JSON.stringify(outcome.body).slice(0, 300),
      );
    } else {
      console.error(
        "[telegram] результат sendRichMessage неоднозначен; не дублирую ответ:",
        outcome.error,
      );
      recordDelivery(false);
      return;
    }
  }

  let attemptedDelivery = false;
  let allChunksDelivered = true;
  for (const html of toTelegramHtmlChunks(guard.text, 4096)) {
    if (!html) continue;
    attemptedDelivery = true;
    let chunkDelivered = false;
    try {
      await telegram.post({
        text: html,
        parse_mode: "HTML",
      } as TelegramMessageBody & { parse_mode: "HTML" });
      chunkDelivered = true;
    } catch (error) {
      console.error(
        "[telegram] HTML отвергнут, шлю plain:",
        error,
        "| HTML:",
        html.slice(0, 300),
      );
      try {
        await telegram.post(htmlToPlain(html));
        chunkDelivered = true;
      } catch (plainError) {
        console.error("[telegram] plain-фолбэк тоже упал:", plainError);
      }
    }
    if (!chunkDelivered) allChunksDelivered = false;
  }
  if (attemptedDelivery && allChunksDelivered) recordDelivery(true);
}
import type {
  TelegramHandle,
  TelegramMessageBody,
} from "eve/channels/telegram";
import {
  htmlToPlain,
  needsRichMessage,
  toTelegramHtmlChunks,
} from "../../scripts/lib/telegram-format.ts";
import { scanOutbound } from "./security-gate.js";
