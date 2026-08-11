import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import "./lib/ts-esm-hooks.ts";
import type {
  ContactAnalysisReport,
  RunContactAnalysisOptions,
} from "./contact-analysis/coordinator.ts";
import type {
  PrivateBackfillReport,
  RunPrivateContactBackfillOptions,
} from "./contact-analysis/backfill.ts";
import { loadState, statePaths } from "./contact-analysis/state.ts";

export interface ContactAnalysisStatus {
  accounts: number;
  completedChats: number;
  pendingChats: number;
  failedChats: number;
}

export interface PrivateBackfillStatus {
  accounts: number;
  runs: number;
  running: number;
  complete: number;
  failed: number;
}

export async function readPrivateBackfillStatus(
  root: string,
  dataDir = process.env.ASSISTANT_DATA_DIR ?? "data",
): Promise<PrivateBackfillStatus> {
  const { backfillPaths, loadBackfillState } =
    await import("./contact-analysis/backfill-state.ts");
  const resolvedDataDir = isAbsolute(dataDir) ? dataDir : join(root, dataDir);
  const base = join(resolvedDataDir, "contact-analysis");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { accounts: 0, runs: 0, running: 0, complete: 0, failed: 0 };
    throw error;
  }
  const states = await Promise.all(
    entries.flatMap((entry) => {
      const match = /^telegram-user-([1-9]\d*)$/u.exec(entry.name);
      return entry.isDirectory() && match
        ? [
            loadBackfillState(
              backfillPaths(root, resolvedDataDir, Number(match[1])),
            ),
          ]
        : [];
    }),
  );
  const present = states.filter((state) => state !== null);
  return {
    accounts: present.length,
    runs: present.length,
    running: present.filter((state) =>
      ["inventory", "running"].includes(state.phase),
    ).length,
    complete: present.filter((state) => state.phase === "complete").length,
    failed: present.filter((state) => state.phase === "failed").length,
  };
}

export async function rollbackPrivateBackfill(input: {
  root: string;
  dataDir: string;
  vault: string;
  backupDir: string;
}): Promise<void> {
  const {
    backfillPaths,
    loadBackfillManifest,
    loadBackfillState,
    restoreBackfillBackup,
    saveBackfillState,
  } = await import("./contact-analysis/backfill-state.ts");
  const manifest = await loadBackfillManifest(input.backupDir);
  await restoreBackfillBackup({
    vault: input.vault,
    backupDir: input.backupDir,
    manifest,
  });
  const paths = backfillPaths(
    input.root,
    input.dataDir,
    manifest.accountUserId,
  );
  const state = await loadBackfillState(paths);
  if (state?.runId === manifest.runId) {
    state.phase = "rolled_back";
    await saveBackfillState(paths, state);
  }
}

export async function readContactAnalysisStatus(
  root: string,
  dataDir = process.env.ASSISTANT_DATA_DIR ?? "data",
): Promise<ContactAnalysisStatus> {
  const resolvedDataDir = isAbsolute(dataDir) ? dataDir : join(root, dataDir);
  const base = join(resolvedDataDir, "contact-analysis");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        accounts: 0,
        completedChats: 0,
        pendingChats: 0,
        failedChats: 0,
      };
    }
    throw error;
  }
  const accountIds = entries.flatMap((entry) => {
    const match = /^telegram-user-([1-9]\d*)$/u.exec(entry.name);
    return entry.isDirectory() && match ? [Number(match[1])] : [];
  });
  const states = await Promise.all(
    accountIds.map((accountId) =>
      loadState(statePaths(root, resolvedDataDir, accountId)),
    ),
  );
  const jobs = states.flatMap((state) => Object.values(state.jobs));
  return {
    accounts: states.length,
    completedChats: jobs.filter((job) => job.status === "complete").length,
    pendingChats: jobs.filter((job) =>
      ["ready", "running"].includes(job.status),
    ).length,
    failedChats: jobs.filter((job) => job.status === "retry").length,
  };
}

type WithLock = <T>(root: string, operation: () => Promise<T>) => Promise<T>;

