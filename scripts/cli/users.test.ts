import assert from "node:assert/strict";
import { test } from "node:test";

import { createUsersCommands, type UsersCommandDependencies } from "./users.ts";
import {
  defaultUserLimits,
  parseTelegramUserId,
  type UserRecord,
} from "../lib/user-registry.ts";

const id = parseTelegramUserId("123")!;
const record = (status: "active" | "blocked" = "active"): UserRecord => ({
  id,
  role: "owner",
  status,
  port: 8800,
  limits: defaultUserLimits(),
  createdAt: "2026-08-07T10:00:00.000Z",
});

function fixture(
  calls: string[],
  overrides: Partial<UsersCommandDependencies> = {},
): UsersCommandDependencies {
  return {
    appRoot: "/srv/iva",
    controlDir: "/srv/iva/data/control",
    usersDir: "/srv/iva/data/users",
    readRegistry: () =>
      Promise.resolve({
        schema: "iva-users/v1",
        revision: 1,
        users: [record()],
      }),
    addUser: (_control, input) => {
      calls.push(`registry:add-${input.status}:${input.id}`);
      return Promise.resolve(record(input.status));
    },
    setUserStatus: (_control, userId, status) => {
      calls.push(`registry:${status}:${userId}`);
      return Promise.resolve(record(status));
    },
    updateUserLimits: (_control, userId, patch) => {
      calls.push(`limits:${userId}:${JSON.stringify(patch)}`);
      return Promise.resolve({
        ...record(),
        limits: { ...record().limits, ...patch },
      });
    },
    removeUser: (_control, userId) => {
      calls.push(`registry:remove:${userId}`);
      return Promise.resolve(record("blocked"));
    },
    resolveUserLayout: (_users, userId) => ({
      root: `/srv/iva/data/users/${userId}`,
      vault: `/srv/iva/data/users/${userId}/vault`,
      runtime: `/srv/iva/data/users/${userId}/runtime`,
      data: `/srv/iva/data/users/${userId}/runtime/data`,
      sessions: `/srv/iva/data/users/${userId}/runtime/.eve/.workflow-data`,
      integrations: `/srv/iva/data/users/${userId}/integrations`,
      usage: `/srv/iva/data/users/${userId}/usage`,
    }),
    ensureUserLayout: (layout) => calls.push(`layout:${layout.root}`),
    verifyUserLayout: (layout) => calls.push(`verify:${layout.root}`),
    workerHealth: (user) => {
      calls.push(`worker-health:${user.id}`);
      return Promise.resolve();
    },
    stopWorker: (user) => {
      calls.push(`worker-stop:${user.id}`);
      return Promise.resolve();
    },
    quarantineUser: (layout, userId) => {
      calls.push(`quarantine:${layout.root}:${userId}`);
      return `/srv/iva/data/quarantine/user-${userId}-stamp`;
    },
    print: (line) => calls.push(`print:${line}`),
    ...overrides,
  };
}

void test("add creates a blocked candidate and activates only after layout health", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(fixture(calls));

  await command.cmdUsers(["add", "123", "--owner"]);

  assert.deepEqual(calls, [
    "registry:add-blocked:123",
    "layout:/srv/iva/data/users/123",
    "verify:/srv/iva/data/users/123",
    "worker-health:123",
    "registry:active:123",
    "print:Added owner 123",
  ]);
});

void test("add remains blocked when layout or worker preparation fails", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(
    fixture(calls, {
      workerHealth: () => {
        calls.push("worker-health:123");
        return Promise.reject(new Error("worker failed"));
      },
    }),
  );

  await assert.rejects(
    () => command.cmdUsers(["add", "123"]),
    /worker failed/u,
  );
  assert.doesNotMatch(calls.join("\n"), /registry:active/u);
});

void test("delete requires the exact repeated id and never starts mutation on mismatch", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(fixture(calls));

  await assert.rejects(
    () => command.cmdUsers(["delete", "123", "--confirm", "321"]),
    /exact Telegram ID/u,
  );
  assert.deepEqual(calls, []);
});

void test("delete blocks, stops, quarantines, and only then removes the record", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(fixture(calls));

  await command.cmdUsers(["delete", "123", "--confirm", "123"]);

  assert.deepEqual(calls, [
    "registry:blocked:123",
    "worker-stop:123",
    "quarantine:/srv/iva/data/users/123:123",
    "registry:remove:123",
    "print:Quarantined user 123",
  ]);
});

void test("limits accepts positive integer flags and converts megabytes and minutes", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(fixture(calls));

  await command.cmdUsers([
    "limits",
    "123",
    "--requests-day",
    "42",
    "--tokens-day",
    "9000",
    "--audio-minutes-day",
    "12",
    "--attachment-mb",
    "8",
    "--storage-mb",
    "256",
  ]);

  assert.deepEqual(calls, [
    `limits:123:${JSON.stringify({
      requestsPerDay: 42,
      llmTokensPerDay: 9000,
      audioSecondsPerDay: 720,
      attachmentBytes: 8 * 1024 * 1024,
      storageBytes: 256 * 1024 * 1024,
    })}`,
    "print:Updated limits for 123",
  ]);
});

void test("list prints control-plane fields without personal paths", async () => {
  const calls: string[] = [];
  const command = createUsersCommands(fixture(calls));

  await command.cmdUsers(["list"]);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /123 owner active port=8800/u);
  assert.doesNotMatch(calls[0], /\/srv\/|vault|runtime/u);
});
