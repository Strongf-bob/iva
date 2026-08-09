import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

void test("owner routing reconciliation precedes every Telegram queue mutation", () => {
  const reconciliation = mainSource.indexOf(
    "await reconcileTelegramOwnerRoute(",
  );
  const staleJobs = mainSource.indexOf("await removeStaleUpdateJobs()");
  const deleteWebhook = mainSource.indexOf('await tg("deleteWebhook"');
  const pollingLoop = mainSource.indexOf("for (;;)");

  assert.notEqual(reconciliation, -1, "reconciliation call is required");
  assert.ok(reconciliation < staleJobs, "reconcile before stale-job cleanup");
  assert.ok(reconciliation < deleteWebhook, "reconcile before deleteWebhook");
  assert.ok(reconciliation < pollingLoop, "reconcile before getUpdates loop");
});

void test("startup routing diagnostics never interpolate owner identity", () => {
  assert.match(
    mainSource,
    /owner routing: created legacy route|owner routing: ready/u,
  );
  assert.doesNotMatch(mainSource, /owner routing:.*\$\{/u);
  assert.match(
    mainSource,
    /console\.error\("telegram-poll fatal: startup or polling failed"\)/u,
  );
  assert.doesNotMatch(
    mainSource,
    /console\.error\("telegram-poll fatal:", error\)/u,
  );
});
