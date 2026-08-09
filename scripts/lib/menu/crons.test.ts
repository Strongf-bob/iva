/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import crons, { openTaskCount } from "./crons.ts";
import { createReminder } from "../reminder-store.ts";

test("openTaskCount reports only open tasks for array and wrapped storage shapes", () => {
  for (const [value, expected] of [
    [
      [
        { text: "open" },
        { text: "done", done: true },
        { text: "explicit open", done: false },
      ],
      2,
    ] as const,
    [{ tasks: [{ text: "open" }, { text: "done", done: true }] }, 1] as const,
  ]) {
    const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
    try {
      writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(value));
      assert.equal(openTaskCount(dataDir), expected);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test("openTaskCount preserves truthy legacy done semantics", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
  try {
    writeFileSync(
      join(dataDir, "tasks.json"),
      JSON.stringify([
        { text: "numeric done", done: 1 },
        { text: "string done", done: "yes" },
        { text: "boolean done", done: true },
        { text: "explicit open", done: false },
        { text: "open" },
      ]),
    );
    assert.equal(openTaskCount(dataDir), 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("container timers screen lists personal reminders without host timer claims", async () => {
  const globalData = mkdtempSync(join(tmpdir(), "iva-menu-container-crons-"));
  const personalRoot = join(globalData, "users", "101");
  const personalData = join(personalRoot, "runtime", "data");
  mkdirSync(personalData, { recursive: true });
  writeFileSync(
    join(globalData, "settings.json"),
    JSON.stringify({ digestSchedule: { enabled: false } }),
  );
  writeFileSync(
    join(personalData, "settings.json"),
    JSON.stringify({ digestSchedule: { enabled: true } }),
  );
  await createReminder(
    personalData,
    {
      idempotencyKey: "menu-1",
      message: "Private reminder",
      timezone: "UTC",
      schedule: { kind: "once", at: "2026-08-10T11:00:00.000Z" },
    },
    { now: () => Date.parse("2026-08-09T10:00:00.000Z") },
  );
  const view = await crons.render(
    { page: 0, personalRoot },
    {
      deps: { dataDir: globalData, runtime: "container" },
      tr: (en: string) => en,
      btn: (text: string, callbackData: string) => ({
        text,
        callback_data: callbackData,
      }),
      backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    },
  );
  assert.match(view.text, /Private reminder/u);
  assert.match(view.text, /Personal reminders/u);
  assert.doesNotMatch(view.text, /No Iva timers found/u);
  assert.doesNotMatch(view.text, /digest .*disabled/u);
  for (const schedule of [
    "relationship-daily-prepare",
    "relationship-daily-deliver",
    "relationship-weekly-prepare",
    "relationship-weekly-deliver",
  ]) {
    assert.match(view.text, new RegExp(schedule, "u"));
  }
});

test("container timers screen reports corrupt personal reminder storage", async () => {
  const globalData = mkdtempSync(join(tmpdir(), "iva-menu-container-crons-"));
  const personalRoot = join(globalData, "users", "101");
  const personalData = join(personalRoot, "runtime", "data");
  mkdirSync(personalData, { recursive: true });
  writeFileSync(join(personalData, "reminders.json"), "{broken");
  const view = await crons.render(
    { page: 0, personalRoot },
    {
      deps: { dataDir: globalData, runtime: "container" },
      tr: (en: string) => en,
      btn: (text: string, callbackData: string) => ({
        text,
        callback_data: callbackData,
      }),
      backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    },
  );

  assert.match(view.text, /Reminder data unavailable/u);
  assert.doesNotMatch(view.text, /No active reminders/u);
});
