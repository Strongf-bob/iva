import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGwsTasksProvider,
  createSnapshotProviders,
  createTelegramBotProvider,
  parseComposedReportJson,
} from "./runtime.ts";

function dataRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "iva-proactive-runtime-"));
  chmodSync(path, 0o700);
  return path;
}

void test("snapshot providers read only fixed bounded private source files", async () => {
  const dataDir = dataRoot();
  const sources = join(dataDir, "proactive-reviews/sources");
  mkdirSync(sources, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(sources, "unified-inbox.json"),
    JSON.stringify([
      { id: "mail-1", title: "Reply", evidence: ["gmail:message:1"] },
    ]),
  );
  const providers = createSnapshotProviders(dataDir);
  const window = {
    kind: "daily" as const,
    periodKey: "2026-08-10",
    from: 1,
    to: 2,
  };

  assert.equal((await providers.inbox.listInbox(window)).length, 1);
  assert.deepEqual(await providers.crm.listRelationshipUpdates(window), []);
  assert.deepEqual(await providers.calendar.listCalendarItems(window), []);
  assert.deepEqual(await providers.tasks.listTasks(window), []);
});

void test("snapshot provider rejects a symlink instead of reading outside personal data", async () => {
  const dataDir = dataRoot();
  const outside = join(dataRoot(), "outside.json");
  writeFileSync(
    outside,
    JSON.stringify([{ id: "x", title: "x", evidence: ["outside:x"] }]),
  );
  const sources = join(dataDir, "proactive-reviews/sources");
  mkdirSync(sources, { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(sources, "unified-inbox.json"));
  const providers = createSnapshotProviders(dataDir);
  await assert.rejects(
    providers.inbox.listInbox({
      kind: "daily",
      periodKey: "2026-08-10",
      from: 1,
      to: 2,
    }),
    /snapshot-symbolic-link/u,
  );
});

void test("Telegram provider enforces the owner recipient and emits action markup", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new TypeError("expected JSON request body");
    }
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  assert.throws(
    () =>
      createTelegramBotProvider({
        botToken: "bot",
        ownerId: "101",
        chatId: "202",
      }),
    /owner private chat/u,
  );
  const provider = createTelegramBotProvider({
    botToken: "bot",
    ownerId: "101",
    chatId: "101",
  });
  const delivered = await provider.deliver({
    deliveryKey: "101:daily:2026-08-10",
    body: "Prepared",
    late: false,
    actions: [
      {
        text: "Create Google Task",
        callbackData: `iva_commitment:c:${"x".repeat(43)}`,
      },
    ],
  });
  assert.equal(delivered.receipt, "telegram:77");
  assert.deepEqual(requests[0]?.reply_markup, {
    inline_keyboard: [
      [
        {
          text: "Create Google Task",
          callback_data: `iva_commitment:c:${"x".repeat(43)}`,
        },
      ],
    ],
  });
});

void test("GWS task provider finds its idempotency marker before insert", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const provider = createGwsTasksProvider({
    listTasks: () => Promise.resolve([]),
    exec: (args) => {
      mutableCalls.push([...args]);
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            {
              id: "existing",
              notes: "[iva-idempotency:key-1]",
            },
          ],
        }),
      });
    },
  });
  const result = await provider.createConfirmedCommitment({
    suggestion: {
      id: "c1",
      title: "Call bank",
      evidence: ["source:1"],
    },
    idempotencyKey: "key-1",
  });
  assert.equal(result.receipt, "google-task:existing");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(0, 3), ["tasks", "tasks", "list"]);
});

void test("GWS task provider inserts with fixed argv and a private idempotency marker", async () => {
  const calls: string[][] = [];
  const provider = createGwsTasksProvider({
    listTasks: () => Promise.resolve([]),
    exec: (args) => {
      calls.push([...args]);
      return Promise.resolve(
        calls.length === 1
          ? { exitCode: 0, stdout: JSON.stringify({ items: [] }) }
          : { exitCode: 0, stdout: JSON.stringify({ id: "created" }) },
      );
    },
  });
  const result = await provider.createConfirmedCommitment({
    suggestion: {
      id: "c1",
      title: "Call bank",
      evidence: ["source:1"],
    },
    idempotencyKey: "key-1",
  });
  assert.equal(result.receipt, "google-task:created");
  assert.deepEqual(calls[1]?.slice(0, 3), ["tasks", "tasks", "insert"]);
  assert.match(calls[1]?.at(-1) ?? "", /iva-idempotency:key-1/u);
});

void test("composer parser accepts one fenced JSON object and rejects prose", () => {
  const parsed = parseComposedReportJson(
    '```json\n{"body":"Ready","sourceFingerprint":"model","suggestions":[],"alerts":[]}\n```',
  );
  assert.equal(parsed.body, "Ready");
  assert.throws(
    () => parseComposedReportJson("Here is your report: not JSON"),
    /agent-returned-invalid-report-json/u,
  );
});
