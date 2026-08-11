/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "../../scripts/lib/ts-esm-hooks.ts";

const { runContactMemoryTransaction, withContactMemoryLock } =
  await import("./contact-memory-transaction.ts");
const { acquireLock } = await import("./card-store.ts");

test("a failed multi-file transaction restores every snapshot", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-transaction-"));
  const first = join(vault, "first.md");
  const second = join(vault, "second.md");
  await writeFile(first, "before\n");
  await assert.rejects(
    runContactMemoryTransaction(vault, [first, second], async () => {
      await writeFile(first, "after\n");
      await writeFile(second, "created\n");
      throw new Error("injected failure");
    }),
    /injected failure/u,
  );
  assert.equal(await readFile(first, "utf8"), "before\n");
  await assert.rejects(readFile(second, "utf8"), /ENOENT/u);
});

test("the next lock holder recovers a transaction left by a terminated process", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-transaction-"));
  const file = join(vault, "person.md");
  await writeFile(file, "partial\n");
  await writeFile(
    join(vault, ".contact-memory-transaction.json"),
    `${JSON.stringify({ version: 1, files: [{ path: "person.md", content: "before\n" }] })}\n`,
  );
  withContactMemoryLock(vault, () => undefined);
  assert.equal(await readFile(file, "utf8"), "before\n");
});

test("a new file cannot escape through a symlinked parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-transaction-"));
  const vault = join(root, "vault");
  const outside = join(root, "outside");
  await mkdir(vault);
  await mkdir(outside);
  await symlink(outside, join(vault, "cards"));
  await assert.rejects(
    runContactMemoryTransaction(
      vault,
      [join(vault, "cards", "contacts", "telegram-user-44.md")],
      () => undefined,
    ),
    /parent symlink points outside the vault/u,
  );
});

test("a live owner keeps an old global lock", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-transaction-"));
  const target = join(vault, ".contact-memory-global");
  const lock = `${target}.lock`;
  const release = acquireLock(target);
  try {
    const token = await readFile(lock, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    assert.throws(() => acquireLock(target, 50), /занята другим процессом/u);
    assert.equal(await readFile(lock, "utf8"), token);
  } finally {
    release();
  }
});
