import { join } from "node:path";

import type { UserRecord, UserRegistry } from "./user-registry.ts";
import { resolveUserLayout, type UserLayout } from "./user-layout.ts";

export type WorkerUnitRuntime = {
  appRoot: string;
  nodePath: string;
  envFile: string;
  controlDir: string;
  dataDir: string;
  usersDir: string;
  timezone: string;
};

function unitArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function environment(name: string, value: string | number): string {
  const escaped = `${name}=${value}`
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  return `Environment="${escaped}"`;
}

export function workerServiceName(userId: UserRecord["id"]): string {
  return `iva-worker-${userId}.service`;
}

export function renderWorkerUnit(
  user: UserRecord,
  layout: UserLayout,
  runtime: WorkerUnitRuntime,
): string {
  return [
    "[Unit]",
    `Description=Iva user worker ${user.id}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "UMask=0077",
    `WorkingDirectory=${unitArgument(layout.runtime)}`,
    `EnvironmentFile=${unitArgument(runtime.envFile)}`,
    environment("IVA_WORKER_USER_ID", user.id),
    environment("IVA_WORKER_PORT", user.port),
    environment("IVA_WORKER_APP_ROOT", runtime.appRoot),
    environment("IVA_WORKER_CONTROL_DIR", runtime.controlDir),
    environment("IVA_WORKER_USERS_DIR", runtime.usersDir),
    environment("IVA_RUN_STATUS_DATA_DIR", runtime.dataDir),
    environment("TZ", runtime.timezone),
    `ExecStart=${unitArgument(runtime.nodePath)} ${unitArgument(join(runtime.appRoot, "scripts/worker-entry.ts"))}`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function desiredWorkerUnits(
  registry: UserRegistry,
  runtime: WorkerUnitRuntime,
): ReadonlyMap<string, string> {
  const units = new Map<string, string>();
  for (const user of registry.users) {
    if (user.status !== "active") continue;
    const layout = resolveUserLayout(runtime.usersDir, user.id);
    units.set(
      workerServiceName(user.id),
      renderWorkerUnit(user, layout, runtime),
    );
  }
  return units;
}
