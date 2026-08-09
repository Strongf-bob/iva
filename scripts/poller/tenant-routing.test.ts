import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveTenant,
  routesForTenant,
  workerRoutes,
  type TenantRouteResult,
} from "./tenant-routing.ts";
import {
  defaultUserLimits,
  parseTelegramUserId,
  type UserRecord,
  type UserRegistry,
} from "../lib/user-registry.ts";
import type { TelegramQueueUpdate } from "../lib/telegram-queue.ts";

function user(
  rawId: string,
  status: "active" | "blocked" = "active",
  role: "owner" | "user" = "user",
): UserRecord {
  return {
    id: parseTelegramUserId(rawId)!,
    role,
    status,
    port: 8800 + Number(rawId),
    limits: defaultUserLimits(),
    createdAt: "2026-08-07T10:00:00.000Z",
  };
}

function registry(users: UserRecord[]): UserRegistry {
  return { schema: "iva-users/v1", revision: 1, users };
}

function privateMessage(fromId: number, text = "hello"): TelegramQueueUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, is_bot: false },
      text,
    },
  };
}

void test("verified from.id selects the worker and message text cannot override it", () => {
  const result = resolveTenant(
    privateMessage(123, "tenant=999"),
    registry([user("123")]),
  );

  assert.deepEqual(result, { kind: "active", userId: "123", port: 8923 });
});

void test("private callbacks use callback sender and reject a mismatched private chat", () => {
  const callback: TelegramQueueUpdate = {
    update_id: 2,
    callback_query: {
      id: "callback",
      from: { id: 123 },
      message: {
        message_id: 7,
        chat: { id: 999, type: "private" },
      },
    },
  };

  assert.deepEqual(resolveTenant(callback, registry([user("123")])), {
    kind: "unknown",
  });
});

void test("groups, missing senders, unknown users, and blocked users fail closed", () => {
  const group = privateMessage(7);
  group.message!.chat!.type = "group";
  const missingSender = privateMessage(7);
  delete missingSender.message!.from;

  const cases: Array<[TelegramQueueUpdate, UserRegistry, TenantRouteResult]> = [
    [group, registry([]), { kind: "non-private" }],
    [missingSender, registry([]), { kind: "unknown" }],
    [privateMessage(7), registry([]), { kind: "unknown" }],
    [privateMessage(8), registry([user("8", "blocked")]), { kind: "blocked" }],
  ];
  for (const [update, users, expected] of cases) {
    assert.deepEqual(resolveTenant(update, users), expected);
  }
});

void test("worker routes are fixed loopback URLs derived only from registry port", () => {
  assert.deepEqual(workerRoutes(user("123")), {
    webhook: "http://127.0.0.1:8923/eve/v1/telegram",
    acceptance: "http://127.0.0.1:8923/eve/v1/telegram/accepted",
    reset: "http://127.0.0.1:8923/eve/v1/telegram/reset",
  });
});

void test("the legacy owner uses the trusted assistant host across containers", () => {
  const legacyOwner: UserRecord = {
    ...user("123", "active", "owner"),
    port: 8723,
  };

  assert.deepEqual(routesForTenant(legacyOwner, "http://iva:8723/"), {
    webhook: "http://iva:8723/eve/v1/telegram",
    acceptance: "http://iva:8723/eve/v1/telegram/accepted",
    reset: "http://iva:8723/eve/v1/telegram/reset",
  });
});

void test("a personalized user ignores the legacy host and keeps an isolated loopback route", () => {
  assert.deepEqual(routesForTenant(user("123"), "http://iva:8723"), {
    webhook: "http://127.0.0.1:8923/eve/v1/telegram",
    acceptance: "http://127.0.0.1:8923/eve/v1/telegram/accepted",
    reset: "http://127.0.0.1:8923/eve/v1/telegram/reset",
  });
});
