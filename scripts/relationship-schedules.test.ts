/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const [name, cron] of [
  ["relationship-daily-prepare", "45 7 * * *"],
  ["relationship-daily-deliver", "0 8 * * *"],
  ["relationship-weekly-prepare", "45 7 * * 1"],
  ["relationship-weekly-deliver", "0 8 * * 1"],
] as const) {
  test(`${name} uses the approved cron and owner guard`, async () => {
    const text = await readFile(
      new URL(`../agent/schedules/${name}.ts`, import.meta.url),
      "utf8",
    );
    assert.match(
      text,
      new RegExp(`cron: ["']${cron.replaceAll("*", "\\*")}["']`, "u"),
    );
    assert.match(text, /ASSISTANT_ROLE.*owner/u);
    assert.match(text, /runScheduledJob/u);
  });
}
