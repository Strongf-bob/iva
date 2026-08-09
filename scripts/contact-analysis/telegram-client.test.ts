/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-base-to-string -- Node's test runner owns registrations; injected fetch fakes intentionally resolve synchronously. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTelegramAnalysisClient } from "./telegram-client.ts";

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fixture(fetchImpl: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-client-"));
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    join(root, "data", "telegram-userbot.token"),
    "secret-one\n",
    {
      mode: 0o600,
    },
  );
  return {
    root,
    client: createTelegramAnalysisClient({
      root,
      port: 9124,
      fetchImpl,
    }),
  };
}

test("client uses loopback GET routes, bearer auth and encoded pagination", async () => {
  const requests: RecordedRequest[] = [];
  const { root, client } = await fixture(async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    if (url.endsWith("/account")) {
      return jsonResponse({
        userId: 7,
        displayName: "Owner",
        username: "owner",
      });
    }
    if (url.includes("/dialogs?")) {
      return jsonResponse({
        dialogs: [{ id: -1001, kind: "group", title: "Team", username: null }],
        nextOffset: null,
      });
    }
    return jsonResponse({
      messages: [
        {
          id: 9,
          senderId: 44,
          timestamp: "2026-08-07T00:00:00Z",
          text: "hello",
          replyToMessageId: null,
          mentionedUserIds: [],
          mentionedUsernames: [],
          mediaKind: null,
        },
      ],
      nextAfterId: 9,
    });
  });

  assert.equal((await client.account()).userId, 7);
  assert.equal((await client.dialogs(100, 25)).dialogs[0]?.kind, "group");
  assert.equal((await client.messages(-1001, 8, 200)).messages[0]?.id, 9);

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "http://127.0.0.1:9124/analysis/v1/account",
      "http://127.0.0.1:9124/analysis/v1/dialogs?offset=100&limit=25",
      "http://127.0.0.1:9124/analysis/v1/messages?chat_id=-1001&after_id=8&limit=200",
    ],
  );
  assert.ok(requests.every((request) => request.init.method === "GET"));
  assert.ok(
    requests.every(
      (request) =>
        new Headers(request.init.headers).get("authorization") ===
        "Bearer secret-one",
    ),
  );

  await writeFile(join(root, "data", "telegram-userbot.token"), "secret-two\n");
  await client.account();
  assert.equal(
    new Headers(requests.at(-1)?.init.headers).get("authorization"),
    "Bearer secret-two",
  );
});

test("client rejects malformed payloads without reflecting response or token", async () => {
  const { client } = await fixture(async () =>
    jsonResponse(
      {
        error: "private Telegram message body",
        retryAfterSeconds: 17,
      },
      502,
    ),
  );

  await assert.rejects(client.account(), (error: Error) => {
    assert.match(error.message, /telegram_analysis_http_502/u);
    assert.doesNotMatch(error.message, /private Telegram message body/u);
    assert.doesNotMatch(error.message, /secret-one/u);
    assert.equal(
      (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds,
      17,
    );
    return true;
  });

  const malformed = await fixture(async () =>
    jsonResponse({ userId: "not-a-number", displayName: "secret body" }),
  );
  await assert.rejects(malformed.client.account(), (error: Error) => {
    assert.match(error.message, /telegram_analysis_invalid_response/u);
    assert.doesNotMatch(error.message, /secret body/u);
    return true;
  });
});

test("client enforces a bounded timeout", async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  const { root } = await fixture(fetchImpl);
  const fastClient = createTelegramAnalysisClient({
    root,
    port: 9124,
    timeoutMs: 5,
    fetchImpl,
  });

  await assert.rejects(fastClient.account(), /telegram_analysis_timeout/u);
});

test("client can read a shared token independently from personal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-shared-token-"));
  const tokenPath = join(root, "shared", "telegram-userbot.token");
  await mkdir(join(root, "shared"), { recursive: true });
  await writeFile(tokenPath, "shared-secret\n", { mode: 0o600 });
  let authorization = "";
  const client = createTelegramAnalysisClient({
    root,
    dataDir: join(root, "personal-data"),
    tokenPath,
    port: 9124,
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse({ userId: 7, displayName: "Owner", username: null });
    },
  });

  await client.account();
  assert.equal(authorization, "Bearer shared-secret");
});
