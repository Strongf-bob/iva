import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";

export const USER_REGISTRY_SCHEMA = "iva-users/v1" as const;
const MAX_ACTIVE_USERS = 10;
const DEFAULT_WORKER_PORT_BASE = 8800;
const LEGACY_WORKER_PORT = 8723;

export type TelegramUserId = string & {
  readonly __telegramUserId: unique symbol;
};

export type UserLimits = {
  concurrentTurns: number;
  requestsPerHour: number;
  requestsPerDay: number;
  llmTokensPerDay: number;
  audioSecondsPerDay: number;
  attachmentBytes: number;
  storageBytes: number;
};

export type UserRecord = {
  id: TelegramUserId;
  role: "owner" | "user";
  status: "active" | "blocked" | "provisioning";
  port: number;
  limits: UserLimits;
  createdAt: string;
};

export type UserRegistry = {
  schema: typeof USER_REGISTRY_SCHEMA;
  revision: number;
  users: UserRecord[];
};

const TelegramUserIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/u)
  .transform((value) => value as TelegramUserId);
const PositiveIntegerSchema = z.number().int().positive();
const UserLimitsSchema = z.strictObject({
  concurrentTurns: PositiveIntegerSchema,
  requestsPerHour: PositiveIntegerSchema,
  requestsPerDay: PositiveIntegerSchema,
  llmTokensPerDay: PositiveIntegerSchema,
  audioSecondsPerDay: PositiveIntegerSchema,
  attachmentBytes: PositiveIntegerSchema,
  storageBytes: PositiveIntegerSchema,
});
const UserRecordSchema = z.strictObject({
  id: TelegramUserIdSchema,
  role: z.enum(["owner", "user"]),
  status: z.enum(["active", "blocked", "provisioning"]),
  port: z.number().int().min(1).max(65_535),
  limits: UserLimitsSchema,
  createdAt: z.iso.datetime(),
});
const UserRegistrySchema = z
  .strictObject({
    schema: z.literal(USER_REGISTRY_SCHEMA),
    revision: z.number().int().nonnegative(),
    users: z.array(UserRecordSchema),
  })
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const ports = new Set<number>();
    let owners = 0;
    let provisioned = 0;
    for (const user of registry.users) {
      if (ids.has(user.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate Telegram user id: ${user.id}`,
          path: ["users"],
        });
      }
      if (ports.has(user.port)) {
        context.addIssue({
          code: "custom",
          message: `duplicate worker port: ${user.port}`,
          path: ["users"],
        });
      }
      ids.add(user.id);
      ports.add(user.port);
      if (user.role === "owner") owners += 1;
      if (user.status !== "blocked") provisioned += 1;
    }
    if (owners > 1) {
      context.addIssue({
        code: "custom",
        message: "registry may contain at most one owner",
        path: ["users"],
      });
    }
    if (provisioned > MAX_ACTIVE_USERS) {
      context.addIssue({
        code: "custom",
        message: `registry may contain at most ${MAX_ACTIVE_USERS} active users`,
        path: ["users"],
      });
    }
  });

const emptyRegistry = (): UserRegistry => ({
  schema: USER_REGISTRY_SCHEMA,
  revision: 0,
  users: [],
});

const registryFile = (controlDir: string): string =>
  join(controlDir, "users.json");
const registryLock = (controlDir: string): string =>
  join(controlDir, "users.json.lock");
const legacyOwnerRouteFile = (controlDir: string): string =>
  join(controlDir, "legacy-owner-route.json");

function ensurePrivateControlDir(controlDir: string): void {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  chmodSync(controlDir, 0o700);
}

function parseRegistry(value: unknown): UserRegistry {
  const parsed = UserRegistrySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid user registry: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function workerPortBase(): number {
  const configured = Number(process.env.IVA_WORKER_PORT_BASE);
  return Number.isInteger(configured) && configured >= 1 && configured <= 65_525
    ? configured
    : DEFAULT_WORKER_PORT_BASE;
}

function allocatePort(registry: UserRegistry): number {
  const used = new Set(registry.users.map((user) => user.port));
  for (let port = workerPortBase(); port <= 65_535; port += 1) {
    if (port !== LEGACY_WORKER_PORT && !used.has(port)) return port;
  }
  throw new Error("no worker ports available");
}

function sortUsers(users: UserRecord[]): void {
  users.sort((left, right) => {
    const a = BigInt(left.id);
    const b = BigInt(right.id);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function assertLimitPatch(patch: Partial<UserLimits>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaultUserLimits()))
      throw new Error(`unknown user limit: ${key}`);
    if (!Number.isInteger(value) || (value ?? 0) <= 0) {
      throw new Error(`user limit ${key} must be a positive integer`);
    }
  }
}

export function parseTelegramUserId(value: unknown): TelegramUserId | null {
  const parsed = TelegramUserIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultUserLimits(): UserLimits {
  return {
    concurrentTurns: 1,
    requestsPerHour: 30,
    requestsPerDay: 100,
    llmTokensPerDay: 500_000,
    audioSecondsPerDay: 30 * 60,
    attachmentBytes: 20 * 1024 * 1024,
    storageBytes: 1024 * 1024 * 1024,
  };
}

export async function readUserRegistry(
  controlDir: string,
): Promise<UserRegistry> {
  const value = await loadJsonStrict<unknown>(
    registryFile(controlDir),
    emptyRegistry(),
  );
  return parseRegistry(value);
}

export async function readRoutingUserRegistry(
  controlDir: string,
): Promise<UserRegistry> {
  const registry = await readUserRegistry(controlDir);
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(legacyOwnerRouteFile(controlDir), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return registry;
    if (error instanceof SyntaxError) {
      throw new Error(`invalid legacy owner route JSON: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
  const route = UserRecordSchema.parse(value);
  if (
    route.role !== "owner" ||
    route.status !== "active" ||
    route.port !== LEGACY_WORKER_PORT
  ) {
    throw new Error("invalid legacy owner route");
  }
  if (registry.users.some((user) => user.id === route.id)) return registry;
  return parseRegistry({
    ...registry,
    users: [...registry.users, route],
  });
}

export async function enableLegacyOwnerRoute(
  controlDir: string,
  user: UserRecord,
): Promise<void> {
  ensurePrivateControlDir(controlDir);
  const route = UserRecordSchema.parse({
    ...user,
    role: "owner",
    status: "active",
    port: LEGACY_WORKER_PORT,
  });
  await saveJsonAtomic(legacyOwnerRouteFile(controlDir), route);
  chmodSync(legacyOwnerRouteFile(controlDir), 0o600);
}

export async function disableLegacyOwnerRoute(
  controlDir: string,
): Promise<void> {
  await rm(legacyOwnerRouteFile(controlDir), { force: true });
}

export function isLegacyOwnerRoute(
  user: Pick<UserRecord, "role" | "status" | "port">,
): boolean {
  return (
    user.role === "owner" &&
    user.status === "active" &&
    user.port === LEGACY_WORKER_PORT
  );
}

export function readUserRegistrySync(controlDir: string): UserRegistry {
  try {
    return parseRegistry(
      JSON.parse(readFileSync(registryFile(controlDir), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyRegistry();
    if (error instanceof SyntaxError) {
      throw new Error(`invalid user registry JSON: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function mutateUserRegistry(
  controlDir: string,
  mutation: (registry: UserRegistry) => void,
): Promise<UserRegistry> {
  ensurePrivateControlDir(controlDir);
  const lockPath = registryLock(controlDir);
  const token = await acquireLock(lockPath);
  try {
    const current = await readUserRegistry(controlDir);
    const next = structuredClone(current);
    mutation(next);
    next.revision = current.revision + 1;
    sortUsers(next.users);
    const validated = parseRegistry(next);
    await saveJsonAtomic(registryFile(controlDir), validated);
    chmodSync(registryFile(controlDir), 0o600);
    return validated;
  } finally {
    releaseLock(lockPath, token);
  }
}

export async function addUser(
  controlDir: string,
  input: {
    id: string;
    role: "owner" | "user";
    status?: "active" | "blocked" | "provisioning";
    now?: Date;
  },
): Promise<UserRecord> {
  const id = parseTelegramUserId(input.id);
  if (!id)
    throw new Error("Telegram ID must be a canonical positive decimal string");
  const registry = await mutateUserRegistry(controlDir, (registry) => {
    if (registry.users.some((user) => user.id === id)) {
      throw new Error(`Telegram user ${id} already exists`);
    }
    if (
      input.role === "owner" &&
      registry.users.some((user) => user.role === "owner")
    ) {
      throw new Error("owner already exists");
    }
    const status = input.status ?? "active";
    if (
      status !== "blocked" &&
      registry.users.filter((user) => user.status !== "blocked").length >=
        MAX_ACTIVE_USERS
    ) {
      throw new Error(
        `registry supports at most ${MAX_ACTIVE_USERS} active users`,
      );
    }
    const added: UserRecord = {
      id,
      role: input.role,
      status,
      port: allocatePort(registry),
      limits: defaultUserLimits(),
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    registry.users.push(added);
  });
  return registry.users.find((user) => user.id === id)!;
}

export async function removeUser(
  controlDir: string,
  id: TelegramUserId,
): Promise<UserRecord> {
  let removed: UserRecord | undefined;
  await mutateUserRegistry(controlDir, (registry) => {
    const index = registry.users.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Telegram user ${id} not found`);
    [removed] = registry.users.splice(index, 1);
  });
  return removed!;
}

export async function setUserStatus(
  controlDir: string,
  id: TelegramUserId,
  status: "active" | "blocked" | "provisioning",
): Promise<UserRecord> {
  const registry = await mutateUserRegistry(controlDir, (registry) => {
    const user = registry.users.find((candidate) => candidate.id === id);
    if (!user) throw new Error(`Telegram user ${id} not found`);
    if (
      status !== "blocked" &&
      user.status === "blocked" &&
      registry.users.filter((candidate) => candidate.status !== "blocked")
        .length >= MAX_ACTIVE_USERS
    ) {
      throw new Error(
        `registry supports at most ${MAX_ACTIVE_USERS} active users`,
      );
    }
    user.status = status;
  });
  return registry.users.find((user) => user.id === id)!;
}

export async function updateUserLimits(
  controlDir: string,
  id: TelegramUserId,
  patch: Partial<UserLimits>,
): Promise<UserRecord> {
  assertLimitPatch(patch);
  const registry = await mutateUserRegistry(controlDir, (registry) => {
    const user = registry.users.find((candidate) => candidate.id === id);
    if (!user) throw new Error(`Telegram user ${id} not found`);
    user.limits = { ...user.limits, ...patch };
  });
  return registry.users.find((user) => user.id === id)!;
}
