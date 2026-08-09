import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { childEnv, gwsBin } from "./menu/gws-auth.ts";
import { runScheduledJob } from "./schedule-runner.ts";
import { parseTelegramUserId } from "./user-registry.ts";

export type ContainerMaintenanceCommand = "doc" | "cln" | "mem";
export type ContainerMaintenanceInput = {
  globalDataDir: string;
  personalRoot: string;
  userId: string;
  appRoot: string;
};
export type ContainerProcessSpec = {
  kind: "proc";
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};
export type ContainerRuntimeStatus = {
  runtime: "container";
  scheduler: "ready" | "stale" | "missing" | "invalid";
  schedulerUpdatedAt?: number;
};

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isContainerRuntime(runtime = process.env.IVA_RUNTIME): boolean {
  return runtime === "container";
}

export function buildContainerMaintenanceEnvironment(
  input: ContainerMaintenanceInput,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const globalDataDir = resolve(input.globalDataDir);
  const personalRoot = resolve(input.personalRoot);
  const appRoot = resolve(input.appRoot);
  const userId = parseTelegramUserId(input.userId);
  if (
    !isAbsolute(input.globalDataDir) ||
    !isAbsolute(input.personalRoot) ||
    !isAbsolute(input.appRoot)
  ) {
    throw new Error("container maintenance paths must be absolute");
  }
  if (!inside(globalDataDir, personalRoot) || personalRoot === globalDataDir) {
    throw new Error("personal root escaped global data");
  }
  if (!userId)
    throw new Error("container maintenance requires a fixed user identity");
  return {
    ...sourceEnv,
    IVA_RUNTIME: "container",
    HOME: personalRoot,
    XDG_CONFIG_HOME: join(personalRoot, ".config"),
    ASSISTANT_MULTI_USER: "1",
    ASSISTANT_USER_ID: userId,
    ASSISTANT_PERSONAL_ROOT: personalRoot,
    ASSISTANT_APP_DIR: appRoot,
    ASSISTANT_DATA_DIR: join(personalRoot, "runtime", "data"),
    ASSISTANT_VAULT_DIR: join(personalRoot, "vault"),
    IVA_GLOBAL_DATA_DIR: globalDataDir,
    IVA_USER_CONTROL_DIR: join(globalDataDir, "control"),
    TELEGRAM_ALLOWED_USER_IDS: userId,
    TELEGRAM_DIGEST_CHAT_ID: userId,
  };
}

export function containerMaintenanceSpec(
  command: ContainerMaintenanceCommand,
  input: ContainerMaintenanceInput,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): ContainerProcessSpec {
  const env = buildContainerMaintenanceEnvironment(input, sourceEnv);
  const entry = join(
    resolve(input.appRoot),
    "scripts",
    "lib",
    "container-maintenance.ts",
  );
  if (command === "cln") {
    return {
      kind: "proc",
      argv: [
        "uv",
        "run",
        join(resolve(input.appRoot), "scripts", "autograph", "cleanup.py"),
        ".",
        "--apply",
      ],
      cwd: env.ASSISTANT_VAULT_DIR as string,
      env,
    };
  }
  return {
    kind: "proc",
    argv: [process.execPath, entry, command === "doc" ? "doctor" : "memory"],
    cwd: resolve(input.appRoot),
    env,
  };
}

export function readContainerRuntimeStatus(
  globalDataDir: string,
  now = Date.now(),
): ContainerRuntimeStatus {
  const file = join(
    resolve(globalDataDir),
    "control",
    "reminder-scheduler-status.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      runtime: "container",
      scheduler:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "invalid",
    };
  }
  const updatedAt = (parsed as { updatedAt?: unknown } | null)?.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return { runtime: "container", scheduler: "invalid" };
  }
  return {
    runtime: "container",
    scheduler: now - updatedAt <= 60_000 ? "ready" : "stale",
    schedulerUpdatedAt: updatedAt,
  };
}

export function runContainerDoctor(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const home = env.ASSISTANT_PERSONAL_ROOT;
  const dataDir = env.ASSISTANT_DATA_DIR;
  const vaultDir = env.ASSISTANT_VAULT_DIR;
  const globalDataDir = env.IVA_GLOBAL_DATA_DIR;
  const failures: string[] = [];
  for (const [label, path] of Object.entries({
    home,
    data: dataDir,
    vault: vaultDir,
  })) {
    if (!path) {
      failures.push(`${label}: missing path`);
      continue;
    }
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
      console.log(`ok: ${label} is readable and writable`);
    } catch {
      failures.push(`${label}: unavailable`);
    }
  }
  if (home) {
    const gws = spawnSync(gwsBin(), ["--version"], {
      env: childEnv(home),
      encoding: "utf8",
      timeout: 5000,
    });
    if (gws.status === 0) console.log(String(gws.stdout).split("\n")[0]);
    else failures.push("gws: unavailable");
  }
  if (globalDataDir) {
    const status = readContainerRuntimeStatus(globalDataDir);
    console.log(`scheduler: ${status.scheduler}`);
    if (status.scheduler !== "ready")
      failures.push(`scheduler: ${status.scheduler}`);
  } else {
    failures.push("scheduler: global data path missing");
  }
  for (const failure of failures) console.error(`issue: ${failure}`);
  return failures.length ? 1 : 0;
}

export async function runContainerMemory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const root = env.ASSISTANT_APP_DIR;
  const dataDir = env.ASSISTANT_DATA_DIR;
  const home = env.ASSISTANT_PERSONAL_ROOT;
  if (!root || !dataDir || !home) {
    throw new Error("container memory cycle is missing personal runtime paths");
  }
  const result = await runScheduledJob({
    name: "memory-doctor-manual",
    argv: [join(root, "scripts", "memory", "doctor.ts")],
    root,
    nodeBin: process.execPath,
    lockPath: join(home, ".memory.lock"),
    statusPath: join(dataDir, "rollup-status.json"),
    env,
  });
  return result.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "doctor") process.exitCode = runContainerDoctor();
  else if (command === "memory") process.exitCode = await runContainerMemory();
  else throw new Error("container maintenance action must be doctor or memory");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
