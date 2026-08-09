// Shared path resolution for agent/schedules/*.ts — root/dataDir/statusPath/lockPath were
// duplicated identically across all 5 schedule files; one place to change if the status
// filename, lock filename, or ASSISTANT_DATA_DIR resolution rule ever changes.
import { isAbsolute, join } from "node:path";

export interface SchedulePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly memoryLockPath: string;
}

export function resolvePaths(): SchedulePaths {
  const cwd = process.cwd();
  const appRootRaw = process.env.ASSISTANT_APP_DIR;
  const root = appRootRaw
    ? isAbsolute(appRootRaw)
      ? appRootRaw
      : join(cwd, appRootRaw)
    : cwd;
  const raw = process.env.ASSISTANT_DATA_DIR ?? "data";
  const dataDir = isAbsolute(raw) ? raw : join(cwd, raw);
  const personalRootRaw = process.env.ASSISTANT_PERSONAL_ROOT;
  const lockRoot = personalRootRaw
    ? isAbsolute(personalRootRaw)
      ? personalRootRaw
      : join(cwd, personalRootRaw)
    : root;
  return {
    root,
    dataDir,
    statusPath: join(dataDir, "rollup-status.json"),
    memoryLockPath: join(lockRoot, ".memory.lock"),
  };
}

export type MemoryPeriod = "daily" | "weekly" | "monthly" | "yearly";

// Same command shape every memory-*.ts schedule spawns: `flock -w 900 .memory.lock node
// --env-file=.env scripts/memory/rollup.ts <period>` — see scripts/lib/schedule-runner.ts.
export function memoryRollupJob(period: MemoryPeriod) {
  const { root, statusPath, memoryLockPath } = resolvePaths();
  return {
    name: `memory-${period}`,
    argv: ["scripts/memory/rollup.ts", period],
    root,
    nodeBin: process.execPath,
    lockPath: memoryLockPath,
    statusPath,
  };
}

export function contactAnalysisJob() {
  const { root, statusPath } = resolvePaths();
  return {
    name: "telegram-contact-sync",
    argv: ["scripts/contact-analysis.ts", "sync"],
    root,
    nodeBin: process.execPath,
    lockPath: join(root, ".contact-analysis.lock"),
    statusPath,
    timeoutMs: 24 * 60 * 60 * 1000,
    guardMs: 10 * 60 * 1000,
    env: {
      ...process.env,
      IVA_CONTACT_ANALYSIS_LOCK_HELD: "1",
    },
  };
}

export function contactAnalysisEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ASSISTANT_MULTI_USER !== "1" || env.ASSISTANT_ROLE === "owner";
}

export function proactiveReviewsEnabled(
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = settings.proactiveReviews;
  const enabled =
    typeof configured === "object" &&
    configured !== null &&
    (configured as { enabled?: unknown }).enabled === true;
  return (
    enabled &&
    (env.ASSISTANT_MULTI_USER !== "1" || env.ASSISTANT_ROLE === "owner")
  );
}

export function proactiveReviewsJob() {
  const { root, statusPath } = resolvePaths();
  return {
    name: "proactive-reviews",
    argv: ["scripts/proactive/run.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    timeoutMs: 4 * 60_000,
    guardMs: 0,
  };
}
