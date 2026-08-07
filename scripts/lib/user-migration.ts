import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  opendir,
  readFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { saveJsonAtomic } from "../../agent/lib/json-store.ts";
import {
  addUser,
  parseTelegramUserId,
  readUserRegistry,
  removeUser,
  type TelegramUserId,
} from "./user-registry.ts";
import {
  ensureUserLayout,
  resolveUserLayout,
  verifyUserLayout,
  type UserLayout,
} from "./user-layout.ts";

export type OwnerMigrationInput = {
  appRoot: string;
  dataDir: string;
  controlDir: string;
  usersDir: string;
  vaultDir: string;
  homeDir?: string;
  allowedUserIds: readonly string[];
  ownerId?: string;
  now?: Date;
};

export type OwnerMigrationEntry = {
  source: string;
  destination: string;
  backup: string;
  bytes: number;
  sha256: string;
  mode: number;
};

export type OwnerMigrationPlan = {
  schema: "iva-owner-migration/v1";
  ownerId: TelegramUserId;
  appRoot: string;
  controlDir: string;
  layout: UserLayout;
  backupDir: string;
  stateFile: string;
  entries: OwnerMigrationEntry[];
  createdAt: string;
};

const RESERVED_DATA_ROOTS = new Set([
  "control",
  "users",
  "quarantine",
  "migration-backups",
]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>)
    hash.update(chunk);
  return hash.digest("hex");
}

function inside(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

async function scanFiles(
  sourceRoot: string,
  destinationRoot: string,
  backupRoot: string,
  options: { excludeTop?: ReadonlySet<string> } = {},
): Promise<OwnerMigrationEntry[]> {
  if (!(await pathExists(sourceRoot))) return [];
  const rootInfo = await lstat(sourceRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error(
      `legacy migration source is not a real directory: ${sourceRoot}`,
    );

  const entries: OwnerMigrationEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const item of handle) {
      const source = join(directory, item.name);
      const rel = relative(sourceRoot, source);
      const first = rel.split(sep)[0];
      if (options.excludeTop?.has(first)) continue;
      const info = await lstat(source);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(source);
        continue;
      }
      if (!info.isFile()) continue;
      entries.push({
        source,
        destination: join(destinationRoot, rel),
        backup: join(backupRoot, rel),
        bytes: info.size,
        sha256: await sha256(source),
        mode: info.mode & 0o777,
      });
    }
  }
  await visit(sourceRoot);
  return entries;
}

function resolveOwner(input: OwnerMigrationInput): TelegramUserId {
  const explicit = parseTelegramUserId(input.ownerId);
  if (input.ownerId !== undefined && !explicit)
    throw new Error("explicit owner must be a canonical Telegram ID");
  if (explicit) return explicit;
  const allowed = [...new Set(input.allowedUserIds)]
    .map(parseTelegramUserId)
    .filter((id): id is TelegramUserId => id !== null);
  if (allowed.length !== 1)
    throw new Error(
      "migration requires an explicit owner when legacy access does not contain exactly one ID",
    );
  return allowed[0];
}

export async function planOwnerMigration(
  input: OwnerMigrationInput,
): Promise<OwnerMigrationPlan> {
  const ownerId = resolveOwner(input);
  const appRoot = resolve(input.appRoot);
  const dataDir = resolve(input.dataDir);
  const controlDir = resolve(input.controlDir);
  const usersDir = resolve(input.usersDir);
  const layout = resolveUserLayout(usersDir, ownerId);
  const now = input.now ?? new Date();
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupDir = join(dataDir, "migration-backups", `${stamp}-${ownerId}`);
  const sourceGroups = [
    {
      source: resolve(input.vaultDir),
      destination: layout.vault,
      backup: join(backupDir, "vault"),
    },
    {
      source: dataDir,
      destination: layout.data,
      backup: join(backupDir, "data"),
      excludeTop: RESERVED_DATA_ROOTS,
    },
    {
      source: join(appRoot, ".eve", ".workflow-data"),
      destination: layout.sessions,
      backup: join(backupDir, "sessions"),
    },
    {
      source: join(appRoot, ".workflow-data"),
      destination: join(layout.runtime, ".workflow-data"),
      backup: join(backupDir, "legacy-sessions"),
    },
    {
      source: join(resolve(input.homeDir ?? appRoot), ".config", "gws"),
      destination: join(layout.root, ".config", "gws"),
      backup: join(backupDir, "gws"),
    },
  ];
  const entries = (
    await Promise.all(
      sourceGroups.map((group) =>
        scanFiles(group.source, group.destination, group.backup, {
          excludeTop: group.excludeTop,
        }),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.source.localeCompare(right.source));
  return {
    schema: "iva-owner-migration/v1",
    ownerId,
    appRoot,
    controlDir,
    layout,
    backupDir,
    stateFile: join(controlDir, "migrations", "owner.json"),
    entries,
    createdAt: now.toISOString(),
  };
}

async function ensureSafeParent(base: string, target: string): Promise<void> {
  const parent = dirname(target);
  if (!inside(base, parent))
    throw new Error("migration destination escaped its root");
  const rel = relative(base, parent);
  let current = base;
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    if (await pathExists(current)) {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`unsafe migration destination parent: ${current}`);
    } else {
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700);
  }
}

