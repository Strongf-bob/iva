import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import {
  addUser as defaultAddUser,
  parseTelegramUserId,
  readUserRegistry as defaultReadUserRegistry,
  removeUser as defaultRemoveUser,
  setUserStatus as defaultSetUserStatus,
  updateUserLimits as defaultUpdateUserLimits,
  type TelegramUserId,
  type UserLimits,
  type UserRecord,
  type UserRegistry,
} from "../lib/user-registry.ts";
import {
  ensureUserLayout as defaultEnsureUserLayout,
  resolveUserLayout as defaultResolveUserLayout,
  verifyUserLayout as defaultVerifyUserLayout,
  type UserLayout,
} from "../lib/user-layout.ts";
import type { createCliRuntime } from "./runtime.ts";

export type UsersCommandDependencies = {
  readonly appRoot: string;
  readonly controlDir: string;
  readonly usersDir: string;
  readonly readRegistry: (controlDir: string) => Promise<UserRegistry>;
  readonly addUser: typeof defaultAddUser;
  readonly setUserStatus: typeof defaultSetUserStatus;
  readonly updateUserLimits: typeof defaultUpdateUserLimits;
  readonly removeUser: typeof defaultRemoveUser;
  readonly resolveUserLayout: typeof defaultResolveUserLayout;
  readonly ensureUserLayout: typeof defaultEnsureUserLayout;
  readonly verifyUserLayout: typeof defaultVerifyUserLayout;
  readonly workerHealth: (user: UserRecord) => Promise<void>;
  readonly startWorker: (user: UserRecord) => Promise<void>;
  readonly stopWorker: (user: UserRecord) => Promise<void>;
  readonly workerStatus?: (user: UserRecord) => Promise<string>;
  readonly quarantineUser: (layout: UserLayout, id: TelegramUserId) => string;
  readonly print: (line: string) => void;
};

type CliRuntime = Pick<
  ReturnType<typeof createCliRuntime>,
  "ROOT" | "dataDirAbs" | "ok"
>;
type WorkerLifecycle = {
  startWorker: (user: UserRecord) => void;
  stopWorker: (user: UserRecord) => void;
  workerStatus: (user: UserRecord) => string;
};

const LIMIT_FLAGS: Readonly<
  Record<string, { key: keyof UserLimits; multiplier: number }>
> = {
  "--concurrent-turns": { key: "concurrentTurns", multiplier: 1 },
  "--requests-hour": { key: "requestsPerHour", multiplier: 1 },
  "--requests-day": { key: "requestsPerDay", multiplier: 1 },
  "--tokens-day": { key: "llmTokensPerDay", multiplier: 1 },
  "--audio-minutes-day": { key: "audioSecondsPerDay", multiplier: 60 },
  "--attachment-mb": { key: "attachmentBytes", multiplier: 1024 * 1024 },
  "--storage-mb": { key: "storageBytes", multiplier: 1024 * 1024 },
};

function requireId(raw: string | undefined): TelegramUserId {
  const id = parseTelegramUserId(raw);
  if (!id)
    throw new Error("Telegram ID must be a canonical positive decimal string");
  return id;
}

function requireNoTail(tail: readonly string[]): void {
  if (tail.length) throw new Error(`unexpected users argument: ${tail[0]}`);
}

