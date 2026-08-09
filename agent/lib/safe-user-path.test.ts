import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  multiUserMode,
  resolvePersonalReadPath,
  resolvePersonalWritePath,
} from "./safe-user-path.ts";

void test("multi-user paths reject absolute, traversal, and symlink escapes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-safe-user-"));
  const other = mkdtempSync(join(tmpdir(), "iva-safe-other-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  mkdirSync(join(root, "vault"));
  writeFileSync(join(root, "vault", "CORE.md"), "private\n");
  writeFileSync(join(other, "secret"), "other user\n");
  symlinkSync(other, join(root, "vault", "escape"));

  const oldMode = process.env.ASSISTANT_MULTI_USER;
  const oldRoot = process.env.ASSISTANT_PERSONAL_ROOT;
  process.env.ASSISTANT_MULTI_USER = "1";
  process.env.ASSISTANT_PERSONAL_ROOT = root;
  try {
    assert.equal(multiUserMode(), true);
    assert.equal(
      resolvePersonalReadPath("CORE.md", join(root, "vault")),
      realpathSync(join(root, "vault", "CORE.md")),
    );
    assert.throws(
      () => resolvePersonalReadPath("/etc/passwd", join(root, "vault")),
      /relative path/u,
    );
    assert.throws(
      () => resolvePersonalReadPath("../../other", join(root, "vault")),
      /personal root/u,
    );
    assert.throws(
      () => resolvePersonalReadPath("escape/secret", join(root, "vault")),
      /symlink|personal root/u,
    );
    assert.throws(
      () => resolvePersonalWritePath("escape/new.md", join(root, "vault")),
      /symlink|personal root/u,
    );
  } finally {
    if (oldMode === undefined) delete process.env.ASSISTANT_MULTI_USER;
    else process.env.ASSISTANT_MULTI_USER = oldMode;
    if (oldRoot === undefined) delete process.env.ASSISTANT_PERSONAL_ROOT;
    else process.env.ASSISTANT_PERSONAL_ROOT = oldRoot;
  }
});
