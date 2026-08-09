import assert from "node:assert/strict";
import test from "node:test";

import {
  alertAdmission,
  deliveryWindow,
  isPreparationDue,
  reviewPeriodsAt,
  retryDelayMs,
} from "./policy.ts";
import {
  commitmentSuggestionSchema,
  providerSnapshotSchema,
} from "./contracts.ts";

const ms = (iso: string) => Date.parse(iso);

void test("daily and weekly periods use Moscow wall time independently of host timezone", () => {
  const monday = reviewPeriodsAt(ms("2026-08-10T02:15:00.000Z"));

  assert.deepEqual(monday.daily, {
    kind: "daily",
    periodKey: "2026-08-10",
    prepareAt: ms("2026-08-10T02:00:00.000Z"),
    freezeAt: ms("2026-08-10T04:55:00.000Z"),
    dueAt: ms("2026-08-10T05:00:00.000Z"),
    expiresAt: ms("2026-08-10T17:00:00.000Z"),
  });
  assert.deepEqual(monday.weekly, {
    kind: "weekly",
    periodKey: "2026-W33",
    prepareAt: ms("2026-08-10T02:15:00.000Z"),
    freezeAt: ms("2026-08-10T04:55:00.000Z"),
    dueAt: ms("2026-08-10T05:00:00.000Z"),
    expiresAt: ms("2026-08-13T05:00:00.000Z"),
  });
});

void test("preparation, freeze, exact due and missed-run windows have explicit boundaries", () => {
  const { daily, weekly } = reviewPeriodsAt(ms("2026-08-10T01:59:59.999Z"));

  assert.equal(isPreparationDue(daily, daily.prepareAt - 1), false);
  assert.equal(isPreparationDue(daily, daily.prepareAt), true);
  assert.equal(isPreparationDue(daily, daily.freezeAt), false);
  assert.equal(isPreparationDue(weekly, weekly.prepareAt - 1), false);
  assert.equal(isPreparationDue(weekly, weekly.prepareAt), true);
  assert.equal(deliveryWindow(daily, daily.dueAt - 1), "early");
  assert.equal(deliveryWindow(daily, daily.dueAt), "due");
  assert.equal(deliveryWindow(daily, daily.dueAt + 5 * 60_000), "late");
  assert.equal(deliveryWindow(daily, daily.expiresAt), "late");
  assert.equal(deliveryWindow(daily, daily.expiresAt + 1), "expired");
});

void test("weekly period remains the same through Sunday and is expired after Thursday", () => {
  const sunday = reviewPeriodsAt(ms("2026-08-16T09:00:00.000Z")).weekly;
  assert.equal(sunday.periodKey, "2026-W33");
  assert.equal(
    deliveryWindow(sunday, ms("2026-08-16T09:00:00.000Z")),
    "expired",
  );
});

void test("retry backoff doubles and caps at thirty minutes", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 20].map(retryDelayMs),
    [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000],
  );
});

void test("high alerts defer in quiet hours and obey six-hour cooldown", () => {
  const quiet = ms("2026-08-09T20:00:00.000Z"); // 23:00 Moscow
  assert.deepEqual(alertAdmission("high", quiet, null), {
    action: "defer",
    until: ms("2026-08-10T05:00:00.000Z"),
  });
  const delivered = ms("2026-08-10T06:00:00.000Z");
  assert.deepEqual(alertAdmission("high", delivered + 60 * 60_000, delivered), {
    action: "cooldown",
    until: delivered + 6 * 60 * 60_000,
  });
  assert.deepEqual(
    alertAdmission("high", delivered + 6 * 60 * 60_000, delivered),
    { action: "send" },
  );
});

void test("critical alerts bypass quiet hours but use one-hour cooldown", () => {
  const quiet = ms("2026-08-09T20:00:00.000Z");
  assert.deepEqual(alertAdmission("critical", quiet, null), {
    action: "send",
  });
  assert.deepEqual(alertAdmission("critical", quiet + 30 * 60_000, quiet), {
    action: "cooldown",
    until: quiet + 60 * 60_000,
  });
});

void test("provider schemas reject unbounded or source-free material", () => {
  assert.equal(
    commitmentSuggestionSchema.safeParse({
      id: "commitment-1",
      title: "Prepare report",
      evidence: [],
    }).success,
    false,
  );
  assert.equal(
    providerSnapshotSchema.safeParse({
      inbox: [],
      crm: [],
      calendar: [],
      tasks: [],
      collectedAt: ms("2026-08-10T02:00:00.000Z"),
    }).success,
    true,
  );
  assert.equal(
    providerSnapshotSchema.safeParse({
      inbox: Array.from({ length: 501 }, (_, index) => ({
        id: String(index),
        title: "x",
        evidence: ["source:x"],
      })),
      crm: [],
      calendar: [],
      tasks: [],
      collectedAt: 1,
    }).success,
    false,
  );
});