function limitsPatch(args: readonly string[]): Partial<UserLimits> {
  if (!args.length) throw new Error("at least one limit flag is required");
  const patch: Partial<UserLimits> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const option = LIMIT_FLAGS[flag];
    if (!option) throw new Error(`unknown user limit flag: ${flag}`);
    const raw = args[index + 1];
    if (!raw || !/^[1-9][0-9]*$/u.test(raw)) {
      throw new Error(`${flag} must be a positive integer`);
    }
    const value = Number(raw) * option.multiplier;
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${flag} is too large`);
    }
    patch[option.key] = value;
  }
  return patch;
}

function renderUser(user: UserRecord, health: string): string {
  const limits = user.limits;
  return [
    `${user.id} ${user.role} ${user.status} port=${user.port}`,
    `health=${health}`,
    `requests=${limits.requestsPerHour}/hour,${limits.requestsPerDay}/day`,
    `tokens=${limits.llmTokensPerDay}/day`,
    `audio=${Math.floor(limits.audioSecondsPerDay / 60)}min/day`,
    `attachment=${Math.floor(limits.attachmentBytes / 1024 / 1024)}MB`,
    `storage=${Math.floor(limits.storageBytes / 1024 / 1024)}MB`,
  ].join(" ");
}

function defaultQuarantine(
  quarantineDir: string,
  now: Date,
  layout: UserLayout,
  id: TelegramUserId,
): string {
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  chmodSync(quarantineDir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const base = join(quarantineDir, `user-${id}-${stamp}`);
  let destination = base;
  for (let collision = 1; existsSync(destination); collision += 1) {
    destination = `${base}-${collision}`;
  }
  chmodSync(layout.root, 0o700);
  renameSync(layout.root, destination);
  return destination;
}

export function createUsersCommandDependencies(
  runtime: CliRuntime,
  lifecycle?: WorkerLifecycle,
): UsersCommandDependencies {
  const dataDir = runtime.dataDirAbs();
  const quarantineDir = join(dataDir, "quarantine");
  return {
    appRoot: runtime.ROOT,
    controlDir: join(dataDir, "control"),
    usersDir: join(dataDir, "users"),
    readRegistry: defaultReadUserRegistry,
    addUser: defaultAddUser,
    setUserStatus: defaultSetUserStatus,
    updateUserLimits: defaultUpdateUserLimits,
    removeUser: defaultRemoveUser,
    resolveUserLayout: defaultResolveUserLayout,
    ensureUserLayout: defaultEnsureUserLayout,
    verifyUserLayout: defaultVerifyUserLayout,
    // Task 4 replaces these static preparation seams with exact systemd lifecycle checks.
    workerHealth: () => Promise.resolve(),
    startWorker: (user) => {
      lifecycle?.startWorker(user);
      return Promise.resolve();
    },
    stopWorker: (user) => {
      lifecycle?.stopWorker(user);
      return Promise.resolve();
    },
    workerStatus: (user) =>
      Promise.resolve(lifecycle?.workerStatus(user) ?? "not-managed"),
    quarantineUser: (layout, id) =>
      defaultQuarantine(quarantineDir, new Date(), layout, id),
    print: runtime.ok,
  };
}

export function createUsersCommands(dependencies: UsersCommandDependencies) {
  const deps = dependencies;

  async function findUser(id: TelegramUserId): Promise<UserRecord> {
    const registry = await deps.readRegistry(deps.controlDir);
    const user = registry.users.find((candidate) => candidate.id === id);
    if (!user) throw new Error(`Telegram user ${id} not found`);
    return user;
  }

  async function listUsers(): Promise<void> {
    const registry = await deps.readRegistry(deps.controlDir);
    if (!registry.users.length) {
      deps.print("No users configured");
      return;
    }
    const lines = await Promise.all(
      registry.users.map(async (user) =>
        renderUser(
          user,
          deps.workerStatus ? await deps.workerStatus(user) : "unknown",
        ),
      ),
    );
    deps.print(lines.join("\n"));
  }

  async function add(
    id: TelegramUserId,
    tail: readonly string[],
  ): Promise<void> {
    const owner = tail[0] === "--owner";
    requireNoTail(owner ? tail.slice(1) : tail);
    const candidate = await deps.addUser(deps.controlDir, {
      id,
      role: owner ? "owner" : "user",
      status: "blocked",
    });
    const layout = deps.resolveUserLayout(deps.usersDir, id);
    deps.ensureUserLayout(layout, deps.appRoot);
    deps.verifyUserLayout(layout, deps.appRoot);
    await deps.workerHealth(candidate);
    const active = await deps.setUserStatus(deps.controlDir, id, "active");
    try {
      await deps.startWorker(active);
    } catch (error) {
      const blocked = await deps.setUserStatus(deps.controlDir, id, "blocked");
      await deps.stopWorker(blocked).catch(() => undefined);
      throw error;
    }
    deps.print(`Added ${candidate.role} ${id}`);
  }

  async function block(id: TelegramUserId): Promise<void> {
    const user = await deps.setUserStatus(deps.controlDir, id, "blocked");
    await deps.stopWorker(user);
    deps.print(`Blocked user ${id}`);
  }

  async function unblock(id: TelegramUserId): Promise<void> {
    const user = await findUser(id);
    const layout = deps.resolveUserLayout(deps.usersDir, id);
    deps.verifyUserLayout(layout, deps.appRoot);
    await deps.workerHealth(user);
    const active = await deps.setUserStatus(deps.controlDir, id, "active");
    try {
      await deps.startWorker(active);
    } catch (error) {
      const blocked = await deps.setUserStatus(deps.controlDir, id, "blocked");
      await deps.stopWorker(blocked).catch(() => undefined);
      throw error;
    }
    deps.print(`Unblocked user ${id}`);
  }

  async function remove(
    id: TelegramUserId,
    tail: readonly string[],
  ): Promise<void> {
    if (tail.length !== 2 || tail[0] !== "--confirm" || tail[1] !== id) {
      throw new Error("delete requires --confirm with the exact Telegram ID");
    }
    const user = await deps.setUserStatus(deps.controlDir, id, "blocked");
    await deps.stopWorker(user);
    const layout = deps.resolveUserLayout(deps.usersDir, id);
    deps.quarantineUser(layout, id);
    await deps.removeUser(deps.controlDir, id);
    deps.print(`Quarantined user ${id}`);
  }

  async function cmdUsers(args: readonly string[]): Promise<void> {
    const [verb = "list", rawId, ...tail] = args;
    if (verb === "list") {
      requireNoTail(args.slice(1));
      return listUsers();
    }
    const id = requireId(rawId);
    if (verb === "add") return add(id, tail);
    if (verb === "block") {
      requireNoTail(tail);
      return block(id);
    }
    if (verb === "unblock") {
      requireNoTail(tail);
      return unblock(id);
    }
    if (verb === "limits") {
      await deps.updateUserLimits(deps.controlDir, id, limitsPatch(tail));
      deps.print(`Updated limits for ${id}`);
      return;
    }
    if (verb === "delete") return remove(id, tail);
    throw new Error(`unknown users command: ${verb}`);
  }

  return { cmdUsers };
}
