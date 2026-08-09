import assert from "node:assert/strict";
import test from "node:test";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

function parseRequestBody(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Expected a JSON object request body");
  return Object.fromEntries(Object.entries(parsed));
}

function captureRequest(
  url: URL | RequestInfo,
  options?: RequestInit,
): CapturedRequest {
  const body = options?.body;
  if (typeof body !== "string")
    throw new TypeError("Expected a JSON request body");
  const requestUrl =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return { url: requestUrl, body: parseRequestBody(body) };
}

void test("telegram-send loads under bare Node and redacts outbound secrets", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[0].body.chat_id, "test-chat");
  assert.equal(requests[0].body.text, "[REDACTED]");
});

void test("telegram-send keeps redaction when retrying a rejected HTML message", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    const status = requests.length === 1 ? 400 : 200;
    return Promise.resolve(
      new Response(status === 400 ? "bad entities" : "", { status }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: true, error: "" });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[1].body.chat_id, "test-chat");
  assert.equal(requests[1].body.text, "[REDACTED]");
  assert.equal("parse_mode" in requests[1].body, false);
});

void test("telegram report delivery returns a receipt and puts allowlisted actions on the last chunk", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 40 + requests.length },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtmlWithReceipt } = await import("./telegram-send.ts");
  const result = await sendTelegramHtmlWithReceipt(
    "test-bot",
    "101",
    `${"first ".repeat(800)}second`,
    {
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "Create Google Task",
              callback_data: `iva_commitment:c:${"x".repeat(43)}`,
            },
          ],
        ],
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.receipt, "telegram:41,42");
  assert.equal("reply_markup" in requests[0].body, false);
  assert.deepEqual(requests[1].body.reply_markup, {
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

void test("telegram report delivery treats a later chunk rejection as ambiguous", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response("temporarily unavailable", { status: 503 }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtmlWithReceipt } = await import("./telegram-send.ts");
  const result = await sendTelegramHtmlWithReceipt(
    "test-bot",
    "101",
    "two chunks ".repeat(500),
  );

  assert.equal(requestCount, 2);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "ambiguous");
});
