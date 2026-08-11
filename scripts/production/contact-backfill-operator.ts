import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import "../lib/ts-esm-hooks.ts";
import type {
  BackfillManifest,
  BackfillState,
} from "../contact-analysis/backfill-state.ts";
import {
  isLegacyOwnerRoute,
  readRoutingUserRegistry,
  type UserRecord,
} from "../lib/user-registry.ts";
import { prepareWorker, type PreparedWorker } from "../worker-entry.ts";

export const CONTACT_BACKFILL_OPERATOR_SCHEMA =
  "iva-contact-backfill-operator/v1" as const;
export const CONTACT_BACKFILL_DRY_RUN_SCHEMA =
  "iva-contact-backfill-dry-run/v1" as const;

export type ContactBackfillOperatorInput =
  | { action: "dry-run" }
  | { action: "apply" | "status" | "rollback"; runId: string };

const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_ERROR = /^[a-z0-9_]+$/u;
const MAX_CHILD_OUTPUT = 64 * 1024;

export function parseContactBackfillOperatorArgs(
  argv: readonly string[],
): ContactBackfillOperatorInput {
  if (argv.length === 1 && argv[0] === "dry-run") {
    return { action: "dry-run" };
  }
  if (
    argv.length === 2 &&
    ["apply", "status", "rollback"].includes(argv[0] ?? "") &&
    RUN_ID.test(argv[1] ?? "")
  ) {
    return {
      action: argv[0] as "apply" | "status" | "rollback",
      runId: argv[1],
    };
  }
  throw new Error("contact_backfill_operator_usage_error");
}

export function summarizeContactBackfillState(
  state: BackfillState,
  backupVerified = false,
) {
  const jobs = Object.values(state.jobs);
  return {
    schema: CONTACT_BACKFILL_OPERATOR_SCHEMA,
    runId: state.runId,
    phase: state.phase,
    backupReady: state.backupReady,
    backupVerified,
    inventoryComplete: state.inventoryComplete,
    incrementalHandoffComplete: state.incrementalHandoffComplete,
    privateChats: state.inventory.length,
    completedChats: jobs.filter((job) => job.status === "complete").length,
    pendingChats: jobs.filter((job) =>
      ["ready", "running"].includes(job.status),
    ).length,
    failedChats: jobs.filter((job) => job.status === "retry").length,
    processedMessages: jobs.reduce(
      (total, job) => total + job.processedMessages,
      0,
    ),
    skippedMessages: 0 as const,
    pendingBatches: jobs.filter((job) => job.pending !== null).length,
    highWaterReachedChats: jobs.filter(
      (job) =>
        job.status === "complete" &&
        job.pending === null &&
        job.committedThrough === job.highWaterId,
    ).length,
    errorCodes: [
      ...new Set(
        jobs.flatMap((job) =>
          job.lastErrorCode === null
            ? []
            : [
                SAFE_ERROR.test(job.lastErrorCode)
                  ? job.lastErrorCode
                  : "contact_backfill_failed",
              ],
        ),
      ),
    ].sort(),
  };
}

export function summarizeContactBackfillDryRun(report: unknown) {
  const value = report as Record<string, unknown>;
  return {
    schema: CONTACT_BACKFILL_DRY_RUN_SCHEMA,
    privateChats: value.privateChats,
    completedChats: value.completedChats,
    failedChats: value.failedChats,
    processedMessages: value.processedMessages,
    skippedMessages: value.skippedMessages,
  };
}

export function backfillManifestMatchesState(
  manifest: Pick<BackfillManifest, "accountUserId" | "runId">,
  state: Pick<BackfillState, "accountUserId" | "runId">,
): boolean {
  return (
    manifest.accountUserId === state.accountUserId &&
    manifest.runId === state.runId
  );
}

