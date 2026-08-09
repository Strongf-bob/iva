import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import {
  TelegramDialogSchema,
  TelegramMessageSchema,
  type TelegramDialog,
  type TelegramMessage,
} from "./types.ts";

const AccountSchema = z.strictObject({
  userId: z.int().positive(),
  displayName: z.string().min(1).max(500),
  username: z.string().min(1).max(64).nullable(),
});
const DialogsPageSchema = z.strictObject({
  dialogs: z.array(TelegramDialogSchema).max(100),
  nextOffset: z.int().nonnegative().nullable(),
});
const MessagesPageSchema = z.strictObject({
  messages: z.array(TelegramMessageSchema).max(200),
  nextAfterId: z.int().nonnegative(),
});
const FailureMetadataSchema = z.object({
  retryAfterSeconds: z.int().positive().max(86_400).optional(),
});

export class TelegramAnalysisError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(code: string, retryAfterSeconds?: number) {
    super(code);
    this.name = "TelegramAnalysisError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type TelegramAccount = z.infer<typeof AccountSchema>;
export interface TelegramDialogsPage {
  dialogs: TelegramDialog[];
  nextOffset: number | null;
}
export interface TelegramMessagesPage {
  messages: TelegramMessage[];
  nextAfterId: number;
}

export interface TelegramAnalysisClient {
  account(): Promise<TelegramAccount>;
  dialogs(offset: number, limit: number): Promise<TelegramDialogsPage>;
  messages(
    chatId: number,
    afterId: number,
    limit: number,
  ): Promise<TelegramMessagesPage>;
}

export interface TelegramAnalysisClientOptions {
  root?: string;
  dataDir?: string;
  tokenPath?: string;
  port?: string | number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function safePort(value: string | number): string {
  const raw = String(value);
  if (!/^\d{1,5}$/u.test(raw)) throw new TypeError("invalid Telegram MCP port");
  const port = Number(raw);
  if (port < 1 || port > 65_535) {
    throw new TypeError("invalid Telegram MCP port");
  }
  return String(port);
}

function safeInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`invalid ${name}`);
  }
  return value;
}

export function createTelegramAnalysisClient({
  root = process.cwd(),
  dataDir = "data",
  tokenPath,
  port = process.env.TELEGRAM_MCP_PORT ?? "8724",
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
}: TelegramAnalysisClientOptions = {}): TelegramAnalysisClient {
  const baseUrl = `http://127.0.0.1:${safePort(port)}/analysis/v1`;
  const resolvedTokenPath = tokenPath
    ? resolve(root, tokenPath)
    : resolve(root, dataDir, "telegram-userbot.token");
  safeInteger(timeoutMs, "timeout", 1, 120_000);

  async function request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const token = (await readFile(resolvedTokenPath, "utf8")).trim();
    if (!token) throw new Error("telegram_analysis_token_missing");
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
    } catch {
      if (signal.aborted) throw new Error("telegram_analysis_timeout");
      throw new Error("telegram_analysis_unreachable");
    }
    if (!response.ok) {
      let retryAfterSeconds: number | undefined;
      try {
        const metadata = FailureMetadataSchema.safeParse(await response.json());
        if (metadata.success) {
          retryAfterSeconds = metadata.data.retryAfterSeconds;
        }
      } catch {
        // The status code is sufficient; response contents never enter the error.
      }
      throw new TelegramAnalysisError(
        `telegram_analysis_http_${response.status}`,
        retryAfterSeconds,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("telegram_analysis_invalid_response");
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("telegram_analysis_invalid_response");
    }
    return parsed.data;
  }

  return {
    account: () => request("/account", AccountSchema),
    dialogs(offset, limit) {
      safeInteger(offset, "dialog offset", 0, 1_000_000);
      safeInteger(limit, "dialog limit", 1, 100);
      return request(
        `/dialogs?${new URLSearchParams({
          offset: String(offset),
          limit: String(limit),
        })}`,
        DialogsPageSchema,
      );
    },
    messages(chatId, afterId, limit) {
      safeInteger(chatId, "chat ID", -(2 ** 53) + 1, 2 ** 53 - 1);
      if (chatId === 0) throw new TypeError("invalid chat ID");
      safeInteger(afterId, "message cursor", 0, 2 ** 53 - 1);
      safeInteger(limit, "message limit", 1, 200);
      return request(
        `/messages?${new URLSearchParams({
          chat_id: String(chatId),
          after_id: String(afterId),
          limit: String(limit),
        })}`,
        MessagesPageSchema,
      );
    },
  };
}
