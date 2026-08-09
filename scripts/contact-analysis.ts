import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import "./lib/ts-esm-hooks.ts";
import type {
  ContactAnalysisReport,
  RunContactAnalysisOptions,
} from "./contact-analysis/coordinator.ts";
import { loadState, statePaths } from "./contact-analysis/state.ts";

export interface ContactAnalysisStatus {
  accounts: number;
  completedChats: number;
  pendingChats: number;
  failedChats: number;
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

async function withAdvisoryPipelineLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.IVA_CONTACT_ANALYSIS_LOCK_HELD === "1") {
    return operation();
  }
  const lockPath = join(root, ".contact-analysis.lock");
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
  runContactAnalysisImpl?: (
    options: RunContactAnalysisOptions,
  ) => Promise<ContactAnalysisReport>;
  withLockImpl?: WithLock;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]+$/u.test(message) ? message : "contact_analysis_failed";
}

function compactReport(report: ContactAnalysisReport): string {
  return `completed=${report.completedChats} pending=${report.pendingChats} failed=${report.failedChats} messages=${report.processedMessages} unsupported_media=${report.unsupportedMedia} skipped_messages=${report.skippedMessages} questions=${report.generatedQuestions}`;
}

export async function runContactAnalysisCommand(
  argv: readonly string[],
  {
    env = process.env,
    root = process.cwd(),
    writeOutput = (line) => console.log(line),
    readStatusImpl = readContactAnalysisStatus,
    runContactAnalysisImpl = defaultRunContactAnalysis,
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
    const report = await withLockImpl(root, () =>
      runContactAnalysisImpl({
        root,
        dataDir: env.ASSISTANT_DATA_DIR ?? "data",
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
