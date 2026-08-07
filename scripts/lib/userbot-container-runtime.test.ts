import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  disableContainerUserbot,
  enableContainerUserbot,
  readUserbotCredentials,
  userbotRuntimePaths,
  writeUserbotCredentials,
} from "./userbot-container-runtime.ts";

void test("container credentials and token are private and marker lifecycle is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-userbot-container-"));
  const paths = userbotRuntimePaths(root);

  await writeUserbotCredentials(root, "12345", "abcdef123456");

  assert.deepEqual(await readUserbotCredentials(root), {
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "abcdef123456",
  });
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.credentials)).mode & 0o777, 0o600);

  await enableContainerUserbot(root);
  const firstToken = await readFile(paths.token, "utf8");
  assert.match(firstToken, /^[A-Za-z0-9_-]{40,}\n$/u);
  assert.equal((await stat(paths.token)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.enabled)).mode & 0o777, 0o600);

  await enableContainerUserbot(root);
  assert.equal(await readFile(paths.token, "utf8"), firstToken);

  await disableContainerUserbot(root);
  await assert.rejects(stat(paths.enabled), { code: "ENOENT" });
  await disableContainerUserbot(root);
});

void test("container credential validation fails before writing secret material", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-userbot-invalid-"));
  const paths = userbotRuntimePaths(root);
  const secret = "should-never-be-written";

  await assert.rejects(
    writeUserbotCredentials(root, "not-a-number", secret),
    /api_id must be numeric/u,
  );
  await assert.rejects(stat(paths.credentials), { code: "ENOENT" });

  await assert.rejects(
    writeUserbotCredentials(root, "12345", "has whitespace"),
    /api_hash is invalid/u,
  );
  await assert.rejects(stat(paths.credentials), { code: "ENOENT" });
});

void test("missing container credentials read as an empty record", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-userbot-missing-"));
  assert.deepEqual(await readUserbotCredentials(root), {});
});