async function summarizeVerifiedState(
  context: OperatorContext,
  state: BackfillState,
) {
  if (!state.backupReady) return summarizeContactBackfillState(state, false);
  const { loadBackfillManifest, verifyBackfillBackup } =
    await import("../contact-analysis/backfill-state.ts");
  try {
    const manifest = await loadBackfillManifest(state.backupDir);
    if (!backfillManifestMatchesState(manifest, state)) {
      return summarizeContactBackfillState(state, false);
    }
    await verifyBackfillBackup({
      root: context.prepared.cwd,
      vault: state.vaultDir,
      backupDir: state.backupDir,
      manifest,
    });
    return summarizeContactBackfillState(state, true);
  } catch {
    return summarizeContactBackfillState(state, false);
  }
}

export type OperatorContext = {
  appRoot: string;
  globalDataDir: string;
  vaultDir: string;
  backupRoot: string;
  prepared: Pick<PreparedWorker, "user" | "cwd" | "env">;
};

export type ContactBackfillOperatorDependencies = {
  resolveContext?: () => Promise<OperatorContext>;
  runCli?: (
    context: OperatorContext,
    argv: readonly string[],
  ) => Promise<unknown>;
  loadState?: (
    context: OperatorContext,
    runId: string,
  ) => Promise<BackfillState>;
  summarizeState?: (
    context: OperatorContext,
    state: BackfillState,
  ) => Promise<ReturnType<typeof summarizeContactBackfillState>>;
};

export async function resolveContactBackfillOperatorContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorContext> {
  if (env.IVA_RUNTIME !== "container") {
    throw new Error("contact_backfill_operator_requires_container");
  }
  const appRoot = resolve(env.ASSISTANT_APP_DIR ?? "/app");
  const globalDataDir = resolve(
    env.ASSISTANT_DATA_DIR ?? join(appRoot, "data"),
  );
  const controlDir = join(globalDataDir, "control");
  const usersDir = join(globalDataDir, "users");
  const registry = await readRoutingUserRegistry(controlDir);
  const owners = registry.users.filter(
    (user) => user.role === "owner" && user.status === "active",
  );
  if (owners.length !== 1) {
    throw new Error("contact_backfill_operator_owner_unavailable");
  }
  const owner = owners[0];
  const legacyOwner = isLegacyOwnerRoute(owner);
  const prepared = legacyOwner
    ? prepareLegacyOwner(owner, appRoot, globalDataDir, controlDir, env)
    : await prepareWorker({
        userId: owner.id,
        expectedPort: String(owner.port),
        appRoot,
        controlDir,
        usersDir,
        sourceEnv: env,
      });
  if (prepared.env.TELEGRAM_EXPOSED_TOOLS !== "read-only") {
    throw new Error("telegram_contact_analysis_requires_read_only");
  }
  const vaultDir = resolve(
    prepared.env.ASSISTANT_VAULT_DIR ?? join(prepared.cwd, "vault"),
  );
  const configuredLegacyBackup = env.IVA_CONTACT_BACKFILL_BACKUP_DIR;
  if (legacyOwner && !configuredLegacyBackup) {
    throw new Error("contact_backfill_operator_backup_unavailable");
  }
  const backupRoot = legacyOwner
    ? resolve(configuredLegacyBackup!)
    : resolve(globalDataDir, "private-backfill-backups");
  if (isWithin(prepared.cwd, backupRoot) || isWithin(vaultDir, backupRoot)) {
    throw new Error("contact_backfill_operator_backup_unavailable");
  }
  return { appRoot, globalDataDir, vaultDir, backupRoot, prepared };
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return (
    normalizedTarget === normalizedBase ||
    normalizedTarget.startsWith(`${normalizedBase}${sep}`)
  );
}

