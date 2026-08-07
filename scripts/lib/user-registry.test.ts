import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  addUser,
  defaultUserLimits,
  parseTelegramUserId,
  readUserRegistry,
  removeUser,
  setUserStatus,
  updateUserLimits,
} from "./user-registry.ts";

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "iva-user-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "control");
}

void test("Telegram user ids are canonical positive decimal strings", () => {
  assert.equal(parseTelegramUserId("7"), "7");
  assert.equal(parseTelegramUserId("9007199254740993"), "9007199254740993");
  for (const invalid of [
    undefined,
    null,
    7,
    "",
    "0",
    "01",
    "+7",
    " 7",
    "7 ",
    "../7",
    "7/8",
    "123456789012345678901",
  ]) {
    assert.equal(parseTelegramUserId(invalid), null, String(invalid));
  }
});

void test("default limits match the approved multi-user policy", () => {
  assert.deepEqual(defaultUserLimits(), {
    concurrentTurns: 1,
    requestsPerHour: 30,
    requestsPerDay: 100,
    llmTokensPerDay: 500_000,
    audioSecondsPerDay: 30 * 60,
    attachmentBytes: 20 * 1024 * 1024,
    storageBytes: 1024 * 1024 * 1024,
  });
});

void test("registry serializes concurrent additions and keeps private file modes", async (t) => {
  const control = fixture(t);
  await Promise.all([
    addUser(control, {
      id: "101",
      role: "owner",
      now: new Date("2026-08-07T10:00:00.000Z"),
    }),
    addUser(control, {
      id: "202",
      role: "user",
      now: new Date("2026-08-07T10:00:01.000Z"),
    }),
  ]);

  const registry = await readUserRegistry(control);
  assert.equal(registry.schema, "iva-users/v1");
  assert.equal(registry.revision, 2);
  assert.deepEqual(
    registry.users.map(({ id, role, status }) => ({ id, role, status })),
    [
      { id: "101", role: "owner", status: "active" },
      { id: "202", role: "user", status: "active" },
    ],
  );
  assert.deepEqual(registry.users.map(({ port }) => port).sort(), [8800, 8801]);
  assert.equal(statSync(control).mode & 0o777, 0o700);
  assert.equal(statSync(join(control, "users.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(control, "users.json.lock")), false);
});

void test("registry permits at most ten active users and reuses a blocked slot", async (t) => {
  const control = fixture(t);
  for (let id = 1; id <= 10; id += 1) {
    await addUser(control, {
      id: String(id),
      role: id === 1 ? "owner" : "user",
    });
  }

  await assert.rejects(
    () => addUser(control, { id: "11", role: "user" }),
    /at most 10 active users/u,
  );
  await setUserStatus(control, parseTelegramUserId("10")!, "blocked");
  const added = await addUser(control, { id: "11", role: "user" });
  assert.equal(added.port, 8810);
  assert.equal(added.status, "active");
});

void test("registry can stage blocked users and remove only the requested record", async (t) => {
  const control = fixture(t);
  const staged = await addUser(control, {
    id: "101",
    role: "owner",
    status: "blocked",
  });
  await addUser(control, { id: "202", role: "user" });

  assert.equal(staged.status, "blocked");
  const removed = await removeUser(control, parseTelegramUserId("101")!);
  assert.equal(removed.id, "101");
  assert.deepEqual(
    (await readUserRegistry(control)).users.map((user) => user.id),
    ["202"],
  );
  await assert.rejects(
    () => removeUser(control, parseTelegramUserId("101")!),
    /not found/u,
  );
});

void test("registry rejects duplicate users, a second owner, and invalid limit patches", async (t) => {
  const control = fixture(t);
  await addUser(control, { id: "101", role: "owner" });
  await assert.rejects(
    () => addUser(control, { id: "101", role: "user" }),
    /already exists/u,
  );
  await assert.rejects(
    () => addUser(control, { id: "202", role: "owner" }),
    /owner already exists/u,
  );
  await assert.rejects(
    () =>
      updateUserLimits(control, parseTelegramUserId("101")!, {
        requestsPerDay: 0,
      }),
    /positive integer/u,
  );
});

void test("registry rejects corrupt and unknown persisted schemas without overwriting", async (t) => {
  const control = fixture(t);
  const file = join(control, "users.json");
  await addUser(control, { id: "101", role: "owner" });
  writeFileSync(
    file,
    JSON.stringify({ schema: "iva-users/v999", revision: 1, users: [] }),
  );

  await assert.rejects(
    () => readUserRegistry(control),
    /invalid user registry/u,
  );
  assert.match(readFileSync(file, "utf8"), /iva-users\/v999/u);
});
