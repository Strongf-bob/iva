import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
  addUser as defaultAddUser,
  disableLegacyOwnerRoute as defaultDisableLegacyOwnerRoute,
  enableLegacyOwnerRoute as defaultEnableLegacyOwnerRoute,
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
import {
  applyOwnerMigration,
  planOwnerMigration,
  rollbackOwnerMigration,
} from "../lib/user-migration.ts";
import { probeEveHealth } from "../lib/config-transaction.ts";
import { quarantineUserControlState } from "../lib/user-control-quarantine.ts";

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
  readonly quarantineControlState: (
    id: TelegramUserId,
    quarantineRoot: string,
  ) => Promise<void>;
  readonly finishQuarantine: (id: TelegramUserId) => void;
  readonly retireLegacyService: () => Promise<void>;
  readonly restoreLegacyService: () => Promise<void>;
  readonly legacyHealth: () => Promise<void>;
  readonly enableLegacyOwnerRoute: (user: UserRecord) => Promise<void>;
  readonly disableLegacyOwnerRoute: () => Promise<void>;
  readonly pauseGateway: () => Promise<void>;
  readonly resumeGateway: () => Promise<void>;
  readonly migrateOwner?: (explicitOwner?: string) => Promise<UserRecord>;
  readonly print: (line: string) => void;
};

type CliRuntime = Pick<
  ReturnType<typeof createCliRuntime>,
  "ROOT" | "dataDirAbs" | "ok" | "readEnv"
