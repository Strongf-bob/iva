import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeSchedulerHeartbeat } from "../reminder-scheduler.ts";
import {
  buildContainerMaintenanceEnvironment,
  containerMaintenanceSpec,
  readContainerRuntimeStatus,
} from "./container-maintenance.ts";

void test("container maintenance derives every writable path from one personal root", async () => {
  const globalDataDir = await mkdtemp(join(tmpdir(), "iva-container-global-"));
  const personalRoot = join(globalDataDir, "users", "101");
  const env = buildContainerMaintenanceEnvironment(
    { globalDataDir, personalRoot, userId: "101", appRoot: "/app" },
    { TELEGRAM_BOT_TOKEN: "secret", PATH: "/usr/bin" },
  );

  assert.equal(env.HOME, personalRoot);
  assert.equal(env.XDG_CONFIG_HOME, join(personalRoot, ".config"));
  assert.equal(env.ASSISTANT_DATA_DIR, join(personalRoot, "runtime", "data"));
  assert.equal(env.ASSISTANT_VAULT_DIR, join(personalRoot, "vault"));
  assert.equal(env.IVA_USER_CONTROL_DIR, join(globalDataDir, "control"));
  assert.equal(env.ASSISTANT_USER_ID, "101");
});

void test("container maintenance rejects a personal root outside global data", () => {
  assert.throws(
    () =>
      buildContainerMaintenanceEnvironment({
        globalDataDir: "/app/data",
        personalRoot: "/tmp/users/101",
        userId: "101",
        appRoot: "/app",
      }),
    /escaped global data/u,
  );
});

void test("container specs use attached processes and never systemd units", () => {
  const input = {
    globalDataDir: "/app/data",
    personalRoot: "/app/data/users/101",
    userId: "101",
    appRoot: "/app",
  };
  const doctor = containerMaintenanceSpec("doc", input);
  const cleanup = containerMaintenanceSpec("cln", input);
  const memory = containerMaintenanceSpec("mem", input);

  for (const spec of [doctor, cleanup, memory]) assert.equal(spec.kind, "proc");
  assert.match(doctor.argv.at(-2) ?? "", /container-maintenance\.ts$/u);
  assert.equal(doctor.argv.at(-1), "doctor");
  assert.equal(cleanup.cwd, "/app/data/users/101/vault");
  assert.match(memory.argv.at(-2) ?? "", /container-maintenance\.ts$/u);
  assert.equal(memory.argv.at(-1), "memory");
  assert.equal(memory.env.HOME, "/app/data/users/101");
});

void test("container runtime status reports scheduler freshness truthfully", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "iva-container-status-"));
  const now = Date.parse("2026-08-09T10:00:00.000Z");
  assert.equal(readContainerRuntimeStatus(dataDir, now).scheduler, "missing");
  await writeSchedulerHeartbeat(dataDir, {
    now,
    users: 1,
    delivered: 0,
    failed: 0,
    recovered: 0,
  });
  assert.equal(
    readContainerRuntimeStatus(dataDir, now + 10_000).scheduler,
    "ready",
  );
  assert.equal(
    readContainerRuntimeStatus(dataDir, now + 120_000).scheduler,
    "stale",
  );
});

void test("production image includes flock for bounded memory maintenance", async () => {
  const containerfile = await readFile(
    new URL("../../Containerfile", import.meta.url),
    "utf8",
  );
  const runtime =
    containerfile.split("FROM node:24-bookworm-slim AS runtime")[1] ?? "";
  assert.match(runtime, /\n {4}util-linux \\\n/u);
});
