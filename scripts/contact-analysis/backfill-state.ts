import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

import { assertContactMemoryPath } from "../../agent/lib/contact-memory-transaction.ts";
import { loadJsonStrict, saveJsonAtomic } from "../../agent/lib/json-store.ts";
import { ContactAnalysisStateSchema } from "./state.ts";

const JobSchema = z.strictObject({
  chatId: z.int().positive(),
  title: z.string().min(1).max(500),
  username: z.string().min(1).max(64).nullable(),
  highWaterId: z.int().nonnegative(),
  committedThrough: z.int().nonnegative(),
  contextSummary: z.string().max(4000),
  processedMessages: z.int().nonnegative(),
  status: z.enum(["ready", "running", "complete", "retry"]),
  lastErrorCode: z.string().min(1).max(100).nullable(),
});

const FrozenDialogSchema = z.strictObject({
  id: z.int().positive(),
  title: z.string().min(1).max(500),
  username: z.string().min(1).max(64).nullable(),
});

const BackupFileSchema = z.strictObject({
  path: z.string().min(1),
  existed: z.boolean(),
  backupPath: z.string().regex(/^files\/\d{6}\.bin$/u),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  size: z.int().nonnegative().nullable(),
  mode: z.int().nonnegative().max(0o777).nullable(),
  mutationRecorded: z.boolean(),
  postExisted: z.boolean().nullable(),
  postSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  postSize: z.int().nonnegative().nullable(),
});

export const BackfillManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountUserId: z.int().positive(),
  runId: z.string().min(1).max(100),
  createdAt: z.iso.datetime({ offset: true }),
  files: z.array(BackupFileSchema),
});
export type BackfillManifest = z.infer<typeof BackfillManifestSchema>;

export const BackfillStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    accountUserId: z.int().positive(),
    runId: z.string().min(1).max(100),
    phase: z.enum([
      "inventory",
      "running",
      "complete",
      "failed",
      "rolled_back",
    ]),
    vaultDir: z.string().min(1).refine(isAbsolute),
    backupDir: z.string().min(1).refine(isAbsolute),
    backupReady: z.boolean(),
    inventoryComplete: z.boolean(),
    incrementalHandoffComplete: z.boolean(),
    incrementalStateBefore: ContactAnalysisStateSchema,
    inventory: z.array(FrozenDialogSchema),
    jobs: z.record(z.string().regex(/^[1-9]\d*$/u), JobSchema),
  })
  .superRefine((state, context) => {
    const inventoryIds = state.inventory.map((dialog) => String(dialog.id));
    const inventoryById = new Map(
      state.inventory.map((dialog) => [String(dialog.id), dialog]),
    );
    if (new Set(inventoryIds).size !== inventoryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["inventory"],
        message: "frozen inventory contains duplicate dialogs",
      });
    }
    for (const [key, job] of Object.entries(state.jobs)) {
      if (key !== String(job.chatId)) {
        context.addIssue({
          code: "custom",
          path: ["jobs", key],
          message: "job key does not match chatId",
        });
      }
      if (job.committedThrough > job.highWaterId) {
        context.addIssue({
          code: "custom",
          path: ["jobs", key, "committedThrough"],
          message: "job cursor exceeds high-water",
        });
      }
      const frozen = inventoryById.get(key);
      if (
        !frozen ||
        frozen.title !== job.title ||
        frozen.username !== job.username
      ) {
        context.addIssue({
          code: "custom",
          path: ["jobs", key],
          message: "job does not match frozen inventory",
        });
      }
    }
    if (state.backupReady && !state.inventoryComplete) {
      context.addIssue({
        code: "custom",
        path: ["backupReady"],
        message: "backup cannot precede completed inventory",
      });
    }
    if (state.inventoryComplete) {
      const jobIds = Object.keys(state.jobs);
      if (inventoryIds.sort().join("\n") !== jobIds.sort().join("\n")) {
        context.addIssue({
          code: "custom",
          path: ["inventory"],
          message: "frozen inventory does not match jobs",
        });
      }
    }
    if (state.phase === "complete") {
      if (
        !state.inventoryComplete ||
        !state.backupReady ||
        !state.incrementalHandoffComplete ||
        Object.values(state.jobs).some((job) => job.status !== "complete")
      ) {
        context.addIssue({
          code: "custom",
          path: ["phase"],
          message: "complete run has unfinished state",
        });
      }
    }
  });
