import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readUserRegistry } from "./user-registry.ts";
import {
  applyOwnerMigration,
  planOwnerMigration,
  rollbackOwnerMigration,
  verifyOwnerMigration,
} from "./user-migration.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const appRoot = mkdtempSync(join(tmpdir(), "iva-owner-migration-"));
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  for (const path of [".output", "node_modules", "scripts"])
    mkdirSync(join(appRoot, path), { recursive: true });
  writeFileSync(join(appRoot, "package.json"), "{}\n");
  mkdirSync(join(appRoot, "vault", "daily"), { recursive: true });
  writeFileSync(join(appRoot, "vault", "CORE.md"), "owner memory\n");
  writeFileSync(join(appRoot, "vault", "daily", "2026-08-07.md"), "day\n");
  mkdirSync(join(appRoot, "data"), { recursive: true });
  writeFileSync(join(appRoot, "data", "settings.json"), '{"language":"ru"}\n');
  mkdirSync(join(appRoot, ".eve", ".workflow-data"), { recursive: true });
  writeFileSync(join(appRoot, ".eve", ".workflow-data", "session.json"), "{}\n");
  mkdirSync(join(appRoot, "home", ".config", "gws"), { recursive: true });
  writeFileSync(
    join(appRoot, "home", ".config", "gws", "credentials.json"),
    "google-owner\n",
  );
  return {
    appRoot,
    dataDir: join(appRoot, "data"),
    controlDir: join(appRoot, "data", "control"),
    usersDir: join(appRoot, "data", "users"),
    vaultDir: join(appRoot, "vault"),
    homeDir: join(appRoot, "home"),
    allowedUserIds: ["123"],
    now: new Date("2026-08-07T12:00:00.000Z"),
  };
}

void test("legacy owner migration copies, hashes, switches atomically, and keeps rollback evidence", async (t) => {
  const input = fixture(t);
  const plan = await planOwnerMigration(input);
  await applyOwnerMigration(plan);

  assert.deepEqual(await verifyOwnerMigration(plan), {
    ok: true,
    mismatches: [],
  });
  const registry = await readUserRegistry(input.controlDir);
  assert.equal(registry.users.length, 1);
  assert.equal(registry.users[0].id, "123");
  assert.equal(registry.users[0].role, "owner");
  assert.equal(existsSync(plan.backupDir), true);
  assert.equal(
    readFileSync(join(plan.layout.vault, "CORE.md"), "utf8"),
    "owner memory\n",
  );
  assert.equal(
    readFileSync(join(plan.layout.data, "settings.json"), "utf8"),
    '{"language":"ru"}\n',
  );
  assert.equal(
    readFileSync(join(plan.layout.root, ".config/gws/credentials.json"), "utf8"),
    "google-owner\n",
  );

  await applyOwnerMigration(plan);
  assert.equal((await readUserRegistry(input.controlDir)).users.length, 1);
  writeFileSync(join(plan.layout.vault, "CORE.md"), "new owner memory\n");
  await rollbackOwnerMigration(plan);
  assert.equal((await readUserRegistry(input.controlDir)).users.length, 0);
  assert.equal(existsSync(plan.backupDir), true);
});

void test("migration refuses zero or multiple legacy ids before writes", async (t) => {
  const input = fixture(t);
  for (const allowedUserIds of [[], ["1", "2"]]) {
    await assert.rejects(
      () => planOwnerMigration({ ...input, allowedUserIds }),
      /explicit owner/u,
    );
  }
  assert.equal(existsSync(input.controlDir), false);
  assert.equal(existsSync(input.usersDir), false);
});
