import { join } from "node:path";

import {
  readContainerRuntimeStatus,
  submitContainerCommand,
  type ContainerCommandInput,
  type ContainerCommandReceipt,
  type ContainerRuntimeStatus,
} from "../lib/container-worker-control.ts";
import type { UserRecord } from "../lib/user-registry.ts";
import type { WorkerLifecycle } from "./users.ts";

type ContainerLifecycleRuntime = {
  readonly dataDirAbs: () => string;
};

type ContainerWorkerLifecycleOptions = {
  readonly submitImpl?: (
    controlDir: string,
    input: ContainerCommandInput,
  ) => Promise<ContainerCommandReceipt>;
  readonly readStatusImpl?: (controlDir: string) => ContainerRuntimeStatus;
  readonly now?: () => number;
};

function requireSuccess(
  receipt: ContainerCommandReceipt,
): ContainerCommandReceipt {
  if (!receipt.ok) {
    throw new Error(
      `container ${receipt.action} failed: ${receipt.message || "unknown failure"}`,
    );
  }
  return receipt;
}

export function createContainerWorkerLifecycle(
  runtime: ContainerLifecycleRuntime,
  {
    submitImpl = submitContainerCommand,
    readStatusImpl = readContainerRuntimeStatus,
    now = Date.now,
  }: ContainerWorkerLifecycleOptions = {},
): WorkerLifecycle {
  const controlDir = join(runtime.dataDirAbs(), "control");
  const submit = (input: ContainerCommandInput) =>
    submitImpl(controlDir, input)
      .then(requireSuccess)
      .then(() => undefined);
  return {
    supportsOwnerMigration: false,
    startWorker: (user) => submit({ action: "start-worker", userId: user.id }),
    stopWorker: (user) => submit({ action: "stop-worker", userId: user.id }),
    workerStatus: (user: UserRecord) => {
      let status: ContainerRuntimeStatus;
      try {
        status = readStatusImpl(controlDir);
      } catch {
        return "supervisor-unavailable";
      }
      if (now() - Date.parse(status.updatedAt) > 15_000) return "stale";
      const worker = status.workers[user.id];
      if (!worker) return "stopped";
      if (worker.port !== user.port) return "mismatch";
      return worker.state;
    },
    retireLegacyService: () =>
      Promise.reject(
        new Error("legacy owner migration is unavailable in container mode"),
      ),
    restoreLegacyService: () => undefined,
    pauseGateway: () => submit({ action: "pause-poller" }),
    resumeGateway: () => submit({ action: "resume-poller" }),
  };
}
