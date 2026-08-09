import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { parseTelegramUserId } from "./user-registry.ts";
import {
  ensureUserLayout,
  resolveUserLayout,
  verifyUserLayout,
} from "./user-layout.ts";

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "iva-user-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "app");
  for (const name of [".output", "node_modules", "scripts"]) {
    mkdirSync(join(appRoot, name), { recursive: true });
  }
  writeFileSync(join(appRoot, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(appRoot, ".env"), "SECRET=never-link-this\n");
  return { root, appRoot, usersDir: join(root, "data", "users") };
}

void test("layout resolves every personal path under the canonical user root", (t) => {
  const { usersDir } = fixture(t);
  const id = parseTelegramUserId("123")!;
  const layout = resolveUserLayout(usersDir, id);
  assert.deepEqual(layout, {
    root: resolve(usersDir, "123"),
    vault: resolve(usersDir, "123", "vault"),
    runtime: resolve(usersDir, "123", "runtime"),
    data: resolve(usersDir, "123", "runtime", "data"),
    sessions: resolve(usersDir, "123", "runtime", ".eve", ".workflow-data"),
    integrations: resolve(usersDir, "123", "integrations"),
    usage: resolve(usersDir, "123", "usage"),
  });
});

void test("ensure creates private personal directories and only approved runtime links", (t) => {
  const { appRoot, usersDir } = fixture(t);
  const layout = resolveUserLayout(usersDir, parseTelegramUserId("123")!);
  ensureUserLayout(layout, appRoot);
  verifyUserLayout(layout, appRoot);

  for (const path of [
    layout.root,
    layout.vault,
    layout.runtime,
    layout.data,
    layout.sessions,
    layout.integrations,
    layout.usage,
  ]) {
    assert.equal(statSync(path).isDirectory(), true, path);
    assert.equal(statSync(path).mode & 0o777, 0o700, path);
  }

  for (const name of [".output", "node_modules", "scripts", "package.json"]) {
    const link = join(layout.runtime, name);
    assert.equal(lstatSync(link).isSymbolicLink(), true, link);
    assert.equal(
      resolve(layout.runtime, readlinkSync(link)),
      join(appRoot, name),
    );
  }
  assert.throws(() => lstatSync(join(layout.runtime, ".env")), {
    code: "ENOENT",
  });

  ensureUserLayout(layout, appRoot);
  verifyUserLayout(layout, appRoot);
});

void test("ensure refuses a symlink in any personal directory", (t) => {
  const { root, appRoot, usersDir } = fixture(t);
  const layout = resolveUserLayout(usersDir, parseTelegramUserId("123")!);
  const outside = join(root, "outside");
  mkdirSync(outside);
  mkdirSync(layout.root, { recursive: true });
  symlinkSync(outside, layout.vault, "dir");

  assert.throws(
    () => ensureUserLayout(layout, appRoot),
    /personal directory must not be a symbolic link/u,
  );
});

void test("verify refuses a runtime link redirected to another app", async (t) => {
  const { root, appRoot, usersDir } = fixture(t);
  const layout = resolveUserLayout(usersDir, parseTelegramUserId("123")!);
  ensureUserLayout(layout, appRoot);
  const other = join(root, "other-output");
  mkdirSync(other);
  await rm(join(layout.runtime, ".output"));
  symlinkSync(other, join(layout.runtime, ".output"), "dir");

  assert.throws(
    () => verifyUserLayout(layout, appRoot),
    /runtime link has an unexpected target/u,
  );
});
