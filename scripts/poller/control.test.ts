/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  controlCallbackAllowed,
  controlCommandAllowed,
  handleAwaitNonText,
  resolveControlRoutes,
} from "./control.ts";
import {
  defaultUserLimits,
  parseTelegramUserId,
  type UserRegistry,
} from "../lib/user-registry.ts";
import type { TelegramQueueUpdate } from "../lib/telegram-queue.ts";

type Event = string | [string, string, number | undefined, string | undefined];
type CaptureMessage = { message_id?: number };
type CaptureState = { flow: unknown; awaitText?: unknown };

test("ordinary users get personal conversation and usage controls", () => {
  for (const command of ["/help", "/stop", "/new", "/usage", "/menu"]) {
    assert.equal(controlCommandAllowed(command, "user"), true, command);
  }
  for (const command of ["/restart", "/update", "/model", "/think"]) {
    assert.equal(controlCommandAllowed(command, "user"), false, command);
    assert.equal(controlCommandAllowed(command, "owner"), true, command);
  }
});

test("ordinary user callback gate admits every visible personal menu route", () => {
  for (const callback of [
    "iva_menu:r:o",
    "iva_menu:td:o",
    "iva_menu:td:brief",
    "iva_menu:tsk:o",
    "iva_menu:tsk:add",
    "iva_menu:auto:o",
    "iva_menu:set:o",
    "iva_menu:scon:o",
    "iva_menu:ssys:o",
    "iva_menu:st:o",
    "iva_menu:gws:o",
    "iva_menu:cron:o",
    "iva_menu:cron:pg:1",
  ]) {
    assert.equal(controlCallbackAllowed(callback, "user"), true, callback);
  }
  for (const callback of [
    "iva_update:yes",
    "iva_model:pick",
    "iva_think:pick",
    "iva_menu:in:o",
    "iva_menu:ppl:o",
    "iva_menu:sai:o",
    "iva_menu:sper:o",
    "iva_menu:ub:o",
    "iva_menu:sk:o",
    "iva_menu:svc:o",
  ]) {
    assert.equal(controlCallbackAllowed(callback, "user"), false, callback);
    assert.equal(controlCallbackAllowed(callback, "owner"), true, callback);
  }
});

test("menu delivery uses the trusted container route for the legacy owner", () => {
  const ownerId = parseTelegramUserId("123")!;
  const registry: UserRegistry = {
    schema: "iva-users/v1",
    revision: 1,
    users: [
      {
        id: ownerId,
        role: "owner",
        status: "active",
        port: 8723,
        limits: defaultUserLimits(),
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    ],
  };
  const update: TelegramQueueUpdate = {
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: 123, type: "private" },
      from: { id: 123, is_bot: false },
      text: "menu action",
    },
  };

  assert.deepEqual(resolveControlRoutes(update, registry, "http://iva:8723"), {
    webhook: "http://iva:8723/eve/v1/telegram",
    acceptance: "http://iva:8723/eve/v1/telegram/accepted",
    reset: "http://iva:8723/eve/v1/telegram/reset",
  });
});

test("commitment callbacks are consumed before model-facing callback routes", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./control.ts", import.meta.url)),
    "utf8",
  );
  const proactive = source.indexOf("handleProactiveCommitmentCallback({");
  const update = source.indexOf('callback.data.startsWith("iva_update:")');
  const menu = source.indexOf('callback.data.startsWith("iva_menu:")');
  assert.ok(proactive > 0);
  assert.ok(proactive < update);
  assert.ok(proactive < menu);
});

test("secret document capture deletes before download and never reaches Eve", async () => {
  const events: Event[] = [];
  const io = {
    deleteSecret: async () => {
      events.push("delete");
      return true;
    },
    download: async () => {
      events.push("download");
      return "client secret";
    },
    deliver: async (
      text: string,
      message: CaptureMessage,
      state: CaptureState,
    ) => {
      events.push([
        "deliver",
        text,
        message.message_id,
        (state.awaitText as { kind?: string } | undefined)?.kind,
      ]);
    },
    reply: async () => assert.fail("must not reply after a successful capture"),
  };

  const consumed = await handleAwaitNonText(
    {
      message_id: 7,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, [
    "delete",
    "download",
    ["deliver", "client secret", 7, "gws_client_secret"],
  ]);
});

test("failed deletion consumes a secret document without downloading it", async () => {
  const events: Event[] = [];
  const consumed = await handleAwaitNonText(
    {
      message_id: 8,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    {
      deleteSecret: async () => {
        events.push("delete");
        return false;
      },
      download: async () => assert.fail("must not download a visible secret"),
      deliver: async () => assert.fail("must not deliver a visible secret"),
      reply: async () => assert.fail("deleteSecret owns the failure warning"),
    },
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, ["delete"]);
});
