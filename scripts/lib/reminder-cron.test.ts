import assert from "node:assert/strict";
import test from "node:test";

import { nextCronOccurrence, parseCronExpression } from "./reminder-cron.ts";

void test("cron finds Monday 08:00 in the configured timezone", () => {
  const after = Date.parse("2026-08-09T00:00:00.000Z");
  assert.equal(
    nextCronOccurrence("0 8 * * 1", "Europe/Moscow", after),
    Date.parse("2026-08-10T05:00:00.000Z"),
  );
});

void test("cron accepts ranges, lists, steps, and Sunday 7", () => {
  const expression = parseCronExpression("*/15 8-10 * 1,6 0,7");
  assert.deepEqual([...expression.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...expression.hours], [8, 9, 10]);
  assert.deepEqual([...expression.months], [1, 6]);
  assert.deepEqual([...expression.weekdays], [0]);
});

void test("cron rejects aliases and out-of-range fields", () => {
  assert.throws(() => parseCronExpression("@daily"), /five fields/u);
  assert.throws(() => parseCronExpression("60 8 * * *"), /minute/u);
  assert.throws(() => parseCronExpression("0 8 * * */0"), /step/u);
});

void test("cron skips a nonexistent DST wall-clock minute", () => {
  const after = Date.parse("2026-03-29T00:00:00.000Z");
  assert.equal(
    nextCronOccurrence("30 2 * * *", "Europe/Berlin", after),
    Date.parse("2026-03-30T00:30:00.000Z"),
  );
});

void test("cron preserves both occurrences of a repeated DST wall-clock minute", () => {
  const first = Date.parse("2026-10-25T00:30:00.000Z");
  assert.equal(
    nextCronOccurrence("30 2 * * *", "Europe/Berlin", first),
    Date.parse("2026-10-25T01:30:00.000Z"),
  );
});

void test("cron finds the next leap day across the century-safe maximum gap", () => {
  const after = Date.parse("2028-02-29T00:00:00.000Z");
  assert.equal(
    nextCronOccurrence("0 0 29 2 *", "UTC", after),
    Date.parse("2032-02-29T00:00:00.000Z"),
  );
});
