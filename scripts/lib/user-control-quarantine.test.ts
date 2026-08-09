import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enqueueQueueFile, loadQueueFile } from "./telegram-queue.ts";
import { quarantineUserControlState } from "./user-control-quarantine.ts";
import { chargeUserIngress } from "./user-quota.ts";
import { defaultUserLimits, parseTelegramUserId } from "./user-registry.ts";

void test("delete quarantine removes only the selected tenant gateway state", async () => {
  const data = await mkdtemp(join(tmpdir(), "iva-user-control-quarantine-"));
  const control = join(data, "control");
  const destination = join(data, "quarantine/user-101");
  const id = parseTelegramUserId("101")!;
  const queue = join(data, "telegram-queue.json");
  await enqueueQueueFile(
    queue,
    "101:",
    {
      update_id: 1,
      message: { from: { id: 101 }, chat: { id: 101, type: "private" } },
    },
    { tenantId: "101" },
  );
  await enqueueQueueFile(
    queue,
    "202:",
    {
      update_id: 2,
      message: { from: { id: 202 }, chat: { id: 202, type: "private" } },
    },
    { tenantId: "202" },
  );
  await chargeUserIngress(control, id, defaultUserLimits(), { ingressId: "1" });
  const encoded = Buffer.from("101:").toString("base64url");
  await mkdir(join(data, "run-status.d"), { recursive: true });
  await mkdir(join(data, "telegram-reset-intents"), { recursive: true });
  await writeFile(join(data, "run-status.d", `${encoded}.json`), "{}\n");
  await writeFile(
    join(data, "telegram-reset-intents", `${encoded}.json`),
    "{}\n",
  );

  await quarantineUserControlState(data, control, id, destination);

  const remaining = await loadQueueFile(queue, { strict: true });
  assert.equal(remaining.document.queues["101:"], undefined);
  assert.equal(remaining.document.queues["202:"]?.length, 1);
  assert.equal(existsSync(join(control, "quota/101.json")), false);
  assert.equal(existsSync(join(destination, "gateway-state/quota.json")), true);
  assert.equal(
    existsSync(join(destination, "gateway-state/run-status.json")),
    true,
  );
  assert.equal(
    existsSync(join(destination, "gateway-state/telegram-reset-intent.json")),
    true,
  );
  const snapshot = await readFile(
    join(destination, "gateway-state/telegram-queue.json"),
    "utf8",
  );
  assert.match(snapshot, /"updateId": 1/u);
});