>;
type WorkerLifecycle = {
  startWorker: (user: UserRecord) => void;
  stopWorker: (user: UserRecord) => void;
  workerStatus: (user: UserRecord) => string;
  retireLegacyService: () => void;
  restoreLegacyService: () => void;
  pauseGateway: () => void;
  resumeGateway: () => void;
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
  controlDir: string,
  now: Date,
  layout: UserLayout,
  id: TelegramUserId,
): string {
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  chmodSync(quarantineDir, 0o700);
  const transaction = join(controlDir, "delete-transactions", `${id}.json`);
  let destination: string;
  if (existsSync(transaction)) {
    const parsed: unknown = JSON.parse(readFileSync(transaction, "utf8"));
    const candidate = (parsed as { destination?: unknown }).destination;
    if (typeof candidate !== "string")
      throw new Error(`invalid delete transaction for Telegram user ${id}`);
    destination = candidate;
    const rel = relative(resolve(quarantineDir), resolve(destination));
    if (!rel || rel.startsWith("..") || rel.includes("/../"))
      throw new Error(`invalid delete transaction for Telegram user ${id}`);
  } else {
    const stamp = now.toISOString().replace(/[:.]/gu, "-");
    const base = join(quarantineDir, `user-${id}-${stamp}`);
    destination = base;
    for (let collision = 1; existsSync(destination); collision += 1) {
      destination = `${base}-${collision}`;
    }
    mkdirSync(dirname(transaction), { recursive: true, mode: 0o700 });
    writeFileSync(transaction, `${JSON.stringify({ destination })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  if (existsSync(layout.root)) {
    if (existsSync(destination))
      throw new Error(
        `delete quarantine destination already exists: ${destination}`,
      );
    chmodSync(layout.root, 0o700);
    renameSync(layout.root, destination);
  } else if (!existsSync(destination)) {
    throw new Error(
      `user data is missing from both live and quarantine paths: ${id}`,
    );
  }
  return destination;
}

export function createUsersCommandDependencies(
  runtime: CliRuntime,
  lifecycle?: WorkerLifecycle,
): UsersCommandDependencies {
  const dataDir = runtime.dataDirAbs();
  const env = runtime.readEnv();
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
    workerHealth: (user) =>
      probeEveHealth(`http://127.0.0.1:${user.port}/eve/v1/health`),
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
      defaultQuarantine(
        quarantineDir,
        join(dataDir, "control"),
        new Date(),
        layout,
        id,
      ),
    quarantineControlState: (id, destination) =>
      quarantineUserControlState(
        dataDir,
        join(dataDir, "control"),
        id,
        destination,
      ),
    finishQuarantine: (id) =>
      rmSync(join(dataDir, "control", "delete-transactions", `${id}.json`), {
        force: true,
      }),
    retireLegacyService: () => {
      lifecycle?.retireLegacyService();
      return Promise.resolve();
    },
    restoreLegacyService: () => {
      lifecycle?.restoreLegacyService();
      return Promise.resolve();
    },
    legacyHealth: () => probeEveHealth("http://127.0.0.1:8723/eve/v1/health"),
    enableLegacyOwnerRoute: (user) =>
      defaultEnableLegacyOwnerRoute(join(dataDir, "control"), user),
    disableLegacyOwnerRoute: () =>
      defaultDisableLegacyOwnerRoute(join(dataDir, "control")),
    pauseGateway: () => {
      lifecycle?.pauseGateway();
      return Promise.resolve();
    },
    resumeGateway: () => {
      lifecycle?.resumeGateway();
      return Promise.resolve();
    },
    migrateOwner: async (explicitOwner) => {
      const plan = await planOwnerMigration({
        appRoot: runtime.ROOT,
        dataDir,
        controlDir: join(dataDir, "control"),
        usersDir: join(dataDir, "users"),
        vaultDir: env.ASSISTANT_VAULT_DIR?.startsWith("/")
          ? env.ASSISTANT_VAULT_DIR
          : join(runtime.ROOT, env.ASSISTANT_VAULT_DIR || "vault"),
        homeDir: homedir(),
        allowedUserIds: (env.TELEGRAM_ALLOWED_USER_IDS || "")
          .split(/[,\s]+/u)
          .filter(Boolean),
        ownerId: explicitOwner,
      });
      try {
        await applyOwnerMigration(plan);
      } catch (error) {
        await rollbackOwnerMigration(plan).catch(() => undefined);
        throw error;
      }
      const registry = await defaultReadUserRegistry(join(dataDir, "control"));
      return registry.users.find((user) => user.id === plan.ownerId)!;
    },
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
      status: "provisioning",
    });
    const layout = deps.resolveUserLayout(deps.usersDir, id);
    deps.ensureUserLayout(layout, deps.appRoot);
    deps.verifyUserLayout(layout, deps.appRoot);
    try {
      await deps.startWorker(candidate);
      await deps.workerHealth(candidate);
      await deps.setUserStatus(deps.controlDir, id, "active");
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
    await findUser(id);
    const layout = deps.resolveUserLayout(deps.usersDir, id);
    deps.verifyUserLayout(layout, deps.appRoot);
    const provisioning = await deps.setUserStatus(
      deps.controlDir,
      id,
      "provisioning",
    );
    try {
      await deps.startWorker(provisioning);
      await deps.workerHealth(provisioning);
      await deps.setUserStatus(deps.controlDir, id, "active");
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
    await deps.pauseGateway();
    try {
      const layout = deps.resolveUserLayout(deps.usersDir, id);
      const destination = deps.quarantineUser(layout, id);
      await deps.quarantineControlState(id, destination);
      await deps.removeUser(deps.controlDir, id);
      deps.finishQuarantine(id);
    } finally {
      await deps.resumeGateway();
    }
    deps.print(`Quarantined user ${id}`);
  }

  async function cmdUsers(args: readonly string[]): Promise<void> {
    const [verb = "list", rawId, ...tail] = args;
    if (verb === "list") {
      requireNoTail(args.slice(1));
      return listUsers();
    }
    if (verb === "migrate-owner") {
      requireNoTail(tail);
      if (!deps.migrateOwner) throw new Error("owner migration is unavailable");
      await deps.pauseGateway();
      let owner: UserRecord | null = null;
      let resumeGateway = false;
      try {
        owner = await deps.migrateOwner(rawId);
        const provisioning = await deps.setUserStatus(
          deps.controlDir,
          owner.id,
          "provisioning",
        );
        await deps.retireLegacyService();
        await deps.startWorker(provisioning);
        await deps.workerHealth(provisioning);
        await deps.setUserStatus(deps.controlDir, owner.id, "active");
        await deps.disableLegacyOwnerRoute();
        resumeGateway = true;
      } catch (error) {
        if (owner) {
          const blocked = await deps.setUserStatus(
            deps.controlDir,
            owner.id,
            "blocked",
          );
          await deps.stopWorker(blocked);
          await deps.removeUser(deps.controlDir, owner.id);
          await deps.restoreLegacyService();
          await deps.legacyHealth();
          await deps.enableLegacyOwnerRoute(owner);
          resumeGateway = true;
        }
        throw error;
      } finally {
        if (resumeGateway) await deps.resumeGateway();
      }
      if (!owner) throw new Error("owner migration did not produce a user");
      deps.print(`Migrated legacy owner ${owner.id}; rollback backup retained`);
      return;
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
