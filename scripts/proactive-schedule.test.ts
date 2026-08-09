import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./lib/ts-esm-hooks.ts";

const { default: schedule } =
  await import("../agent/schedules/proactive-reviews.ts");
const { proactiveReviewsEnabled, proactiveReviewsJob } =
  await import("../agent/lib/schedule-paths.ts");

void test("proactive review reconciler runs on every five-minute boundary", () => {
  assert.equal(schedule.cron, "*/5 * * * *");
  const source = readFileSync(
    new URL("../agent/schedules/proactive-reviews.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /runScheduledJob\(proactiveReviewsJob\(\)\)/u);
  assert.match(source, /proactiveReviewsEnabled\(settings/u);
});

void test("proactive reviews are opt-in and owner-only in multi-user mode", () => {
  assert.equal(proactiveReviewsEnabled({}, {}), false);
  assert.equal(
    proactiveReviewsEnabled({ proactiveReviews: { enabled: true } }, {}),
    true,
  );
  assert.equal(
    proactiveReviewsEnabled(
      { proactiveReviews: { enabled: true } },
      { ASSISTANT_MULTI_USER: "1", ASSISTANT_ROLE: "owner" },
    ),
    true,
  );
  assert.equal(
    proactiveReviewsEnabled(
      { proactiveReviews: { enabled: true } },
      { ASSISTANT_MULTI_USER: "1", ASSISTANT_ROLE: "user" },
    ),
    false,
  );
});

void test("schedule job uses personal status, a short guard and the TypeScript entrypoint", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "iva-proactive-schedule-")),
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(proactiveReviewsJob(), {
      name: "proactive-reviews",
      argv: ["scripts/proactive/run.ts"],
      root,
      nodeBin: process.execPath,
      statusPath: join(root, "data", "rollup-status.json"),
      timeoutMs: 4 * 60_000,
      guardMs: 4 * 60_000,
    });
  } finally {
    process.chdir(previous);
  }
});

void test("cron menu includes the proactive reconciler cadence", () => {
  const source = readFileSync(
    new URL("./lib/menu/crons.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\{ name: "proactive-reviews", cron: "\*\/5 \* \* \* \*" \}/u,
  );
});
