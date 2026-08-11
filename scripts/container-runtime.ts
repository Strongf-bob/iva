import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimContainerCommands,
  completeContainerCommand,
  readContainerRuntimeStatus,
  recoverClaimedContainerCommands,
  writeContainerRuntimeStatus,
  type ClaimedContainerCommand,
  type ContainerRuntimeStatus,
} from "./lib/container-worker-control.ts";
import {
  readUserRegistry,
  type UserRecord,
  type UserRegistry,
} from "./lib/user-registry.ts";
import { launchWorker, prepareWorker } from "./worker-entry.ts";

export type RuntimeExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ManagedRuntimeChild = {
  pid: number | undefined;
  exited: Promise<RuntimeExit>;
  stop: (signal: NodeJS.Signals) => void;
};

type ChildSlot = {
  child: ManagedRuntimeChild | null;
  restarts: number;
  nextRestartAt: number;
  intentionalStop: boolean;
};

type WorkerSlot = ChildSlot & {
  user: UserRecord;
};

type RuntimeOptions = {
  controlDir: string;
  appRoot?: string;
  usersDir?: string;
  supervisorPid?: number;
  now?: () => number;
  readRegistry?: () => Promise<UserRegistry>;
  launchPoller?: () => ManagedRuntimeChild;
  launchWorker?: (user: UserRecord) => Promise<ManagedRuntimeChild>;
  shutdownTimeoutMs?: number;
};

export type ContainerRuntime = {
  start: () => Promise<void>;
  tick: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => ContainerRuntimeStatus;
};

function managedChild(child: ChildProcess): ManagedRuntimeChild {
  return {
    pid: child.pid,
    stop: (signal) => {
      child.kill(signal);
    },
    exited: new Promise<RuntimeExit>((resolvePromise) => {
      child.once("error", () => {
        resolvePromise({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => {
        resolvePromise({ code, signal });
      });
    }),
  };
}

function backoffMs(restarts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, restarts - 1));
}

function safeMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 500);
}

