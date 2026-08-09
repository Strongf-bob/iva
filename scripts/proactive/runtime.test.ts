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
  createRuntimeProviders,
  createSnapshotProviders,
  createTelegramBotProvider,
  parseComposedReportJson,
  resolveProactiveOwnerId,
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

void test("snapshot provider rejects a symlinked parent directory", async () => {
  const dataDir = dataRoot();
  const outsideSources = join(dataRoot(), "sources");
  mkdirSync(outsideSources, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(outsideSources, "unified-inbox.json"),
    JSON.stringify([{ id: "x", title: "x", evidence: ["outside:x"] }]),
  );
  mkdirSync(join(dataDir, "proactive-reviews"), { mode: 0o700 });
  symlinkSync(outsideSources, join(dataDir, "proactive-reviews", "sources"));
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

void test("legacy runtime resolves exactly one owner and ignores digest redirection", () => {
  const env = {
    ASSISTANT_DATA_DIR: dataRoot(),
    ASSISTANT_PERSONAL_ROOT: dataRoot(),
    TELEGRAM_BOT_TOKEN: "bot",
    TELEGRAM_ALLOWED_USER_IDS: "101",
    TELEGRAM_DIGEST_CHAT_ID: "202",
  };
  assert.equal(resolveProactiveOwnerId(env), "101");
  assert.doesNotThrow(() => createRuntimeProviders(env));
  assert.throws(
    () => resolveProactiveOwnerId({ TELEGRAM_ALLOWED_USER_IDS: "101,202" }),
    /owner id is missing/u,
  );
});

void test("container runtime requires a personal Google root", () => {
  assert.throws(
    () =>
      createRuntimeProviders({
        ASSISTANT_DATA_DIR: dataRoot(),
        ASSISTANT_USER_ID: "101",
        IVA_RUNTIME: "container",
        TELEGRAM_BOT_TOKEN: "bot",
        TELEGRAM_DIGEST_CHAT_ID: "101",
      }),
    /personal Google HOME/u,
  );
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

void test("GWS task lookup paginates and a long task body retains its marker", async () => {
  const lookupCalls: string[][] = [];
  const existing = createGwsTasksProvider({
    listTasks: () => Promise.resolve([]),
    exec: (args) => {
      lookupCalls.push([...args]);
      return Promise.resolve(
        lookupCalls.length === 1
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ items: [], nextPageToken: "page-2" }),
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                items: [
                  { id: "existing-page-2", notes: "[iva-idempotency:key-2]" },
                ],
              }),
            },
      );
    },
  });
  assert.equal(
    (
      await existing.createConfirmedCommitment({
        suggestion: { id: "c2", title: "Call", evidence: ["source:2"] },
        idempotencyKey: "key-2",
      })
    ).receipt,
    "google-task:existing-page-2",
  );
  assert.match(lookupCalls[1]?.[4] ?? "", /page-2/u);

  const insertCalls: string[][] = [];
  const inserting = createGwsTasksProvider({
    listTasks: () => Promise.resolve([]),
    exec: (args) => {
      insertCalls.push([...args]);
      return Promise.resolve(
        insertCalls.length === 1
          ? { exitCode: 0, stdout: JSON.stringify({ items: [] }) }
          : { exitCode: 0, stdout: JSON.stringify({ id: "created-long" }) },
      );
    },
  });
  await inserting.createConfirmedCommitment({
    suggestion: {
      id: "c3",
      title: "Long",
      notes: "n".repeat(4_000),
      evidence: Array.from(
        { length: 8 },
        (_, index) => `${index}:${"e".repeat(1_020)}`,
      ),
    },
    idempotencyKey: "key-3",
  });
  const bodyArg = insertCalls[1]?.at(-1);
  assert.ok(bodyArg);
  const body = JSON.parse(bodyArg) as { notes: string };
  assert.ok(body.notes.length <= 8_000);
  assert.match(body.notes, /\[iva-idempotency:key-3\]/u);
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
