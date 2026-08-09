/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findGlobMatches, resolveGlobRoot } from "./glob.ts";

test("$VAULT resolves and searches the configured vault in both modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-glob-root-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "summaries", "daily"), { recursive: true });
  writeFileSync(join(vault, "summaries", "daily", "2026-08-09.md"), "ok");
  const old = {
    multiUser: process.env.ASSISTANT_MULTI_USER,
    personalRoot: process.env.ASSISTANT_PERSONAL_ROOT,
    vault: process.env.ASSISTANT_VAULT_DIR,
  };

  try {
    process.env.ASSISTANT_VAULT_DIR = vault;
    delete process.env.ASSISTANT_MULTI_USER;
    assert.equal(resolveGlobRoot("$VAULT"), realpathSync(vault));
    assert.deepEqual(await findGlobMatches("summaries/daily/*.md", "$VAULT"), [
      "summaries/daily/2026-08-09.md",
    ]);

    process.env.ASSISTANT_MULTI_USER = "1";
    process.env.ASSISTANT_PERSONAL_ROOT = root;
    assert.equal(resolveGlobRoot("$VAULT"), realpathSync(vault));
    assert.deepEqual(await findGlobMatches("summaries/daily/*.md", "$VAULT"), [
      "summaries/daily/2026-08-09.md",
    ]);
  } finally {
    if (old.multiUser === undefined) delete process.env.ASSISTANT_MULTI_USER;
    else process.env.ASSISTANT_MULTI_USER = old.multiUser;
    if (old.personalRoot === undefined)
      delete process.env.ASSISTANT_PERSONAL_ROOT;
    else process.env.ASSISTANT_PERSONAL_ROOT = old.personalRoot;
    if (old.vault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = old.vault;
    rmSync(root, { recursive: true, force: true });
  }
});
