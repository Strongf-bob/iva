import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { addUser } from "../lib/user-registry.ts";
import { ensureUserLayout, resolveUserLayout } from "../lib/user-layout.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

void test("writeUnits creates active workers, removes exact stale workers, and retains rollback unit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-systemd-workers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const units = join(root, "units");
  const data = join(root, "data");
  const control = join(data, "control");
  const users = join(data, "users");
  mkdirSync(join(root, ".output"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "deploy"));
  mkdirSync(units);
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, ".env"), "ASSISTANT_DATA_DIR=data\n");
  writeFileSync(join(units, "iva-worker-999.service"), "stale\n");
  writeFileSync(join(units, "unrelated-worker-999.service"), "keep\n");

  const active = await addUser(control, { id: "123", role: "owner" });
  await addUser(control, { id: "456", role: "user", status: "blocked" });
  ensureUserLayout(resolveUserLayout(users, active.id), root);

  const base = createCliRuntime(root);
  const lifecycle = createCliSystemd({
    ...base,
    UNIT_DIR: units,
    hasSystemd: () => false,
    readEnv: () => ({
      ASSISTANT_DATA_DIR: "data",
      ASSISTANT_TIMEZONE: "UTC",
    }),
  });
  const written = lifecycle.writeUnits({ ensureBearer: false });

  assert.ok(written.includes("iva-worker-123.service"));
  assert.deepEqual(lifecycle.managedServices(), [
    "iva-telegram-poll.service",
    "iva-worker-123.service",
  ]);
  assert.equal(existsSync(join(units, "iva-worker-999.service")), false);
  assert.equal(existsSync(join(units, "unrelated-worker-999.service")), true);
  assert.equal(existsSync(join(units, "iva-worker-456.service")), false);
  assert.equal(existsSync(join(units, "iva.service")), true);
  assert.match(
    readFileSync(join(units, "iva-worker-123.service"), "utf8"),
    /IVA_WORKER_USER_ID=123/u,
  );
});
