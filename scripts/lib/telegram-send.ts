// Единая сетевая отправка форматированного сообщения в Telegram. Используется обоими
// cron-скриптами (rollup, daily-digest), чтобы конвертация + self-heal жили в одном месте.
//
// Контракт sendTelegramHtml:
//   • model-markdown → валидный Telegram-HTML через общий конвертер, режется на чанки ≤4096;
//   • каждый чанк шлётся с parse_mode=HTML;
//   • если Telegram вернул 400 (не распарсил сущности) — ОДНА повторная попытка тем же
//     чанком, но без тегов и без parse_mode (так 400 по сущностям невозможен), fellBack=true;
//   • НИКОГДА не бросает — на любую ошибку возвращает { ok:false, error }.
// Возвращает { ok, fellBack, error } — вызывающий cron-скрипт по fellBack даёт агенту
// обратную связь в ту же сессию, чтобы он переформатировал следующий отчёт.
// htmlToPlain (HTML→plain с декодом сущностей) живёт в общем модуле — тот же
// фолбэк-декодер использует и Telegram-канал (agent/channels/telegram.ts).
import { toTelegramHtmlChunks, htmlToPlain } from "./telegram-format.ts";
import { scanOutbound } from "./security-gate.ts";

type TelegramRequest = Record<string, unknown>;

type TelegramResponse = {
  ok: boolean;
  status: number;
  text: string;
  messageId: number | null;
};

async function post(
  bot: string,
  body: TelegramRequest,
): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let messageId: number | null = null;
  if (res.ok && text) {
    try {
      const parsed: unknown = JSON.parse(text);
      const id = (parsed as { result?: { message_id?: unknown } } | null)
        ?.result?.message_id;
      if (typeof id === "number" && Number.isSafeInteger(id)) messageId = id;
    } catch {
      // Existing callers only need the HTTP success bit. Receipt-requiring callers
      // classify a missing message id as ambiguous below.
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    text: res.ok ? "" : text,
    messageId,
  };
}

type InlineKeyboardMarkup = {
  readonly inline_keyboard: readonly (readonly {
    readonly text: string;
    readonly callback_data: string;
  }[])[];
};

type TelegramSendResult = {
  readonly ok: boolean;
  readonly fellBack: boolean;
  readonly error: string;
  readonly receipt: string;
  readonly failureKind?: "retryable" | "ambiguous" | "terminal";
};

function failureKind(status: number): "retryable" | "terminal" {
  return status >= 500 || status === 408 || status === 425 || status === 429
    ? "retryable"
    : "terminal";
}

async function sendTelegramHtmlInternal(
  bot: string,
  chat: string,
  md: unknown,
  {
    caption = false,
    replyMarkup,
    requireReceipt = false,
  }: {
    readonly caption?: boolean;
    readonly replyMarkup?: InlineKeyboardMarkup;
    readonly requireReceipt?: boolean;
  } = {},
): Promise<TelegramSendResult> {
  let fellBack = false;
  const messageIds: number[] = [];
  const guard = scanOutbound(md as string);
  if (!guard.clean) {
    console.error(
      "[security] outbound report leak redacted:",
      guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
    );
  }
  const chunks = toTelegramHtmlChunks(guard.text, caption ? 1024 : 4096);
  try {
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      const r = await post(bot, {
        chat_id: chat,
        text: chunk,
        parse_mode: "HTML",
        ...(last && replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      if (r.ok) {
        if (r.messageId !== null) messageIds.push(r.messageId);
        continue;
      }
      if (r.status === 400) {
        fellBack = true;
        const plain = await post(bot, {
          chat_id: chat,
          text: htmlToPlain(chunk),
          ...(last && replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (plain.ok) {
          if (plain.messageId !== null) messageIds.push(plain.messageId);
          continue;
        }
        return {
          ok: false,
          fellBack,
          error: `plain retry ${plain.status}: ${plain.text}`,
          receipt: "",
          failureKind:
            messageIds.length > 0 ? "ambiguous" : failureKind(plain.status),
        };
      }
      return {
        ok: false,
        fellBack,
        error: `${r.status}: ${r.text}`,
        receipt: "",
        failureKind:
          messageIds.length > 0 ? "ambiguous" : failureKind(r.status),
      };
    }
    if (requireReceipt && messageIds.length !== chunks.length) {
      return {
        ok: false,
        fellBack,
        error: "Telegram accepted a message without a delivery receipt",
        receipt: "",
        failureKind: "ambiguous",
      };
    }
    return {
      ok: true,
      fellBack,
      error: "",
      receipt: messageIds.length ? `telegram:${messageIds.join(",")}` : "",
    };
  } catch {
    return {
      ok: false,
      fellBack,
      error: "Telegram transport failed",
      receipt: "",
      failureKind: "ambiguous",
    };
  }
}

export async function sendTelegramHtml(
  bot: string,
  chat: string,
  md: unknown,
  { caption = false }: { caption?: boolean } = {},
): Promise<{ ok: boolean; fellBack: boolean; error: string }> {
  const result = await sendTelegramHtmlInternal(bot, chat, md, { caption });
  return {
    ok: result.ok,
    fellBack: result.fellBack,
    error: result.error,
  };
}

export function sendTelegramHtmlWithReceipt(
  bot: string,
  chat: string,
  md: unknown,
  options: {
    readonly replyMarkup?: InlineKeyboardMarkup;
  } = {},
): Promise<TelegramSendResult> {
  return sendTelegramHtmlInternal(bot, chat, md, {
    ...options,
    requireReceipt: true,
  });
}
