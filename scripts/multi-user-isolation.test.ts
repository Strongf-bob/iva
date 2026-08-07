import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePersonalReadPath } from "../agent/lib/safe-user-path.ts";
import {
  addUser,
  readUserRegistry,
  setUserStatus,
} from "./lib/user-registry.ts";
import { ensureUserLayout, resolveUserLayout } from "./lib/user-layout.ts";
import { chargeUserIngress } from "./lib/user-quota.ts";
import { resolveTenant, workerRoutes } from "./poller/tenant-routing.ts";
import { prepareWorker } from "./worker-entry.ts";

function update(userId: number, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: userId, type: "private" },
      from: { id: userId, is_bot: false },
      text: "hello",
    },
  };
}

void test("two mutually untrusted users keep routes, files, workers and quotas independent", async (t) => {
  const appRoot = mkdtempSync(join(tmpdir(), "iva-two-user-"));
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  for (const path of [".output", "node_modules", "scripts"])
    mkdirSync(join(appRoot, path), { recursive: true });
  writeFileSync(join(appRoot, "package.json"), "{}\n");
  const controlDir = join(appRoot, "data", "control");
  const usersDir = join(appRoot, "data", "users");
  const first = await addUser(controlDir, { id: "101", role: "owner" });
  const second = await addUser(controlDir, { id: "202", role: "user" });
  const firstLayout = resolveUserLayout(usersDir, first.id);
  const secondLayout = resolveUserLayout(usersDir, second.id);
  ensureUserLayout(firstLayout, appRoot);
  ensureUserLayout(secondLayout, appRoot);
  writeFileSync(join(firstLayout.vault, "CORE.md"), "alpha\n");
  writeFileSync(join(secondLayout.vault, "CORE.md"), "beta\n");
  writeFileSync(join(firstLayout.integrations, "google.json"), "google-101\n");
  writeFileSync(join(secondLayout.integrations, "google.json"), "google-202\n");

  const registry = await readUserRegistry(controlDir);
  assert.deepEqual(resolveTenant(update(101, 1), registry), {
    kind: "active",
    userId: "101",
    port: 8800,
  });
  assert.deepEqual(resolveTenant(update(202, 2), registry), {
    kind: "active",
    userId: "202",
    port: 8801,
  });
  assert.notEqual(
    workerRoutes(first).acceptance,
    workerRoutes(second).acceptance,
  );
  assert.equal(
    resolveTenant(
      {
        ...update(101, 3),
        message: {
          ...update(101, 3).message,
          chat: { id: 202, type: "private" },
        },
      },
      registry,
    ).kind,
    "unknown",
  );

  const firstWorker = await prepareWorker({
    userId: "101",
    expectedPort: "8800",
    appRoot,
    controlDir,
    usersDir,
    sourceEnv: {},
  });
  const secondWorker = await prepareWorker({
    userId: "202",
    expectedPort: "8801",
    appRoot,
    controlDir,
    usersDir,
    sourceEnv: {},
  });
  assert.notEqual(firstWorker.cwd, secondWorker.cwd);
  assert.notEqual(firstWorker.env.HOME, secondWorker.env.HOME);
  assert.notEqual(
    firstWorker.env.ASSISTANT_VAULT_DIR,
    secondWorker.env.ASSISTANT_VAULT_DIR,
  );

  const previousMulti = process.env.ASSISTANT_MULTI_USER;
  const previousRoot = process.env.ASSISTANT_PERSONAL_ROOT;
  process.env.ASSISTANT_MULTI_USER = "1";
  process.env.ASSISTANT_PERSONAL_ROOT = firstLayout.root;
  try {
    assert.equal(
      readFileSync(resolvePersonalReadPath("vault/CORE.md"), "utf8"),
      "alpha\n",
    );
    assert.throws(
      () => resolvePersonalReadPath("../202/vault/CORE.md"),
      /personal root/u,
    );
  } finally {
    if (previousMulti === undefined) delete process.env.ASSISTANT_MULTI_USER;
    else process.env.ASSISTANT_MULTI_USER = previousMulti;
    if (previousRoot === undefined) delete process.env.ASSISTANT_PERSONAL_ROOT;
    else process.env.ASSISTANT_PERSONAL_ROOT = previousRoot;
  }

  const firstLimits = { ...first.limits, requestsPerHour: 1 };
  assert.equal(
    (
      await chargeUserIngress(controlDir, first.id, firstLimits, {
        ingressId: "1",
      })
    ).allowed,
    true,
  );
  assert.equal(
    (
      await chargeUserIngress(controlDir, first.id, firstLimits, {
        ingressId: "2",
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await chargeUserIngress(controlDir, second.id, second.limits, {
        ingressId: "1",
      })
    ).allowed,
    true,
  );

  await setUserStatus(controlDir, first.id, "blocked");
  const restartedRegistry = await readUserRegistry(controlDir);
  assert.equal(
    resolveTenant(update(101, 4), restartedRegistry).kind,
    "blocked",
  );
  assert.equal(resolveTenant(update(202, 5), restartedRegistry).kind, "active");
  assert.equal(
    readFileSync(join(secondLayout.integrations, "google.json"), "utf8"),
    "google-202\n",
  );
});