async function terminateChild(
  child: ManagedRuntimeChild,
  timeoutMs: number,
): Promise<void> {
  child.stop("SIGTERM");
  const exited = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.exited.then(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
  if (exited) {
    return;
  }
  child.stop("SIGKILL");
  await child.exited;
}

export function createContainerRuntime({
  controlDir,
  appRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  usersDir = join(
    resolve(fileURLToPath(new URL("..", import.meta.url))),
    "data",
    "users",
  ),
  supervisorPid = process.pid,
  now = Date.now,
  readRegistry: readRegistryImpl = () => readUserRegistry(controlDir),
  launchPoller: launchPollerImpl = () =>
    managedChild(
      spawn(process.execPath, [join(appRoot, "scripts", "telegram-poll.mjs")], {
        cwd: appRoot,
        env: process.env,
        stdio: "inherit",
      }),
    ),
  launchWorker: launchWorkerImpl = async (user) => {
    const prepared = await prepareWorker({
      userId: user.id,
      expectedPort: String(user.port),
      appRoot,
      controlDir,
      usersDir,
    });
    return managedChild(launchWorker(prepared));
  },
  shutdownTimeoutMs = 10_000,
}: RuntimeOptions): ContainerRuntime {
  let registry: UserRegistry | null = null;
  let started = false;
  let stopping = false;
  let pollerDesired = true;
  const poller: ChildSlot = {
    child: null,
    restarts: 0,
    nextRestartAt: 0,
    intentionalStop: false,
  };
  const workers = new Map<string, WorkerSlot>();
  let lastStatusSignature = "";
  let lastStatusWriteAt = 0;

  function attachExit(
    key: "poller" | string,
    slot: ChildSlot,
    child: ManagedRuntimeChild,
  ): void {
    void child.exited.then(() => {
      if (slot.child !== child) return;
      slot.child = null;
      if (!slot.intentionalStop && !stopping) {
        slot.restarts += 1;
        slot.nextRestartAt = now() + backoffMs(slot.restarts);
      }
      slot.intentionalStop = false;
      if (key !== "poller" && registry) {
        const desired = registry.users.some(
          (user) => user.id === key && user.status !== "blocked",
        );
        if (!desired) workers.delete(key);
      }
    });
  }

  async function ensureWorker(
    user: UserRecord,
    { force = false, startup = false } = {},
  ): Promise<void> {
    let slot = workers.get(user.id);
    if (!slot) {
      slot = {
        user,
        child: null,
        restarts: 0,
        nextRestartAt: 0,
        intentionalStop: false,
      };
      workers.set(user.id, slot);
    }
    slot.user = user;
    if (slot.child) return;
    if (!force && now() < slot.nextRestartAt) return;
    try {
      const child = await launchWorkerImpl(user);
      slot.child = child;
      slot.nextRestartAt = 0;
      attachExit(user.id, slot, child);
    } catch (error) {
      slot.restarts += 1;
      slot.nextRestartAt = now() + backoffMs(slot.restarts);
      if (startup) throw error;
    }
  }

  function ensurePoller({ force = false }: { force?: boolean } = {}): void {
    if (!pollerDesired || poller.child) return;
    if (!force && now() < poller.nextRestartAt) return;
    const child = launchPollerImpl();
    poller.child = child;
    poller.nextRestartAt = 0;
    attachExit("poller", poller, child);
  }

  async function stopWorker(userId: string): Promise<void> {
    const slot = workers.get(userId);
    if (!slot?.child) {
      workers.delete(userId);
      return;
    }
    const child = slot.child;
    slot.intentionalStop = true;
    await terminateChild(child, shutdownTimeoutMs);
    if (slot.child === child) slot.child = null;
    workers.delete(userId);
  }

  async function stopPoller(): Promise<void> {
    pollerDesired = false;
    const child = poller.child;
    if (!child) return;
    poller.intentionalStop = true;
    await terminateChild(child, shutdownTimeoutMs);
    if (poller.child === child) poller.child = null;
  }

  async function reconcileUsers(startup = false): Promise<void> {
    if (!registry) throw new Error("container runtime registry is unavailable");
    const desired = new Map<string, UserRecord>(
      registry.users
        .filter((user) => user.status !== "blocked")
        .map((user) => [user.id, user]),
    );
    for (const userId of workers.keys()) {
      if (!desired.has(userId)) await stopWorker(userId);
    }
    for (const user of desired.values()) {
      await ensureWorker(user, { startup });
    }
  }

  async function executeCommand(
    command: ClaimedContainerCommand,
  ): Promise<void> {
    try {
      if (!registry)
        throw new Error("container runtime registry is unavailable");
      if (command.action === "start-worker") {
        const user = registry.users.find(
          (candidate) =>
            candidate.id === command.userId && candidate.status !== "blocked",
        );
        if (!user)
          throw new Error(`worker user ${command.userId} is not routable`);
        await ensureWorker(user, { force: true });
        if (!workers.get(user.id)?.child) {
          throw new Error(`worker ${user.id} did not start`);
        }
        await completeContainerCommand(controlDir, command, {
          ok: true,
          message: "started",
        });
        return;
      }
      if (command.action === "stop-worker") {
        await stopWorker(command.userId!);
        await completeContainerCommand(controlDir, command, {
          ok: true,
          message: "stopped",
        });
        return;
      }
      if (command.action === "pause-poller") {
        await stopPoller();
        await completeContainerCommand(controlDir, command, {
          ok: true,
          message: "paused",
        });
        return;
      }
      pollerDesired = true;
      ensurePoller({ force: true });
      await completeContainerCommand(controlDir, command, {
        ok: true,
        message: "running",
      });
    } catch (error) {
      await completeContainerCommand(controlDir, command, {
        ok: false,
        message: safeMessage(error),
      });
    }
  }

  function status(): ContainerRuntimeStatus {
    const timestamp = new Date(now()).toISOString();
    const workerStatus: ContainerRuntimeStatus["workers"] = {};
    for (const [userId, slot] of [...workers.entries()].sort(([a], [b]) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    )) {
      workerStatus[userId] = {
        state: slot.child
          ? "running"
          : slot.nextRestartAt > now()
            ? "backoff"
            : "stopped",
        pid: slot.child?.pid ?? null,
        port: slot.user.port,
        restarts: slot.restarts,
      };
    }
    return {
      schema: "iva-container-runtime-status/v1",
      supervisorPid,
      updatedAt: timestamp,
      poller: {
        state: poller.child
          ? "running"
          : poller.nextRestartAt > now()
            ? "backoff"
            : "stopped",
        pid: poller.child?.pid ?? null,
        restarts: poller.restarts,
      },
      workers: workerStatus,
    };
  }

  async function publishStatus(force = false): Promise<void> {
    const next = status();
    const signature = JSON.stringify({ ...next, updatedAt: undefined });
    if (
      !force &&
      signature === lastStatusSignature &&
      now() - lastStatusWriteAt < 5_000
    ) {
      return;
    }
    await writeContainerRuntimeStatus(controlDir, next);
    lastStatusSignature = signature;
    lastStatusWriteAt = now();
  }

  return {
    async start() {
      if (started) return;
      recoverClaimedContainerCommands(controlDir);
      registry = await readRegistryImpl();
      await reconcileUsers(true);
      ensurePoller({ force: true });
      started = true;
      await publishStatus(true);
    },
    async tick() {
      if (!started || stopping) return;
      registry = await readRegistryImpl();
      await reconcileUsers();
      if (pollerDesired) ensurePoller();
      for (const command of claimContainerCommands(controlDir)) {
        await executeCommand(command);
      }
      await publishStatus();
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      pollerDesired = false;
      const workerIds = [...workers.keys()];
      await Promise.all([
        stopPoller(),
        ...workerIds.map((userId) => stopWorker(userId)),
      ]);
      started = false;
      await publishStatus(true);
    },
    status,
  };
}

function runtimePathsFromEnv(): {
  appRoot: string;
  dataDir: string;
  controlDir: string;
  usersDir: string;
} {
  const appRoot = resolve(
    process.env.ASSISTANT_APP_DIR ??
      fileURLToPath(new URL("..", import.meta.url)),
  );
  const rawData = process.env.ASSISTANT_DATA_DIR ?? join(appRoot, "data");
  const dataDir = isAbsolute(rawData)
    ? resolve(rawData)
    : resolve(appRoot, rawData);
  return {
    appRoot,
    dataDir,
    controlDir: join(dataDir, "control"),
    usersDir: join(dataDir, "users"),
  };
}

async function requireReady(): Promise<void> {
  const { controlDir } = runtimePathsFromEnv();
  const registry = await readUserRegistry(controlDir);
  const status = readContainerRuntimeStatus(controlDir);
  if (Date.now() - Date.parse(status.updatedAt) > 15_000) {
    throw new Error("container runtime status is stale");
  }
  if (status.poller.state !== "running" || status.poller.pid === null) {
    throw new Error("container Telegram poller is not running");
  }
  for (const user of registry.users) {
    if (user.status === "blocked") continue;
    const worker = status.workers[user.id];
    if (
      !worker ||
      worker.state !== "running" ||
      worker.pid === null ||
      worker.port !== user.port
    ) {
      throw new Error(`container worker ${user.id} is not ready`);
    }
  }
  console.log("container runtime ready");
}

export async function runContainerRuntimeFromEnv(): Promise<void> {
  if (process.env.IVA_CONTAINER_RUNTIME !== "1") {
    throw new Error("IVA_CONTAINER_RUNTIME=1 is required");
  }
  const paths = runtimePathsFromEnv();
  const runtime = createContainerRuntime({
    appRoot: paths.appRoot,
    controlDir: paths.controlDir,
    usersDir: paths.usersDir,
  });
  let stopping = false;
  let wakeShutdown!: () => void;
  const shutdown = new Promise<void>((resolvePromise) => {
    wakeShutdown = resolvePromise;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopping = true;
      wakeShutdown();
    });
  }
  await runtime.start();
  const loop = (async () => {
    while (!stopping) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      if (!stopping) await runtime.tick();
    }
  })();
  try {
    await Promise.race([shutdown, loop]);
  } finally {
    stopping = true;
    await runtime.stop();
  }
  await loop;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (command === "status" && process.argv[3] === "--require-ready") {
    await requireReady();
    return;
  }
  if (command !== "run")
    throw new Error(`unknown container runtime command: ${command}`);
  await runContainerRuntimeFromEnv();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error("iva container runtime fatal:", safeMessage(error));
    process.exit(1);
  });
}
