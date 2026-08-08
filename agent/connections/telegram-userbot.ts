// Подключение к локальному telegram-userbot прокси (services/telegram-userbot/serve.py):
// личный Telegram-аккаунт владельца через Telethon (userbot). Прокси — единственный
// владелец сессии, живёт как systemd-сервис или внутренний Compose sidecar. Тулы видны модели как
// connection__telegram-userbot__<tool> и находятся через connection_search.
//
// Онбординг (QR-логин) и правила безопасности — в скилле telegram-userbot.
// URL/токен модель НЕ видит: они на стороне рантайма.
import { defineMcpClientConnection } from "eve/connections";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const port = process.env.TELEGRAM_MCP_PORT ?? "8724";
const url = process.env.TELEGRAM_MCP_URL ?? `http://127.0.0.1:${port}/mcp`;
const ownerWorker =
  process.env.ASSISTANT_MULTI_USER !== "1" ||
  process.env.ASSISTANT_ROLE === "owner";

// Токен пишет `iva userbot setup` в data/telegram-userbot.token (тот же файл читает прокси).
// Читаем при КАЖДОМ вызове (getToken), а не на старте: iva не нужно перезапускать после
// того, как агент поднял прокси и создал токен — Eve и так ретраит соединение.
function proxyToken(): string {
  if (!ownerWorker) return "";
  if (process.env.TELEGRAM_MCP_TOKEN) return process.env.TELEGRAM_MCP_TOKEN;
  try {
    return readFileSync(
      join(
        process.env.ASSISTANT_APP_DIR || process.cwd(),
        "data",
        "telegram-userbot.token",
      ),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

export default defineMcpClientConnection({
  url: ownerWorker ? url : "http://127.0.0.1:1/disabled-userbot",
  description:
    "Личный Telegram владельца (userbot, НЕ бот-аккаунт): только чтение диалогов, " +
    "истории и поиск. Отправка и другие изменения отключены на MCP-сервере. " +
    "Требует подключения аккаунта через QR (скилл telegram-userbot).",
  auth: {
    getToken: () => Promise.resolve({ token: proxyToken() }),
  },
});
