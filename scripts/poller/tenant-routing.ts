import { TELEGRAM_ACCEPTANCE_ROUTE } from "#lib/telegram-acceptance.ts";

import type { TelegramQueueUpdate } from "../lib/telegram-queue.ts";
import {
  isLegacyOwnerRoute,
  parseTelegramUserId,
  type TelegramUserId,
  type UserRecord,
  type UserRegistry,
} from "../lib/user-registry.ts";

export type WorkerRoutes = {
  webhook: string;
  acceptance: string;
  reset: string;
};

export type TenantRouteResult =
  | { kind: "active"; userId: TelegramUserId; port: number }
  | { kind: "blocked" | "unknown" | "non-private" };

function senderAndMessage(update: TelegramQueueUpdate) {
  if (update.message) {
    return { sender: update.message.from, message: update.message };
  }
  if (update.callback_query) {
    return {
      sender: update.callback_query.from,
      message: update.callback_query.message,
    };
  }
  return { sender: undefined, message: undefined };
}

export function resolveTenant(
  update: TelegramQueueUpdate,
  registry: UserRegistry,
): TenantRouteResult {
  const { sender, message } = senderAndMessage(update);
  if (message?.chat?.type !== "private") return { kind: "non-private" };
  const id = parseTelegramUserId(String(sender?.id ?? ""));
  if (!id) return { kind: "unknown" };
  // A private Telegram chat belongs to exactly one user. Reject synthetic or
  // replayed updates whose chat and verified sender identities disagree.
  if (String(message.chat.id) !== id) return { kind: "unknown" };
  const user = registry.users.find((candidate) => candidate.id === id);
  if (!user) return { kind: "unknown" };
  if (user.status !== "active") return { kind: "blocked" };
  return { kind: "active", userId: id, port: user.port };
}

export function workerRoutes(user: Pick<UserRecord, "port">): WorkerRoutes {
  const base = `http://127.0.0.1:${user.port}`;
  return routesFromBase(base);
}

function routesFromBase(rawBase: string): WorkerRoutes {
  const base = rawBase.replace(/\/$/u, "");
  const webhook = `${base}/eve/v1/telegram`;
  return {
    webhook,
    acceptance: `${base}${TELEGRAM_ACCEPTANCE_ROUTE}`,
    reset: `${webhook}/reset`,
  };
}

export function routesForTenant(
  user: UserRecord,
  legacyBase: string,
): WorkerRoutes {
  return isLegacyOwnerRoute(user)
    ? routesFromBase(legacyBase)
    : workerRoutes(user);
}
