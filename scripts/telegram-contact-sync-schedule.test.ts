/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./lib/ts-esm-hooks.ts";

const { default: schedule } =
  await import("../agent/schedules/telegram-contact-sync.ts");
const { contactAnalysisEnabled, contactAnalysisJob } =
  await import("../agent/lib/schedule-paths.ts");

test("contact sync schedule runs every fifteen minutes", () => {
  assert.equal(schedule.cron, "*/15 * * * *");
  const source = readFileSync(
    new URL("../agent/schedules/telegram-contact-sync.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /runScheduledJob\(contactAnalysisJob\(\)\)/u);
  assert.match(source, /contactAnalysisEnabled\(\)/u);
});

test("contact sync runs only for the owner in multi-user mode", () => {
  assert.equal(contactAnalysisEnabled({}), true);
  assert.equal(
    contactAnalysisEnabled({
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "owner",
    }),
    true,
  );
  assert.equal(
    contactAnalysisEnabled({
      ASSISTANT_MULTI_USER: "1",
      ASSISTANT_ROLE: "user",
    }),
    false,
  );
});

test("contact analysis schedule uses the shared lock, status and bounded guards", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "iva-contact-schedule-")),
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const job = contactAnalysisJob();
    assert.deepEqual(
      { ...job, env: undefined },
      {
        name: "telegram-contact-sync",
        argv: ["scripts/contact-analysis.ts", "sync"],
        root,
        nodeBin: process.execPath,
        lockPath: join(root, ".contact-analysis.lock"),
        statusPath: join(root, "data", "rollup-status.json"),
        timeoutMs: 24 * 60 * 60 * 1000,
        guardMs: 10 * 60 * 1000,
        env: undefined,
      },
    );
    assert.equal(job.env.IVA_CONTACT_ANALYSIS_LOCK_HELD, "1");
  } finally {
    process.chdir(previous);
  }
});
