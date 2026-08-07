import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDeviceCodeLogin } from "./codex-oauth.ts";

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

void test("device login retries a transient polling transport failure", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-codex-device-"));
  const calls: string[] = [];
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const idToken = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-test",
      chatgpt_plan_type: "plus",
    },
  });

  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    if (url.endsWith("/deviceauth/usercode")) {
      return Promise.resolve(
        Response.json({
          device_auth_id: "device-test",
          user_code: "TEST-CODE",
          interval: 1,
        }),
      );
    }
    if (url.endsWith("/deviceauth/token") && calls.length === 2) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (url.endsWith("/deviceauth/token")) {
      return Promise.resolve(
        Response.json({
          authorization_code: "authorization-test",
          code_verifier: "verifier-test",
        }),
      );
    }
    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: accessToken,
          id_token: idToken,
          refresh_token: "refresh-test",
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  const auth = await runDeviceCodeLogin({ dataDir, log: () => undefined });

  assert.equal(auth.accountId, "account-test");
  assert.equal(
    calls.filter((url) => url.endsWith("/deviceauth/token")).length,
    2,
  );
  assert.equal(statSync(join(dataDir, "codex-auth.json")).mode & 0o777, 0o600);
});