export type BackfillState = z.infer<typeof BackfillStateSchema>;

export interface BackfillPaths {
  accountUserId: number;
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
  return {
    accountUserId,
    accountDir,
    stateFile: join(accountDir, "state.json"),
  };
}

export async function loadBackfillState(
  paths: BackfillPaths,
): Promise<BackfillState | null> {
  const raw = await loadJsonStrict<unknown>(paths.stateFile, null);
  if (raw === null) return null;
  const parsed = BackfillStateSchema.parse(raw);
  if (parsed.accountUserId !== paths.accountUserId)
    throw new Error("telegram_private_backfill_state_account_mismatch");
  return parsed;
}

export async function saveBackfillState(
  paths: BackfillPaths,
  state: BackfillState,
): Promise<void> {
  const parsed = BackfillStateSchema.parse(state);
  if (parsed.accountUserId !== paths.accountUserId)
    throw new Error("telegram_private_backfill_state_account_mismatch");
  await mkdir(paths.accountDir, { recursive: true, mode: 0o700 });
  await chmod(paths.accountDir, 0o700);
  await saveJsonAtomic(paths.stateFile, parsed);
  await chmod(paths.stateFile, 0o600);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

async function assertBackupLocation(
  root: string,
  vault: string,
  backupDir: string,
): Promise<void> {
  if (!isAbsolute(backupDir))
    throw new Error("backup directory must be absolute");
  const lexicalBackup = resolve(backupDir);
  const lexicalRoot = resolve(root);
  const lexicalVault = resolve(vault);
  if (isWithin(lexicalRoot, lexicalBackup))
    throw new Error("backup directory must be outside the application root");
  if (isWithin(lexicalVault, lexicalBackup))
    throw new Error("backup directory must be outside the vault");

  await mkdir(root, { recursive: true });
  await mkdir(vault, { recursive: true, mode: 0o700 });
  if (existsSync(backupDir) && (await lstat(backupDir)).isSymbolicLink())
    throw new Error("backup directory must not be a symlink");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700);
  const [actualRoot, actualVault, actualBackup] = await Promise.all([
    realpath(root),
    realpath(vault),
    realpath(backupDir),
  ]);
  if (isWithin(actualRoot, actualBackup))
    throw new Error("backup directory must be outside the application root");
  if (isWithin(actualVault, actualBackup))
    throw new Error("backup directory must be outside the vault");

  const filesDir = join(backupDir, "files");
  if (existsSync(filesDir) && (await lstat(filesDir)).isSymbolicLink())
    throw new Error("backup files directory must not be a symlink");
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  await chmod(filesDir, 0o700);
  const actualFiles = await realpath(filesDir);
  if (!isWithin(actualBackup, actualFiles))
    throw new Error("backup files directory escapes the backup root");
}

async function safeBackupFile(
  root: string,
  vault: string,
  backupDir: string,
  backupPath: string,
): Promise<string> {
  await assertBackupLocation(root, vault, backupDir);
  const target = resolve(backupDir, backupPath);
  if (!isWithin(resolve(backupDir), target))
    throw new Error("backup path is outside backup directory");
  const actualParent = await realpath(dirname(target));
  const actualBackup = await realpath(backupDir);
  if (!isWithin(actualBackup, actualParent))
    throw new Error("backup path parent escapes backup directory");
  if (existsSync(target) && (await lstat(target)).isSymbolicLink())
    throw new Error("backup file must not be a symlink");
  return target;
}

