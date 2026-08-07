import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UserbotOnboardingError,
  createUserbotOnboardingClient,
} from "./userbot-onboarding-client.ts";

type CapturedRequest = {
  url: string;
  method: string;
  authorization: string;
  body: string | undefined;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iva-userbot-onboarding-client-"));
  await mkdir(join(root, "data"));
  const tokenPath = join(root, "data", "telegram-userbot.token");
  await writeFile(tokenPath, "first-token\n", { mode: 0o600 });
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(
      Response.json({ state: "code_sent", reason: "code_sent" }),
    );
  };
  return { root, tokenPath, requests, fetchImpl };
}

void test("client derives private routes and reads a fresh bearer for every request", async () => {
  const { root, tokenPath, requests, fetchImpl } = await fixture();
  const client = createUserbotOnboardingClient({
    root,
    mcpUrl: "http://telegram-userbot:8724/mcp",
    fetchImpl,
  });

  assert.deepEqual(await client.start("+79991234567"), {
    state: "code_sent",
    reason: "code_sent",
  });
  await writeFile(tokenPath, "second-token\n", { mode: 0o600 });
  await client.code("12345");

  assert.deepEqual(requests, [
    {
      url: "http://telegram-userbot:8724/onboarding/phone/start",
      method: "POST",
      authorization: "Bearer first-token",
      body: JSON.stringify({ phone: "+79991234567" }),
    },
    {
      url: "http://telegram-userbot:8724/onboarding/phone/code",
      method: "POST",
      authorization: "Bearer second-token",
      body: JSON.stringify({ code: "12345" }),
    },
  ]);
});

void test("client exposes all five operations with fixed methods and paths", async () => {
  const { root, requests, fetchImpl } = await fixture();
  const client = createUserbotOnboardingClient({ root, port: "9000", fetchImpl });

  await client.password("synthetic-password");
  await client.cancel();
  await client.status();

  assert.deepEqual(
    requests.map(({ url, method, body }) => ({ url, method, body })),
    [
      {
        url: "http://127.0.0.1:9000/onboarding/phone/password",
        method: "POST",
        body: JSON.stringify({ password: "synthetic-password" }),
      },
      {
        url: "http://127.0.0.1:9000/onboarding/phone/cancel",
        method: "POST",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:9000/onboarding/phone/status",
        method: "GET",
        body: undefined,
      },
    ],
  );
});

void test("client rejects protocols and response shapes with secret-free fixed errors", async () => {
  const canary = "+79990000000";
  const badProtocol = createUserbotOnboardingClient({
    mcpUrl: `file:///tmp/${canary}/mcp`,
  });
  await assert.rejects(badProtocol.start(canary), (error: unknown) => {
    assert.ok(error instanceof UserbotOnboardingError);
    assert.equal(error.reason, "invalid_configuration");
    assert.doesNotMatch(error.message, /79990000000/u);
    return true;
  });

  const { root } = await fixture();
  const malformed = createUserbotOnboardingClient({
    root,
    fetchImpl: () =>
      Promise.resolve(
        Response.json({ state: "authorized", reason: canary, raw: canary }),
      ),
  });
  await assert.rejects(malformed.start(canary), (error: unknown) => {
    assert.ok(error instanceof UserbotOnboardingError);
    assert.equal(error.reason, "invalid_response");
    assert.doesNotMatch(error.message, /79990000000/u);
    return true;
  });
});

void test("client maps auth, missing token, and timeout without leaking causes", async () => {
  const { root } = await fixture();
  const denied = createUserbotOnboardingClient({
    root,
    fetchImpl: () =>
      Promise.resolve(new Response("secret denial body", { status: 401 })),
  });
  await assert.rejects(denied.status(), (error: unknown) => {
    assert.ok(error instanceof UserbotOnboardingError);
    assert.equal(error.reason, "proxy_auth_rejected");
    assert.doesNotMatch(error.message, /secret denial body/u);
    return true;
  });

  const missing = createUserbotOnboardingClient({
    root: join(root, "missing"),
  });
  await assert.rejects(missing.status(), (error: unknown) => {
    assert.ok(error instanceof UserbotOnboardingError);
    assert.equal(error.reason, "proxy_token_missing");
    return true;
  });

  const timedOut = createUserbotOnboardingClient({
    root,
    timeoutMs: 5,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("secret transport cause")),
        );
      }),
  });
  await assert.rejects(timedOut.status(), (error: unknown) => {
    assert.ok(error instanceof UserbotOnboardingError);
    assert.equal(error.reason, "transport_failed");
    assert.doesNotMatch(error.message, /secret transport cause/u);
    return true;
  });
});