async function copyVerified(
  entry: OwnerMigrationEntry,
  target: string,
  base: string,
): Promise<void> {
  await ensureSafeParent(base, target);
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`unsafe migration target: ${target}`);
    if (info.size !== entry.bytes || (await sha256(target)) !== entry.sha256)
      throw new Error(`migration target differs from legacy source: ${target}`);
    return;
  }
  await copyFile(entry.source, target, constants.COPYFILE_EXCL);
  await chmod(target, entry.mode & 0o700);
  if ((await sha256(target)) !== entry.sha256)
    throw new Error(`migration copy verification failed: ${target}`);
}

export async function verifyOwnerMigration(
  plan: OwnerMigrationPlan,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  for (const entry of plan.entries) {
    for (const [kind, path] of [
      ["destination", entry.destination],
      ["backup", entry.backup],
    ] as const) {
      try {
        const info = await lstat(path);
        if (
          info.isSymbolicLink() ||
          !info.isFile() ||
          info.size !== entry.bytes ||
          (await sha256(path)) !== entry.sha256
        )
          mismatches.push(`${kind}:${relative(plan.appRoot, path)}`);
      } catch {
        mismatches.push(`${kind}:${relative(plan.appRoot, path)}`);
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

async function verifyBackup(plan: OwnerMigrationPlan): Promise<string[]> {
  const mismatches: string[] = [];
  for (const entry of plan.entries) {
    try {
      const info = await lstat(entry.backup);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size !== entry.bytes ||
        (await sha256(entry.backup)) !== entry.sha256
      )
        mismatches.push(`backup:${relative(plan.appRoot, entry.backup)}`);
    } catch {
      mismatches.push(`backup:${relative(plan.appRoot, entry.backup)}`);
    }
  }
  return mismatches;
}

async function writePhase(
  plan: OwnerMigrationPlan,
  phase: "copied" | "switched" | "rolled-back",
): Promise<void> {
  await saveJsonAtomic(plan.stateFile, {
    schema: plan.schema,
    ownerId: plan.ownerId,
    phase,
    backupDir: plan.backupDir,
    manifest: join(plan.backupDir, "manifest.json"),
    updatedAt: new Date().toISOString(),
  });
  await chmod(plan.stateFile, 0o600);
}

export async function applyOwnerMigration(
  plan: OwnerMigrationPlan,
): Promise<void> {
  ensureUserLayout(plan.layout, plan.appRoot);
  await mkdir(plan.backupDir, { recursive: true, mode: 0o700 });
  await chmod(plan.backupDir, 0o700);
  for (const entry of plan.entries) {
    await copyVerified(entry, entry.destination, plan.layout.root);
    await copyVerified(entry, entry.backup, plan.backupDir);
  }
  await saveJsonAtomic(join(plan.backupDir, "manifest.json"), plan);
  await chmod(join(plan.backupDir, "manifest.json"), 0o600);
  const verification = await verifyOwnerMigration(plan);
  if (!verification.ok)
    throw new Error(
      `owner migration verification failed: ${verification.mismatches.join(", ")}`,
    );
  await writePhase(plan, "copied");

  const registry = await readUserRegistry(plan.controlDir);
  const existing = registry.users.find((user) => user.id === plan.ownerId);
  if (existing && existing.role !== "owner")
    throw new Error(
      `migration owner ${plan.ownerId} already exists with another role`,
    );
  if (!existing) {
    if (registry.users.length > 0)
      throw new Error("owner migration requires an empty registry");
    await addUser(plan.controlDir, {
      id: plan.ownerId,
      role: "owner",
      status: "provisioning",
      now: new Date(plan.createdAt),
    });
  }
  verifyUserLayout(plan.layout, plan.appRoot);
  await writePhase(plan, "switched");
}

export async function rollbackOwnerMigration(
  plan: OwnerMigrationPlan,
): Promise<void> {
  const mismatches = await verifyBackup(plan);
  if (mismatches.length)
    throw new Error(
      `cannot roll back without verified backup: ${mismatches.join(", ")}`,
    );
  const registry = await readUserRegistry(plan.controlDir);
  const existing = registry.users.find((user) => user.id === plan.ownerId);
  if (existing?.role === "owner")
    await removeUser(plan.controlDir, plan.ownerId);
  await writePhase(plan, "rolled-back");
}

export async function readOwnerMigrationPlan(
  manifestPath: string,
): Promise<OwnerMigrationPlan> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as OwnerMigrationPlan;
}