async function fileSnapshot(file: string): Promise<{
  existed: boolean;
  sha256: string | null;
  size: number | null;
  mode: number | null;
}> {
  if (!existsSync(file))
    return { existed: false, sha256: null, size: null, mode: null };
  const info = await lstat(file);
  if (info.isSymbolicLink())
    throw new Error("backup source must not be a symlink");
  if (!info.isFile()) throw new Error("backup source must be a regular file");
  const content = await readFile(file);
  return {
    existed: true,
    sha256: sha256(content),
    size: content.length,
    mode: info.mode & 0o777,
  };
}

async function persistManifest(
  backupDir: string,
  manifest: BackfillManifest,
): Promise<void> {
  const path = join(backupDir, "manifest.json");
  if (existsSync(path) && (await lstat(path)).isSymbolicLink())
    throw new Error("backup manifest must not be a symlink");
  await saveJsonAtomic(path, BackfillManifestSchema.parse(manifest));
  await chmod(path, 0o600);
}

export async function loadBackfillManifest(
  backupDir: string,
): Promise<BackfillManifest> {
  const path = join(backupDir, "manifest.json");
  if (existsSync(path) && (await lstat(path)).isSymbolicLink())
    throw new Error("backup manifest must not be a symlink");
  const raw = await loadJsonStrict<unknown>(path, null);
  if (raw === null)
    throw new Error("telegram_private_backfill_manifest_missing");
  return BackfillManifestSchema.parse(raw);
}

export async function ensureBackfillBackupFiles(input: {
  root: string;
  vault: string;
  backupDir: string;
  manifest: BackfillManifest;
  files: readonly string[];
}): Promise<BackfillManifest> {
  await verifyBackfillBackup(input);
  const manifest = structuredClone(
    BackfillManifestSchema.parse(input.manifest),
  );
  const known = new Map(manifest.files.map((item) => [item.path, item]));
  for (const file of [...new Set(input.files)].sort()) {
    const path = assertContactMemoryPath(input.vault, file);
    const snapshot = await fileSnapshot(file);
    const existing = known.get(path);
    if (existing) {
      const matchesBefore = matchesSnapshot(snapshot, existing);
      const matchesAfter =
        existing.mutationRecorded &&
        existing.postExisted !== null &&
        matchesSnapshot(snapshot, {
          existed: existing.postExisted,
          sha256: existing.postSha256,
          size: existing.postSize,
        });
      if (!matchesBefore && !matchesAfter)
        throw new Error("telegram_private_backfill_concurrent_edit");
      if (matchesBefore && existing.mutationRecorded) {
        existing.mutationRecorded = false;
        existing.postExisted = null;
        existing.postSha256 = null;
        existing.postSize = null;
      }
      continue;
    }
    const backupPath = `files/${String(manifest.files.length).padStart(6, "0")}.bin`;
    if (snapshot.existed) {
      const destination = await safeBackupFile(
        input.root,
        input.vault,
        input.backupDir,
        backupPath,
      );
      await copyFile(file, destination);
      await chmod(destination, 0o600);
    }
    manifest.files.push({
      path,
      ...snapshot,
      backupPath,
      mutationRecorded: false,
      postExisted: null,
      postSha256: null,
      postSize: null,
    });
    known.set(path, manifest.files.at(-1)!);
  }
  await persistManifest(input.backupDir, manifest);
  return manifest;
}

export async function createBackfillBackup(input: {
  root: string;
  vault: string;
  backupDir: string;
  accountUserId: number;
  runId: string;
  files: readonly string[];
}): Promise<BackfillManifest> {
  const existed = existsSync(input.backupDir);
  const priorEntries = existed ? await readdir(input.backupDir) : [];
  await assertBackupLocation(input.root, input.vault, input.backupDir);
  if (existsSync(join(input.backupDir, "manifest.json"))) {
    const existing = await loadBackfillManifest(input.backupDir);
    if (
      existing.accountUserId !== input.accountUserId ||
      existing.runId !== input.runId
    )
      throw new Error("telegram_private_backfill_backup_identity_mismatch");
    return ensureBackfillBackupFiles({ ...input, manifest: existing });
  }
  if (priorEntries.length > 0)
    throw new Error("telegram_private_backfill_backup_directory_not_empty");
  const manifest = BackfillManifestSchema.parse({
    schemaVersion: 1,
    accountUserId: input.accountUserId,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    files: [],
  });
  await persistManifest(input.backupDir, manifest);
  return ensureBackfillBackupFiles({ ...input, manifest });
}

