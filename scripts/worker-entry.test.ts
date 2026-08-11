import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { addUser } from "./lib/user-registry.ts";
import { ensureUserLayout, resolveUserLayout } from "./lib/user-layout.ts";
import { prepareWorker } from "./worker-entry.ts";

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "iva-worker-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "app");
  const data = join(root, "data");
  mkdirSync(join(appRoot, ".output"), { recursive: true });
  mkdirSync(join(appRoot, "node_modules"));
  mkdirSync(join(appRoot, "scripts"));
  writeFileSync(join(appRoot, "package.json"), "{}\n");
  return {
    appRoot,
    controlDir: join(data, "control"),
    usersDir: join(data, "users"),
  };
}

void test("bootstrap fixes personal cwd and filters the child environment", async (t) => {
  const paths = fixture(t);
  const user = await addUser(paths.controlDir, { id: "123", role: "owner" });
  ensureUserLayout(resolveUserLayout(paths.usersDir, user.id), paths.appRoot);

  const prepared = await prepareWorker({
    ...paths,
    userId: "123",
    expectedPort: "8800",
    sourceEnv: {
      PATH: "/usr/bin",
      OPENCODE_API_KEY: "shared-provider-key",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_EXPOSED_TOOLS: "read-only",
      TELEGRAM_MCP_URL: "http://telegram-userbot:8724/mcp",
      TELEGRAM_MCP_TOKEN: "must-not-leak",
      TELEGRAM_API_HASH: "must-not-leak",
      RANDOM_PRIVATE_SECRET: "must-not-leak",
      ASSISTANT_DATA_DIR: "/wrong/shared/data",
      ASSISTANT_VAULT_DIR: "/wrong/shared/vault",
      IVA_RUN_STATUS_DATA_DIR: "/shared/run-status/data",
    },
  });

  assert.equal(prepared.cwd, join(paths.usersDir, "123", "runtime"));
  assert.equal(prepared.port, 8800);
  assert.equal(prepared.env.ASSISTANT_USER_ID, "123");
  assert.equal(prepared.env.ASSISTANT_MULTI_USER, "1");
  assert.equal(prepared.env.ASSISTANT_USER_ROLE, "owner");
  assert.equal(prepared.env.ASSISTANT_ROLE, "owner");
  assert.equal(prepared.env.IVA_USER_CONTROL_DIR, paths.controlDir);
  assert.equal(prepared.env.ASSISTANT_APP_DIR, paths.appRoot);
  assert.equal(prepared.env.ASSISTANT_DATA_DIR, join(prepared.cwd, "data"));
  assert.equal(prepared.env.IVA_RUN_STATUS_DATA_DIR, "/shared/run-status/data");
  assert.equal(
    prepared.env.ASSISTANT_VAULT_DIR,
    join(paths.usersDir, "123", "vault"),
  );
  assert.equal(prepared.env.TELEGRAM_ALLOWED_USER_IDS, "123");
  assert.equal(prepared.env.OPENCODE_API_KEY, "shared-provider-key");
  assert.equal(prepared.env.TELEGRAM_EXPOSED_TOOLS, "read-only");
  assert.equal(
    prepared.env.TELEGRAM_MCP_URL,
    "http://telegram-userbot:8724/mcp",
  );
  assert.equal(prepared.env.TELEGRAM_MCP_TOKEN, undefined);
  assert.equal(prepared.env.TELEGRAM_API_HASH, undefined);
  assert.equal(prepared.env.RANDOM_PRIVATE_SECRET, undefined);
  assert.equal(prepared.env.HOME, join(paths.usersDir, "123"));
  assert.equal(statSync(prepared.env.TMPDIR!).mode & 0o777, 0o700);
});

void test("bootstrap rejects an inactive identity and a port mismatch", async (t) => {
  const paths = fixture(t);
  const user = await addUser(paths.controlDir, {
    id: "123",
    role: "owner",
    status: "blocked",
  });
  ensureUserLayout(resolveUserLayout(paths.usersDir, user.id), paths.appRoot);

  await assert.rejects(
    () =>
      prepareWorker({
        ...paths,
        userId: "123",
        expectedPort: "8800",
        sourceEnv: {},
      }),
    /not active/u,
  );

  const active = await addUser(paths.controlDir, { id: "456", role: "user" });
  ensureUserLayout(resolveUserLayout(paths.usersDir, active.id), paths.appRoot);
  await assert.rejects(
    () =>
      prepareWorker({
        ...paths,
        userId: "456",
        expectedPort: "9999",
        sourceEnv: {},
      }),
    /port does not match/u,
  );
});
