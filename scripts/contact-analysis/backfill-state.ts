import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

import { assertContactMemoryPath } from "../../agent/lib/contact-memory-transaction.ts";
import { loadJsonStrict, saveJsonAtomic } from "../../agent/lib/json-store.ts";

const JobSchema = z.strictObject({
  chatId: z.int().positive(),
  title: z.string().min(1).max(500),
  highWaterId: z.int().nonnegative(),
  committedThrough: z.int().nonnegative(),
  contextSummary: z.string().max(4000),
  processedMessages: z.int().nonnegative(),
  status: z.enum(["ready", "running", "complete", "retry"]),
  lastErrorCode: z.string().min(1).max(100).nullable(),
});

const BackupFileSchema = z.strictObject({
  path: z.string().min(1),
  existed: z.boolean(),
  backupPath: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  size: z.int().nonnegative().nullable(),
  mode: z.int().nonnegative().max(0o777).nullable(),
});

export const BackfillManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountUserId: z.int().positive(),
  runId: z.string().min(1).max(100),
  createdAt: z.iso.datetime({ offset: true }),
  files: z.array(BackupFileSchema),
});
export type BackfillManifest = z.infer<typeof BackfillManifestSchema>;

export const BackfillStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountUserId: z.int().positive(),
  runId: z.string().min(1).max(100),
  phase: z.enum(["inventory", "running", "complete", "failed", "rolled_back"]),
  backupManifest: BackfillManifestSchema.nullable(),
  jobs: z.record(z.string().regex(/^[1-9]\d*$/u), JobSchema),
});
export type BackfillState = z.infer<typeof BackfillStateSchema>;

export interface BackfillPaths {
  accountDir: string;
  stateFile: string;
}

export function backfillPaths(
  root: string,
  dataDir: string,
  accountUserId: number,
): BackfillPaths {
  if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0)
    throw new TypeError("accountUserId must be a safe positive integer");
  const dataRoot = isAbsolute(dataDir) ? dataDir : join(root, dataDir);
  const accountDir = resolve(
    dataRoot,
    "contact-analysis",
    `telegram-user-${accountUserId}`,
    "private-backfill",
  );
  return { accountDir, stateFile: join(accountDir, "state.json") };
}

export async function loadBackfillState(
  paths: BackfillPaths,
): Promise<BackfillState | null> {
  const raw = await loadJsonStrict<unknown>(paths.stateFile, null);
  if (raw === null) return null;
  return BackfillStateSchema.parse(raw);
}

export async function saveBackfillState(
  paths: BackfillPaths,
  state: BackfillState,
): Promise<void> {
  const parsed = BackfillStateSchema.parse(state);
  await mkdir(paths.accountDir, { recursive: true, mode: 0o700 });
  await chmod(paths.accountDir, 0o700);
  await saveJsonAtomic(paths.stateFile, parsed);
  await chmod(paths.stateFile, 0o600);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeBackupPath(backupDir: string, path: string): string {
  const target = resolve(backupDir, path);
  const root = resolve(backupDir);
  if (!target.startsWith(`${root}${sep}`))
    throw new Error("backup path is outside backup directory");
  return target;
}

function assertBackupLocation(vault: string, backupDir: string): void {
  const root = resolve(vault);
  const backup = resolve(backupDir);
  if (backup === root || backup.startsWith(`${root}${sep}`))
    throw new Error("backup directory must be outside the vault");
}

export async function createBackfillBackup(input: {
  vault: string;
  backupDir: string;
  accountUserId: number;
  runId: string;
  files: readonly string[];
}): Promise<BackfillManifest> {
  assertBackupLocation(input.vault, input.backupDir);
  await mkdir(input.vault, { recursive: true, mode: 0o700 });
  await mkdir(input.backupDir, { recursive: true, mode: 0o700 });
  await chmod(input.backupDir, 0o700);
  const files = [];
  for (const [index, file] of [...new Set(input.files)].sort().entries()) {
    const path = assertContactMemoryPath(input.vault, file);
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw new Error("backup source must not be a symlink");
    const backupPath = `files/${String(index).padStart(6, "0")}.bin`;
    if (!existsSync(file)) {
      files.push({
        path,
        existed: false,
        backupPath,
        sha256: null,
        size: null,
        mode: null,
      });
      continue;
    }
    const source = await readFile(file);
    const sourceStat = await stat(file);
    const destination = safeBackupPath(input.backupDir, backupPath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(file, destination);
    await chmod(destination, 0o600);
    files.push({
      path,
      existed: true,
      backupPath,
      sha256: sha256(source),
      size: source.length,
      mode: sourceStat.mode & 0o777,
    });
  }
  const manifest = BackfillManifestSchema.parse({
    schemaVersion: 1,
    accountUserId: input.accountUserId,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    files,
  });
  await saveJsonAtomic(join(input.backupDir, "manifest.json"), manifest);
  await chmod(join(input.backupDir, "manifest.json"), 0o600);
  return manifest;
}

export async function verifyBackfillBackup(input: {
  vault: string;
  backupDir: string;
  manifest: BackfillManifest;
}): Promise<void> {
  assertBackupLocation(input.vault, input.backupDir);
  const manifest = BackfillManifestSchema.parse(input.manifest);
  for (const item of manifest.files) {
    assertContactMemoryPath(input.vault, join(input.vault, item.path));
    if (!item.existed) continue;
    const content = await readFile(
      safeBackupPath(input.backupDir, item.backupPath),
    );
    if (content.length !== item.size || sha256(content) !== item.sha256)
      throw new Error(`backup hash mismatch for ${item.path}`);
  }
}

export async function restoreBackfillBackup(input: {
  vault: string;
  backupDir: string;
  manifest: BackfillManifest;
}): Promise<void> {
  await verifyBackfillBackup(input);
  for (const item of BackfillManifestSchema.parse(input.manifest).files) {
    const target = join(input.vault, item.path);
    assertContactMemoryPath(input.vault, target);
    if (!item.existed) {
      await rm(target, { force: true });
      continue;
    }
    const source = safeBackupPath(input.backupDir, item.backupPath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.restore-${process.pid}`;
    await copyFile(source, temporary);
    await chmod(temporary, item.mode ?? 0o600);
    await rename(temporary, target);
  }
}