export async function verifyBackfillBackup(input: {
  root: string;
  vault: string;
  backupDir: string;
  manifest: BackfillManifest;
}): Promise<void> {
  await assertBackupLocation(input.root, input.vault, input.backupDir);
  const manifest = BackfillManifestSchema.parse(input.manifest);
  for (const item of manifest.files) {
    assertContactMemoryPath(input.vault, join(input.vault, item.path));
    if (!item.existed) continue;
    const content = await readFile(
      await safeBackupFile(
        input.root,
        input.vault,
        input.backupDir,
        item.backupPath,
      ),
    );
    if (content.length !== item.size || sha256(content) !== item.sha256)
      throw new Error(`backup hash mismatch for ${item.path}`);
  }
}

export async function recordBackfillPostimages(input: {
  root: string;
  vault: string;
  backupDir: string;
  manifest: BackfillManifest;
  files: readonly string[];
}): Promise<BackfillManifest> {
  await verifyBackfillBackup(input);
  const manifest = structuredClone(
    BackfillManifestSchema.parse(input.manifest),
  );
  const byPath = new Map(manifest.files.map((item) => [item.path, item]));
  for (const file of [...new Set(input.files)].sort()) {
    const path = assertContactMemoryPath(input.vault, file);
    const item = byPath.get(path);
    if (!item) throw new Error("backfill postimage was not backed up");
    const snapshot = await fileSnapshot(file);
    item.mutationRecorded = true;
    item.postExisted = snapshot.existed;
    item.postSha256 = snapshot.sha256;
    item.postSize = snapshot.size;
  }
  await persistManifest(input.backupDir, manifest);
  return manifest;
}

function matchesSnapshot(
  snapshot: Awaited<ReturnType<typeof fileSnapshot>>,
  expected: {
    existed: boolean;
    sha256: string | null;
    size: number | null;
  },
): boolean {
  return (
    snapshot.existed === expected.existed &&
    snapshot.sha256 === expected.sha256 &&
    snapshot.size === expected.size
  );
}

export async function restoreBackfillBackup(input: {
  root: string;
  vault: string;
  backupDir: string;
  manifest: BackfillManifest;
}): Promise<void> {
  await verifyBackfillBackup(input);
  const manifest = BackfillManifestSchema.parse(input.manifest);
  for (const item of manifest.files) {
    if (!item.mutationRecorded) continue;
    const target = join(input.vault, item.path);
    assertContactMemoryPath(input.vault, target);
    const current = await fileSnapshot(target);
    const matchesBefore = matchesSnapshot(current, item);
    const matchesAfter =
      item.mutationRecorded &&
      item.postExisted !== null &&
      matchesSnapshot(current, {
        existed: item.postExisted,
        sha256: item.postSha256,
        size: item.postSize,
      });
    if (!matchesBefore && !matchesAfter)
      throw new Error(`rollback conflict for ${item.path}`);
  }

  for (const item of manifest.files) {
    if (!item.mutationRecorded) continue;
    const target = join(input.vault, item.path);
    if (!item.existed) {
      await rm(target, { force: true });
      continue;
    }
    const source = await safeBackupFile(
      input.root,
      input.vault,
      input.backupDir,
      item.backupPath,
    );
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.restore-${process.pid}-${randomUUID()}`;
    await copyFile(source, temporary);
    await chmod(temporary, item.mode ?? 0o600);
    await rename(temporary, target);
  }
}
