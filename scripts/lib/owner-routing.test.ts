import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  reconcileTelegramOwnerRoute,
  requireActiveTelegramOwner,
} from "./owner-routing.ts";
import {
  addUser,
  enableLegacyOwnerRoute,
  readRoutingUserRegistry,
  removeUser,
} from "./user-registry.ts";

function fixture(t: { after: (fn: () => Promise<void>) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "iva-owner-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "control");
}

void test("an empty single-owner installation creates one private legacy route idempotently", async (t) => {
  const controlDir = fixture(t);
  const created = await reconcileTelegramOwnerRoute({
    controlDir,
    allowedUserIds: new Set(["101"]),
    now: new Date("2026-08-09T18:00:00.000Z"),
  });

  assert.equal(created.outcome, "created");
  assert.deepEqual(
    (await readRoutingUserRegistry(controlDir)).users.map(
      ({ id, role, status, port, createdAt }) => ({
        id,
        role,
        status,
        port,
        createdAt,
      }),
    ),
    [
      {
        id: "101",
        role: "owner",
        status: "active",
        port: 8723,
        createdAt: "2026-08-09T18:00:00.000Z",
      },
    ],
  );
  assert.equal(
    (
      await reconcileTelegramOwnerRoute({
        controlDir,
        allowedUserIds: new Set(["101"]),
      })
    ).outcome,
    "preserved",
  );
  assert.equal((await requireActiveTelegramOwner(controlDir)).id, "101");
});

void test("ambiguous allowlists fail without creating routing state", async (t) => {
  for (const allowedUserIds of [
    new Set<string>(),
    new Set(["101", "202"]),
    new Set(["not-a-telegram-id"]),
  ]) {
    const controlDir = fixture(t);
    await assert.rejects(
      () =>
        reconcileTelegramOwnerRoute({
          controlDir,
          allowedUserIds,
        }),
      /exactly one canonical Telegram owner ID/u,
    );
    assert.equal(existsSync(controlDir), false);
  }
});

void test("a non-empty registry without an owner fails closed", async (t) => {
  const controlDir = fixture(t);
  await addUser(controlDir, { id: "202", role: "user" });

  await assert.rejects(
    () =>
      reconcileTelegramOwnerRoute({
        controlDir,
        allowedUserIds: new Set(["101"]),
      }),
    /registry contains users but no owner/u,
  );
  assert.equal((await readRoutingUserRegistry(controlDir)).users.length, 1);
});

void test("an inactive persisted owner fails closed", async (t) => {
  for (const status of ["blocked", "provisioning"] as const) {
    const controlDir = fixture(t);
    await addUser(controlDir, { id: "101", role: "owner", status });

    await assert.rejects(
      () =>
        reconcileTelegramOwnerRoute({
          controlDir,
          allowedUserIds: new Set(["101"]),
        }),
      /exactly one active owner/u,
    );
  }
});

void test("an active personalized owner and registered users are preserved", async (t) => {
  const controlDir = fixture(t);
  const owner = await addUser(controlDir, { id: "101", role: "owner" });
  await addUser(controlDir, { id: "202", role: "user" });

  const result = await reconcileTelegramOwnerRoute({
    controlDir,
    allowedUserIds: new Set(["999"]),
  });

  assert.equal(result.outcome, "preserved");
  assert.equal(result.owner.id, owner.id);
  assert.equal(result.owner.port, owner.port);
  assert.deepEqual(
    (await readRoutingUserRegistry(controlDir)).users.map((user) => user.id),
    ["101", "202"],
  );
});

void test("an existing active legacy owner route is preserved", async (t) => {
  const controlDir = fixture(t);
  const owner = await addUser(controlDir, { id: "101", role: "owner" });
  await removeUser(controlDir, owner.id);
  await enableLegacyOwnerRoute(controlDir, owner);

  const result = await reconcileTelegramOwnerRoute({
    controlDir,
    allowedUserIds: new Set(["999"]),
  });

  assert.equal(result.outcome, "preserved");
  assert.equal(result.owner.id, "101");
  assert.equal(result.owner.port, 8723);
});
