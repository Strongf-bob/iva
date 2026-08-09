import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadJsonStrict, saveJsonAtomic } from "../agent/lib/json-store.ts";
import { resolveUserLayout } from "./lib/user-layout.ts";
import {
  parseTelegramUserId,
  readUserRegistry,
} from "./lib/user-registry.ts";
import {
  cancelReminder,
  createReminder,
  getReminder,
  listReminders,
} from "./lib/reminder-store.ts";
import {
  runReminderTick,
  type ReminderTickReport,
  type ReminderUser,
} from "./lib/reminder-runner.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";

const HEARTBEAT_MAX_AGE_MS = 60_000;
const TICK_MS = 15_000;

type CommandResult = Record<string, unknown> & { ok: boolean };
type CommandIo = {
  now?: () => number;
  readInput?: () => Promise<string>;
};

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function personalContext(env: NodeJS.ProcessEnv): {
  userId: string;
  dataDir: string;
} {
  const userId = parseTelegramUserId(env.ASSISTANT_USER_ID);
  const rawDataDir = env.ASSISTANT_DATA_DIR;
  if (!userId || !rawDataDir) {
    throw new Error("reminder command requires a fixed user identity and data directory");
  }
  const dataDir = resolve(rawDataDir);
  if (env.ASSISTANT_MULTI_USER === "1" || env.IVA_RUNTIME === "container") {
    const rawRoot = env.ASSISTANT_PERSONAL_ROOT;
    if (!rawRoot || !isAbsolute(rawRoot)) {
      throw new Error("reminder command requires an absolute personal root");
    }
    const root = resolve(rawRoot);
    if (!inside(root, dataDir)) throw new Error("reminder data escaped personal root");
  }
  return { userId, dataDir };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function schedulerStatusFile(dataDir: string): string {
  return join(resolve(dataDir), "control", "reminder-scheduler-status.json");
}

export async function writeSchedulerHeartbeat(
  dataDir: string,
  report: ReminderTickReport & { now: number },
): Promise<void> {
  await saveJsonAtomic(schedulerStatusFile(dataDir), {
    schema: "iva-reminder-scheduler-status/v1",
    updatedAt: report.now,
    users: report.users ?? 0,
    delivered: report.delivered,
    failed: report.failed,
    recovered: report.recovered ?? 0,
  });
}

async function health(dataDir: string, now: number): Promise<CommandResult> {
  try {
    const status = await loadJsonStrict<Record<string, unknown>>(
      schedulerStatusFile(dataDir),
      {},
    );
    const updatedAt = status.updatedAt;
    const ready =
      typeof updatedAt === "number" &&
      Number.isFinite(updatedAt) &&
      now - updatedAt <= HEARTBEAT_MAX_AGE_MS;
    return { ...status, ok: ready, status: ready ? "ready" : "stale" };
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeReminderCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CommandIo = {},
): Promise<CommandResult> {
  const now = io.now ?? (() => Date.now());
  const action = args[0];
  if (action === "health") {
    const dataDir = env.ASSISTANT_DATA_DIR;
    if (!dataDir) throw new Error("scheduler health requires ASSISTANT_DATA_DIR");
    return health(dataDir, now());
  }
  const { dataDir } = personalContext(env);
  if (action === "create") {
    const raw = await (io.readInput ?? readStdin)();
    const value: unknown = JSON.parse(raw);
    const result = await createReminder(dataDir, value, { now });
    return { ok: true, ...result };
  }
  if (action === "list") {
    const jobs = await listReminders(dataDir, {
      includeInactive: args.includes("--all"),
    });
    return { ok: true, count: jobs.length, jobs };
  }
  if (action === "get") {
    if (!args[1]) throw new Error("get requires a reminder id");
    const job = await getReminder(dataDir, args[1]);
    return job ? { ok: true, job } : { ok: false, error: "reminder not found" };
  }
  if (action === "cancel") {
    if (!args[1]) throw new Error("cancel requires a reminder id");
    return { ok: true, job: await cancelReminder(dataDir, args[1]) };
  }
  if (action === "status") {
    const jobs = await listReminders(dataDir, { includeInactive: true });
    const counts = Object.fromEntries(
      ["active", "delivering", "completed", "cancelled"].map((state) => [
        state,
        jobs.filter((job) => job.state === state).length,
      ]),
    );
    return { ok: true, counts };
  }
  throw new Error("reminder action must be create, list, get, cancel, status, or health");
}

async function schedulerUsers(dataDir: string): Promise<ReminderUser[]> {
  const registry = await readUserRegistry(join(dataDir, "control"));
  const usersDir = join(dataDir, "users");
  return registry.users.map((user) => ({
    id: user.id,
    status: user.status,
    dataDir: resolveUserLayout(usersDir, user.id).data,
  }));
}

export async function runScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dataDir = env.ASSISTANT_DATA_DIR;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!dataDir || !isAbsolute(dataDir)) {
    throw new Error("scheduler requires an absolute ASSISTANT_DATA_DIR");
  }
  if (!token) throw new Error("scheduler requires TELEGRAM_BOT_TOKEN");
  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      const report = await runReminderTick({
        users: await schedulerUsers(dataDir),
        deliver: async (chatId, message) => {
          const result = await sendTelegramHtml(token, chatId, message);
          return { ok: result.ok, error: result.error };
        },
        log: (...parts) => console.log(new Date().toISOString(), ...parts),
      });
      await writeSchedulerHeartbeat(dataDir, { now: Date.now(), ...report });
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          wake = null;
          done();
        }, TICK_MS);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          done();
        };
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result =
    args[0] === "run"
      ? await runScheduler().then(() => ({ ok: true }))
      : await executeReminderCommand(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  });
}
