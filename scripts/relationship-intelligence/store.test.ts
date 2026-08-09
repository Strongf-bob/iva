/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRegistry, mutateRegistry, relationshipPaths } from "./store.ts";
import type { Commitment } from "./types.ts";

function item(id: string): Commitment {
  return {
    id,
    text: id,
    direction: "unknown",
    contactIds: [],
    dueAt: null,
    status: "pending_suggestion",
    evidence: [
      {
        source: "owner",
        sourceId: `owner:${id}`,
        observedAt: "2026-08-09T12:00:00.000Z",
      },
    ],
    firstSeenAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    googleTask: null,
    confirmation: null,
  };
}

test("concurrent mutations serialize and keep private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-"));
  const paths = relationshipPaths(root, "data");
  const add = (commitment: Commitment) =>
    mutateRegistry(paths, (registry) => {
      registry.commitments.push(commitment);
      return true;
    });

  await Promise.all([
    add(item("RI-aaaaaaaaaaaaaaaa")),
    add(item("RI-bbbbbbbbbbbbbbbb")),
  ]);

  const registry = await loadRegistry(paths);
  assert.equal(registry.revision, 2);
  assert.deepEqual(registry.commitments.map(({ id }) => id).sort(), [
    "RI-aaaaaaaaaaaaaaaa",
    "RI-bbbbbbbbbbbbbbbb",
  ]);
  assert.equal((await stat(paths.baseDir)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.registry)).mode & 0o777, 0o600);
});

test("corrupt state fails closed without replacing it with an empty registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-"));
  const paths = relationshipPaths(root, "data");
  await mutateRegistry(paths, () => true);
  await writeFile(paths.registry, "broken");

  await assert.rejects(
    () => mutateRegistry(paths, () => true),
    /damaged|invalid relationship registry/u,
  );
  const files = await import("node:fs/promises").then(({ readdir }) =>
    readdir(paths.baseDir),
  );
  const backup = files.find((name) =>
    name.startsWith("commitments.json.corrupt-"),
  );
  assert.ok(backup);
  assert.equal(await readFile(join(paths.baseDir, backup), "utf8"), "broken");
});
