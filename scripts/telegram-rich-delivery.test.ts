/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";

const { attemptTelegramRichDelivery, deliverTelegramCompletedMessage } =
  await import("../agent/lib/telegram-rich-delivery.ts");

test("rich delivery reports a definitive API rejection as retryable", async () => {
  const outcome = await attemptTelegramRichDelivery(() =>
    Promise.resolve({ ok: false, status: 400, body: { description: "bad" } }),
  );
  assert.deepEqual(outcome, {
    kind: "rejected",
    status: 400,
    body: { description: "bad" },
  });
});

test("rich delivery reports a transport exception as ambiguous", async () => {
  const error = new Error("socket closed after write");
  const outcome = await attemptTelegramRichDelivery(() =>
    Promise.reject(error),
  );
  assert.deepEqual(outcome, { kind: "ambiguous", error });
});

test("rich delivery reports an accepted request as delivered", async () => {
  const outcome = await attemptTelegramRichDelivery(() =>
    Promise.resolve({ ok: true, status: 200, body: { result: true } }),
  );
  assert.deepEqual(outcome, { kind: "delivered" });
});

type ReplyHandle = Parameters<typeof deliverTelegramCompletedMessage>[1];

async function deliverWithResponse(
  response: "accepted" | "rejected" | "ambiguous",
  message = "| Field | Current |\n|---|---|\n| Role | Colleague |",
): Promise<{
  requests: Array<{ method: string; body: unknown }>;
  posts: unknown[];
  receipts: boolean[];
}> {
  const requests: Array<{ method: string; body: unknown }> = [];
  const posts: unknown[] = [];
  const receipts: boolean[] = [];
  const handle = {
    chatId: "9",
    messageThreadId: undefined,
    request: (method: string, body?: unknown) => {
      requests.push({ method, body });
      if (response === "ambiguous")
        return Promise.reject(new Error("socket closed after write"));
      return Promise.resolve({
        ok: response === "accepted",
        status: response === "accepted" ? 200 : 400,
        body: response === "accepted" ? { result: true } : { error: "bad" },
      });
    },
    post: (body: unknown) => {
      posts.push(body);
      return Promise.resolve({});
    },
  } as ReplyHandle;
  await deliverTelegramCompletedMessage(message, handle, (delivered) =>
    receipts.push(delivered),
  );
  return { requests, posts, receipts };
}

test("completed rich reply sends once and redacts before transport", async () => {
  const secret = `api_key=${"x".repeat(24)}`;
  const result = await deliverWithResponse(
    "accepted",
    `| Field | Current |\n|---|---|\n| Secret | ${secret} |`,
  );
  assert.equal(result.requests.length, 1);
  assert.equal(result.posts.length, 0);
  assert.deepEqual(result.receipts, [true]);
  assert.equal(result.requests[0].method, "sendRichMessage");
  const body = JSON.stringify(result.requests[0].body);
  assert.doesNotMatch(body, new RegExp(secret, "u"));
  assert.match(body, /\[REDACTED\]/u);
});

test("completed rich reply uses HTML only after definitive rejection", async () => {
  const result = await deliverWithResponse("rejected");
  assert.equal(result.requests.length, 1);
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.receipts, [true]);
});

test("completed rich reply never retries an ambiguous request", async () => {
  const result = await deliverWithResponse("ambiguous");
  assert.equal(result.requests.length, 1);
  assert.equal(result.posts.length, 0);
  assert.deepEqual(result.receipts, [false]);
});
