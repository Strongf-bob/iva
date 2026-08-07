import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTelegramUserId,
  readUserRegistry,
  type UserRecord,
} from "./lib/user-registry.ts";
import {
  resolveUserLayout,
  verifyUserLayout,
  type UserLayout,
} from "./lib/user-layout.ts";

const SHARED_ENV_KEYS = new Set([
  "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_LANGUAGE",
  "ASSISTANT_BEARER",
  "ASSISTANT_TIMEZONE",
  "BRAVE_API_KEY",
  "CODEX_CONTEXT_WINDOW",
  "CODEX_MODEL",
  "DEEPGRAM_API_KEY",
  "DEEPGRAM_LANGUAGE",
  "DEEPINFRA_API_KEY",
  "EXA_API_KEY",
  "JINA_API_KEY",
  "IVA_RUN_STATUS_DATA_DIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "MEMORY_EMBED_MODEL",
  "MEMORY_EMBED_PROVIDER",
  "MEMORY_EMBED_URL",
  "MEMORY_SEARCH_MODE",
  "MODEL_PROVIDER",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_CONTEXT_WINDOW",
  "OLLAMA_MODEL",
  "OPENCODE_API_KEY",
  "OPENCODE_CONTEXT_WINDOW",
  "OPENCODE_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_CONTEXT_WINDOW",
  "OPENROUTER_MODEL",
  "PARALLEL_API_KEY",
  "PATH",
  "SEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET_TOKEN",
  "THINKING_EFFORT",
]);

export type WorkerInput = {
  userId: string;
  expectedPort: string;
  appRoot: string;
  controlDir: string;
  usersDir: string;
  sourceEnv?: NodeJS.ProcessEnv;
};

export type PreparedWorker = {
  user: UserRecord;
  layout: UserLayout;
  cwd: string;
  port: number;
  env: NodeJS.ProcessEnv;
  command: string;
  args: string[];
};

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`worker private directory must not be a symlink: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) {
    throw new Error(`worker private path is not a directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function filteredEnvironment(
  source: NodeJS.ProcessEnv,
  user: UserRecord,
  layout: UserLayout,
  controlDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SHARED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  const temporary = join(layout.data, "tmp");
  ensurePrivateDirectory(temporary);
  return {
    ...env,
    NODE_ENV: "production",
    HOME: layout.root,
    TMPDIR: temporary,
    TZ: source.ASSISTANT_TIMEZONE || source.TZ || "UTC",
    PORT: String(user.port),
    IVA_PORT: String(user.port),
    ASSISTANT_HOST: `http://127.0.0.1:${user.port}`,
    ASSISTANT_MULTI_USER: "1",
    ASSISTANT_USER_ID: user.id,
    ASSISTANT_USER_ROLE: user.role,
    IVA_USER_CONTROL_DIR: controlDir,
    ASSISTANT_PERSONAL_ROOT: layout.root,
    ASSISTANT_RUNTIME_ROOT: layout.runtime,
    ASSISTANT_DATA_DIR: layout.data,
    ASSISTANT_VAULT_DIR: layout.vault,
    TELEGRAM_ALLOWED_USER_IDS: user.id,
    TELEGRAM_DIGEST_CHAT_ID: user.id,
  };
}

export async function prepareWorker(
  input: WorkerInput,
): Promise<PreparedWorker> {
  const id = parseTelegramUserId(input.userId);
  if (!id) throw new Error("invalid worker Telegram user id");
  for (const [name, path] of Object.entries({
    appRoot: input.appRoot,
    controlDir: input.controlDir,
    usersDir: input.usersDir,
  })) {
    if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  }
  const registry = await readUserRegistry(resolve(input.controlDir));
  const user = registry.users.find((candidate) => candidate.id === id);
  if (!user || user.status !== "active") {
    throw new Error(`worker user ${id} is not active`);
  }
  if (String(user.port) !== input.expectedPort) {
    throw new Error(`worker port does not match registry for user ${id}`);
  }
  const appRoot = resolve(input.appRoot);
  const layout = resolveUserLayout(resolve(input.usersDir), id);
  verifyUserLayout(layout, appRoot);
  const env = filteredEnvironment(
    input.sourceEnv ?? process.env,
    user,
    layout,
    resolve(input.controlDir),
  );
  return {
    user,
    layout,
    cwd: layout.runtime,
    port: user.port,
    env,
    command: process.execPath,
    args: [
      join(appRoot, "node_modules/eve/bin/eve.js"),
      "start",
      "--host",
      "127.0.0.1",
    ],
  };
}

export function launchWorker(prepared: PreparedWorker): ChildProcess {
  return spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: "inherit",
  });
}

export async function main(): Promise<void> {
  const prepared = await prepareWorker({
    userId: process.env.IVA_WORKER_USER_ID ?? "",
    expectedPort: process.env.IVA_WORKER_PORT ?? "",
    appRoot: process.env.IVA_WORKER_APP_ROOT ?? "",
    controlDir: process.env.IVA_WORKER_CONTROL_DIR ?? "",
    usersDir: process.env.IVA_WORKER_USERS_DIR ?? "",
  });
  const child = launchWorker(prepared);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error("iva worker fatal:", error);
    process.exit(1);
  });
}