async function defaultRunContactAnalysis(
  options: RunContactAnalysisOptions,
): Promise<ContactAnalysisReport> {
  const { runContactAnalysis } =
    await import("./contact-analysis/coordinator.ts");
  return runContactAnalysis(options);
}

async function defaultRunPrivateBackfill(
  options: RunPrivateContactBackfillOptions,
): Promise<PrivateBackfillReport> {
  const { runPrivateContactBackfill } =
    await import("./contact-analysis/backfill.ts");
  return runPrivateContactBackfill(options);
}

async function withAdvisoryPipelineLock<T>(
  lockRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.IVA_CONTACT_ANALYSIS_LOCK_HELD === "1") {
    return operation();
  }
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(lockRoot, ".contact-analysis.lock");
  const child = spawn(
    "flock",
    ["-n", lockPath, "sh", "-c", 'printf "ready\\n"; cat >/dev/null'],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  await new Promise<void>((resolveReady, reject) => {
    let output = "";
    const fail = () => reject(new Error("contact_analysis_already_running"));
    child.once("error", fail);
    child.once("exit", (code) => {
      if (!output.includes("ready\n") || code !== 0) fail();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("ready\n")) resolveReady();
    });
  });
  try {
    return await operation();
  } finally {
    child.stdin?.end();
    await new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
  }
}

export interface ContactAnalysisCommandDependencies {
  env?: NodeJS.ProcessEnv;
  root?: string;
  writeOutput?: (line: string) => void;
  readStatusImpl?: (
    root: string,
    dataDir?: string,
  ) => Promise<ContactAnalysisStatus>;
  readPrivateBackfillStatusImpl?: (
    root: string,
    dataDir?: string,
  ) => Promise<PrivateBackfillStatus>;
  rollbackPrivateBackfillImpl?: (input: {
    root: string;
    dataDir: string;
    vault: string;
    backupDir: string;
  }) => Promise<void>;
  runContactAnalysisImpl?: (
    options: RunContactAnalysisOptions,
  ) => Promise<ContactAnalysisReport>;
  runPrivateBackfillImpl?: (
    options: RunPrivateContactBackfillOptions,
  ) => Promise<PrivateBackfillReport>;
  withLockImpl?: WithLock;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]+$/u.test(message) ? message : "contact_analysis_failed";
}

function compactReport(report: ContactAnalysisReport): string {
  return `completed=${report.completedChats} pending=${report.pendingChats} failed=${report.failedChats} messages=${report.processedMessages} unsupported_media=${report.unsupportedMedia} skipped_messages=${report.skippedMessages} questions=${report.generatedQuestions}`;
}

function compactBackfillReport(report: PrivateBackfillReport): string {
  return `private_chats=${report.privateChats} completed=${report.completedChats} failed=${report.failedChats} messages=${report.processedMessages} skipped_messages=${report.skippedMessages}`;
}

function optionValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export async function runContactAnalysisCommand(
  argv: readonly string[],
  {
    env = process.env,
    root = process.cwd(),
    writeOutput = (line) => console.log(line),
    readStatusImpl = readContactAnalysisStatus,
    readPrivateBackfillStatusImpl = readPrivateBackfillStatus,
    rollbackPrivateBackfillImpl = rollbackPrivateBackfill,
    runContactAnalysisImpl = defaultRunContactAnalysis,
    runPrivateBackfillImpl = defaultRunPrivateBackfill,
    withLockImpl = withAdvisoryPipelineLock,
  }: ContactAnalysisCommandDependencies = {},
): Promise<number> {
  const mode = argv[0];
  const json = argv.includes("--json");
  try {
    if (mode === "status") {
      const status = await readStatusImpl(root, env.ASSISTANT_DATA_DIR);
      writeOutput(
        json
          ? JSON.stringify(status)
          : `accounts=${status.accounts} completed=${status.completedChats} pending=${status.pendingChats} failed=${status.failedChats}`,
      );
      return 0;
    }
    if (mode === "rebuild-status") {
      const status = await readPrivateBackfillStatusImpl(
        root,
        env.ASSISTANT_DATA_DIR,
      );
      writeOutput(
        json
          ? JSON.stringify(status)
          : `accounts=${status.accounts} runs=${status.runs} running=${status.running} complete=${status.complete} failed=${status.failed}`,
      );
      return 0;
    }
    if (mode === "rebuild-rollback") {
      const backupDir = optionValue(argv, "--backup-dir");
      if (!backupDir) {
        writeOutput("telegram_private_backfill_backup_dir_required");
        return 1;
      }
      if (!isAbsolute(backupDir)) {
        writeOutput("telegram_private_backfill_backup_dir_absolute");
        return 1;
      }
      const dataDir = env.ASSISTANT_DATA_DIR ?? "data";
      const resolvedDataDir = isAbsolute(dataDir)
        ? dataDir
        : join(root, dataDir);
      await withLockImpl(resolvedDataDir, () =>
        rollbackPrivateBackfillImpl({
          root,
          dataDir,
          vault: env.ASSISTANT_VAULT_DIR ?? join(root, "vault"),
          backupDir,
        }),
      );
      writeOutput("telegram_private_backfill_rolled_back");
      return 0;
    }
    if (mode === "rebuild-private") {
      if (env.TELEGRAM_EXPOSED_TOOLS !== "read-only") {
        writeOutput("telegram_contact_analysis_requires_read_only");
        return 1;
      }
      const dryRun = argv.includes("--dry-run");
      const backupDir = optionValue(argv, "--backup-dir");
      if (!dryRun && !backupDir) {
        writeOutput("telegram_private_backfill_backup_dir_required");
        return 1;
      }
      if (backupDir && !isAbsolute(backupDir)) {
        writeOutput("telegram_private_backfill_backup_dir_absolute");
        return 1;
      }
      const dataDir = env.ASSISTANT_DATA_DIR ?? "data";
      const resolvedDataDir = isAbsolute(dataDir)
        ? dataDir
        : join(root, dataDir);
      const tokenPath =
        env.ASSISTANT_MULTI_USER === "1" && env.ASSISTANT_ROLE === "owner"
          ? join(
              env.ASSISTANT_APP_DIR ?? root,
              "data",
              "telegram-userbot.token",
            )
          : undefined;
      const report = await withLockImpl(resolvedDataDir, () =>
        runPrivateBackfillImpl({
          root,
          dataDir,
          vault: env.ASSISTANT_VAULT_DIR,
          backupDir:
            backupDir ?? join(resolvedDataDir, "private-backfill-dry-run"),
          ...(optionValue(argv, "--run-id")
            ? { runId: optionValue(argv, "--run-id") }
            : {}),
          ...(tokenPath ? { tokenPath } : {}),
          dryRun,
        }),
      );
      writeOutput(
        json ? JSON.stringify(report) : compactBackfillReport(report),
      );
      return report.failedChats > 0 ? 1 : 0;
    }
    if (mode !== "sync") {
      writeOutput("contact_analysis_usage_error");
      return 1;
    }
    if (env.TELEGRAM_EXPOSED_TOOLS !== "read-only") {
      writeOutput("telegram_contact_analysis_requires_read_only");
      return 1;
    }
    const tokenPath =
      env.ASSISTANT_MULTI_USER === "1" && env.ASSISTANT_ROLE === "owner"
        ? join(env.ASSISTANT_APP_DIR ?? root, "data", "telegram-userbot.token")
        : undefined;
    const dataDir = env.ASSISTANT_DATA_DIR ?? "data";
    const resolvedDataDir = isAbsolute(dataDir) ? dataDir : join(root, dataDir);
    const report = await withLockImpl(resolvedDataDir, () =>
      runContactAnalysisImpl({
        root,
        dataDir,
        vault: env.ASSISTANT_VAULT_DIR,
        ...(tokenPath ? { tokenPath } : {}),
      }),
    );
    writeOutput(json ? JSON.stringify(report) : compactReport(report));
    return report.failedChats > 0 || report.blockedChats > 0 ? 1 : 0;
  } catch (error) {
    writeOutput(safeErrorCode(error));
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  process.exitCode = await runContactAnalysisCommand(process.argv.slice(2));
}
