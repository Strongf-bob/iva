import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { reconcileTelegramOwnerRoute } from "../lib/owner-routing.ts";
import { addUser } from "../lib/user-registry.ts";
import { checkRoutingHealth } from "./routing-health.ts";

function fixture(t: { after: (fn: () => Promise<void>) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "iva-routing-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "control");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

void test("a healthy legacy owner is probed through the trusted container host", async (t) => {
  const controlDir = fixture(t);
  await reconcileTelegramOwnerRoute({
    controlDir,
    allowedUserIds: new Set(["101"]),
  });
  let calls = 0;

  await checkRoutingHealth({
    controlDir,
    legacyBase: "http://iva:8723",
    fetchImpl: (input) => {
      calls += 1;
      assert.equal(requestUrl(input), "http://iva:8723/eve/v1/health");
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });

  assert.equal(calls, 1);
});

void test("a healthy personalized owner is probed on its registry worker port", async (t) => {
  const controlDir = fixture(t);
  const owner = await addUser(controlDir, { id: "101", role: "owner" });

  await checkRoutingHealth({
    controlDir,
    legacyBase: "http://iva:8723",
    fetchImpl: (input) => {
      assert.equal(
        requestUrl(input),
        `http://127.0.0.1:${owner.port}/eve/v1/health`,
      );
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
});

void test("missing owner state fails before any network request", async (t) => {
  const controlDir = fixture(t);
  let called = false;

  await assert.rejects(
    () =>
      checkRoutingHealth({
        controlDir,
        legacyBase: "http://iva:8723",
        fetchImpl: () => {
          called = true;
          return Promise.resolve(new Response("{}"));
        },
      }),
    /exactly one active owner/u,
  );
  assert.equal(called, false);
});

void test("non-success and network failures use secret-free diagnostics", async (t) => {
  const controlDir = fixture(t);
  await reconcileTelegramOwnerRoute({
    controlDir,
    allowedUserIds: new Set(["101"]),
  });

  await assert.rejects(
    () =>
      checkRoutingHealth({
        controlDir,
        legacyBase: "http://iva:8723",
        fetchImpl: () =>
          Promise.resolve(new Response("private body", { status: 503 })),
      }),
    /^Error: Telegram owner worker health returned HTTP 503$/u,
  );
  await assert.rejects(
    () =>
      checkRoutingHealth({
        controlDir,
        legacyBase: "http://iva:8723",
        fetchImpl: () =>
          Promise.reject(new Error("token=private message=private")),
      }),
    /^Error: Telegram owner worker health request failed$/u,
  );
});
