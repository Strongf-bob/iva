import assert from "node:assert/strict";
import { test } from "node:test";

import {
  desiredWorkerUnits,
  renderWorkerUnit,
  workerServiceName,
} from "./worker-units.ts";
import {
  defaultUserLimits,
  parseTelegramUserId,
  type UserRecord,
  type UserRegistry,
} from "./user-registry.ts";
import { resolveUserLayout } from "./user-layout.ts";

function user(
  id: string,
  status: "active" | "blocked" | "provisioning" = "active",
): UserRecord {
  return {
    id: parseTelegramUserId(id)!,
    role: id === "123" ? "owner" : "user",
    status,
    port: 8800 + Number(id),
    limits: defaultUserLimits(),
    createdAt: "2026-08-07T10:00:00.000Z",
  };
}

const runtime = {
  appRoot: "/srv/iva",
  nodePath: "/usr/bin/node",
  envFile: "/srv/iva/.env",
  controlDir: "/srv/iva/data/control",
  dataDir: "/srv/iva/data",
  usersDir: "/srv/iva/data/users",
  timezone: "Europe/Moscow",
};

void test("worker service names accept only branded canonical Telegram IDs", () => {
  assert.equal(
    workerServiceName(parseTelegramUserId("123")!),
    "iva-worker-123.service",
  );
});

void test("worker unit fixes cwd, identity, port, paths, and loopback bootstrap", () => {
  const record = user("123");
  const layout = resolveUserLayout(runtime.usersDir, record.id);
  const unit = renderWorkerUnit(record, layout, runtime);

  assert.match(unit, /WorkingDirectory=\/srv\/iva\/data\/users\/123\/runtime/u);
  assert.match(unit, /Environment="IVA_WORKER_USER_ID=123"/u);
  assert.match(unit, /Environment="IVA_WORKER_PORT=8923"/u);
  assert.match(
    unit,
    /Environment="IVA_WORKER_CONTROL_DIR=\/srv\/iva\/data\/control"/u,
  );
  assert.match(
    unit,
    /Environment="IVA_WORKER_USERS_DIR=\/srv\/iva\/data\/users"/u,
  );
  assert.match(unit, /Environment="IVA_RUN_STATUS_DATA_DIR=\/srv\/iva\/data"/u);
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node \/srv\/iva\/scripts\/worker-entry\.ts/u,
  );
  assert.doesNotMatch(unit, /TELEGRAM_ALLOWED_USER_IDS=.*,/u);
  assert.doesNotMatch(unit, /0\.0\.0\.0/u);
});

void test("desired units contain active and non-routable provisioning users", () => {
  const registry: UserRegistry = {
    schema: "iva-users/v1",
    revision: 3,
    users: [user("123"), user("456", "blocked"), user("789", "provisioning")],
  };

  const units = desiredWorkerUnits(registry, runtime);

  assert.deepEqual(
    [...units.keys()],
    ["iva-worker-123.service", "iva-worker-789.service"],
  );
  assert.match(units.get("iva-worker-123.service")!, /IVA_WORKER_USER_ID=123/u);
});
