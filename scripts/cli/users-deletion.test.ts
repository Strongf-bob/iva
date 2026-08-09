import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureUserLayout, resolveUserLayout } from "../lib/user-layout.ts";
import { addUser, readUserRegistry, removeUser } from "../lib/user-registry.ts";
import {
  createUsersCommandDependencies,
  createUsersCommands,
} from "./users.ts";

void test("delete resumes the same quarantine transaction after registry removal fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iva-delete-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const control = join(data, "control");
  const users = join(data, "users");
  await Promise.all([
    mkdir(join(root, ".output")),
    mkdir(join(root, "node_modules")),
    mkdir(join(root, "scripts")),
    writeFile(join(root, "package.json"), "{}\n"),
  ]);
  const user = await addUser(control, { id: "101", role: "user" });
  ensureUserLayout(resolveUserLayout(users, user.id), root);
  const base = createUsersCommandDependencies(
    {
      ROOT: root,
      dataDirAbs: () => data,
      ok: () => undefined,
      readEnv: () => ({}),
    },
    {
      startWorker: () => undefined,
      stopWorker: () => undefined,
      workerStatus: () => "stopped",
      retireLegacyService: () => undefined,
      restoreLegacyService: () => undefined,
      pauseGateway: () => undefined,
      resumeGateway: () => undefined,
    },
  );
  let first = true;
  const command = createUsersCommands({
    ...base,
    removeUser: async (...args) => {
      if (first) {
        first = false;
        throw new Error("injected registry failure");
      }
      return removeUser(...args);
    },
  });

  await assert.rejects(
    () => command.cmdUsers(["delete", "101", "--confirm", "101"]),
    /injected registry failure/u,
  );
  assert.equal(existsSync(join(users, "101")), false);
  assert.equal(
    existsSync(join(control, "delete-transactions", "101.json")),
    true,
  );

  await command.cmdUsers(["delete", "101", "--confirm", "101"]);
  assert.equal((await readUserRegistry(control)).users.length, 0);
  assert.equal(
    existsSync(join(control, "delete-transactions", "101.json")),
    false,
  );
});