function prepareLegacyOwner(
  owner: UserRecord,
  appRoot: string,
  globalDataDir: string,
  controlDir: string,
  sourceEnv: NodeJS.ProcessEnv,
): Pick<PreparedWorker, "user" | "cwd" | "env"> {
  return {
    user: owner,
    cwd: appRoot,
    env: {
      ...sourceEnv,
      ASSISTANT_MULTI_USER: "0",
      ASSISTANT_USER_ID: owner.id,
      ASSISTANT_USER_ROLE: "owner",
      ASSISTANT_ROLE: "owner",
      IVA_USER_CONTROL_DIR: controlDir,
      ASSISTANT_PERSONAL_ROOT: appRoot,
      ASSISTANT_APP_DIR: appRoot,
      ASSISTANT_RUNTIME_ROOT: appRoot,
      ASSISTANT_DATA_DIR: globalDataDir,
      ASSISTANT_VAULT_DIR: resolve(
        sourceEnv.ASSISTANT_VAULT_DIR ?? join(appRoot, "vault"),
      ),
      TELEGRAM_ALLOWED_USER_IDS: owner.id,
      TELEGRAM_DIGEST_CHAT_ID: owner.id,
    },
  };
}

function backupDirectory(context: OperatorContext, runId: string): string {
  return join(context.backupRoot, context.prepared.user.id, runId);
}

async function runContactAnalysisCli(
  context: OperatorContext,
  argv: readonly string[],
): Promise<unknown> {
  const entry = join(context.appRoot, "scripts", "contact-analysis.ts");
  const child = spawn(process.execPath, [entry, ...argv], {
    cwd: context.prepared.cwd,
    env: context.prepared.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > MAX_CHILD_OUTPUT) child.kill("SIGTERM");
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  const line = output.trim().split("\n").at(-1) ?? "";
  if (output.length > MAX_CHILD_OUTPUT) {
    throw new Error("contact_backfill_operator_output_limit");
  }
  if (exitCode !== 0) {
    throw new Error(
      SAFE_ERROR.test(line) ? line : "contact_backfill_operator_failed",
    );
  }
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

async function loadSelectedState(
  context: OperatorContext,
  runId: string,
): Promise<BackfillState> {
  const { backfillPaths, loadBackfillState } =
    await import("../contact-analysis/backfill-state.ts");
  const { readPrivateBackfillStatus } = await import("../contact-analysis.ts");
  const status = await readPrivateBackfillStatus(
    context.prepared.cwd,
    context.prepared.env.ASSISTANT_DATA_DIR,
  );
  const selected = status.details.find((detail) => detail.runId === runId);
  if (!selected) throw new Error("contact_backfill_operator_run_not_found");
  const state = await loadBackfillState(
    backfillPaths(
      context.prepared.cwd,
      context.prepared.env.ASSISTANT_DATA_DIR ?? "data",
      selected.accountUserId,
    ),
  );
  if (!state || state.runId !== runId) {
    throw new Error("contact_backfill_operator_run_not_found");
  }
  if (
    state.vaultDir !== context.vaultDir ||
    state.backupDir !== resolve(backupDirectory(context, runId))
  ) {
    throw new Error("contact_backfill_operator_state_binding_mismatch");
  }
  return state;
}

export async function runContactBackfillOperator(
  argv: readonly string[],
  {
    resolveContext = () => resolveContactBackfillOperatorContext(),
    runCli = runContactAnalysisCli,
    loadState = loadSelectedState,
    summarizeState = summarizeVerifiedState,
  }: ContactBackfillOperatorDependencies = {},
): Promise<unknown> {
  const input = parseContactBackfillOperatorArgs(argv);
  const context = await resolveContext();
  if (input.action === "dry-run") {
    return summarizeContactBackfillDryRun(
      await runCli(context, ["rebuild-private", "--dry-run", "--json"]),
    );
  }
  if (input.action === "status") {
    return summarizeState(context, await loadState(context, input.runId));
  }
  const backupDir = backupDirectory(context, input.runId);
  if (input.action === "apply") {
    await runCli(context, [
      "rebuild-private",
      "--backup-dir",
      backupDir,
      "--run-id",
      input.runId,
      "--json",
    ]);
  } else {
    await runCli(context, [
      "rebuild-rollback",
      "--backup-dir",
      backupDir,
      "--run-id",
      input.runId,
    ]);
  }
  return summarizeState(context, await loadState(context, input.runId));
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_ERROR.test(message)
    ? message
    : "contact_backfill_operator_failed";
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  void runContactBackfillOperator(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(safeErrorCode(error));
      process.exitCode = 1;
    });
}
