import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProviderFailure,
  type BotDelivery,
  type CommitmentSuggestion,
  type ProactiveProviders,
  type ProviderWindow,
  type UrgentAlert,
} from "./contracts.ts";
import { reconcileProactiveReviews } from "./reconciler.ts";
import { ProactiveStore } from "./store.ts";

const ms = (iso: string) => Date.parse(iso);

function harness(
  t: test.TestContext,
  options?: {
    readonly suggestions?: readonly CommitmentSuggestion[];
    readonly alerts?: readonly UrgentAlert[];
    readonly weeklyFailures?: number;
  },
) {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-proactive-reconcile-"));
  chmodSync(dataDir, 0o700);
  const store = ProactiveStore.open(dataDir);
  t.after(() => store.close());
  const calls = {
    inbox: [] as ProviderWindow[],
    crm: [] as ProviderWindow[],
    calendar: [] as ProviderWindow[],
    tasksRead: [] as ProviderWindow[],
    compose: [] as string[],
    deliveries: [] as BotDelivery[],
    alerts: [] as UrgentAlert[],
    tasksCreated: [] as string[],
  };
  let deliveryFailure: ProviderFailure | null = null;
  let weeklyFailuresRemaining = options?.weeklyFailures ?? 0;
  const providers: ProactiveProviders = {
    inbox: {
      listInbox(window) {
        calls.inbox.push(window);
        return Promise.resolve([
          { id: "mail-1", title: "Reply", evidence: ["gmail:1"] },
        ]);
      },
    },
    crm: {
      listRelationshipUpdates(window) {
        calls.crm.push(window);
        return Promise.resolve([
          { id: "crm-1", title: "Follow up", evidence: ["crm:1"] },
        ]);
      },
    },
    calendar: {
      listCalendarItems(window) {
        calls.calendar.push(window);
        return Promise.resolve([
          { id: "event-1", title: "Meeting", evidence: ["gcal:1"] },
        ]);
      },
    },
    tasks: {
      listTasks(window) {
        calls.tasksRead.push(window);
        return Promise.resolve([
          { id: "task-1", title: "Open task", evidence: ["gtask:1"] },
        ]);
      },
      createConfirmedCommitment({ idempotencyKey }) {
        calls.tasksCreated.push(idempotencyKey);
        return Promise.resolve({ receipt: `google:${idempotencyKey}` });
      },
    },
    composer: {
      compose({ period }) {
        calls.compose.push(period.kind);
        if (period.kind === "weekly" && weeklyFailuresRemaining > 0) {
          weeklyFailuresRemaining -= 1;
          return Promise.reject(
            new ProviderFailure("retryable", "weekly-not-ready"),
          );
        }
        return Promise.resolve({
          body: `${period.kind} prepared report`,
          sourceFingerprint: "ignored-by-reconciler",
          suggestions: options?.suggestions ?? [],
          alerts: options?.alerts ?? [],
        });
      },
    },
    bot: {
      deliver(input) {
        calls.deliveries.push(input);
        if (deliveryFailure) {
          const failure = deliveryFailure;
          deliveryFailure = null;
          return Promise.reject(failure);
        }
        return Promise.resolve({
          receipt: `telegram:${calls.deliveries.length}`,
        });
      },
      deliverAlert({ alert }) {
        calls.alerts.push(alert);
        return Promise.resolve({
          receipt: `telegram-alert:${calls.alerts.length}`,
        });
      },
    },
  };
  return {
    store,
    providers,
    calls,
    failNextDelivery(failure: ProviderFailure) {
      deliveryFailure = failure;
    },
  };
}

const run = (
  value: ReturnType<typeof harness>,
  nowMs: number,
  settings: { readonly tokenSecret?: string } = {},
) =>
  reconcileProactiveReviews({
    nowMs,
    ownerId: "101",
    store: value.store,
    providers: value.providers,
    settings: { tokenSecret: settings.tokenSecret ?? "s".repeat(32) },
  });

void test("daily material is prepared at 05:00 and only the stored version is delivered at 08:00", async (t) => {
  const value = harness(t);
  const prepared = await run(value, ms("2026-08-11T02:00:00.000Z"));
  assert.deepEqual(prepared, {
    prepared: 1,
    delivered: 0,
    alertsDelivered: 0,
    tasksCreated: 0,
    expired: 0,
  });
  assert.equal(value.calls.inbox.length, 1);
  assert.equal(value.calls.crm.length, 1);
  assert.equal(value.calls.calendar.length, 1);
  assert.equal(value.calls.tasksRead.length, 1);
  assert.deepEqual(value.calls.compose, ["daily"]);
  assert.equal(value.calls.deliveries.length, 0);

  const delivered = await run(value, ms("2026-08-11T05:00:00.000Z"));
  assert.equal(delivered.delivered, 1);
  assert.equal(value.calls.compose.length, 1, "delivery never recomposes");
  assert.equal(value.calls.deliveries[0]?.body, "daily prepared report");
  assert.equal(value.calls.deliveries[0]?.late, false);
});

void test("Monday daily and weekly versions share one 08:00 delivery receipt", async (t) => {
  const value = harness(t);
  await run(value, ms("2026-08-10T02:15:00.000Z"));
  assert.deepEqual(value.calls.compose.sort(), ["daily", "weekly"]);

  const result = await run(value, ms("2026-08-10T05:00:00.000Z"));
  assert.equal(result.delivered, 1);
  assert.equal(value.calls.deliveries.length, 1);
  assert.match(value.calls.deliveries[0].body, /daily prepared report/u);
  assert.match(value.calls.deliveries[0].body, /weekly prepared report/u);
  assert.match(value.calls.deliveries[0].deliveryKey, /2026-08-10.*2026-W33/u);
});

void test("a late weekly version does not redeliver an already delivered Monday daily", async (t) => {
  const value = harness(t, { weeklyFailures: 2 });
  await run(value, ms("2026-08-10T02:15:00.000Z"));

  await run(value, ms("2026-08-10T05:00:00.000Z"));
  assert.equal(value.calls.deliveries.length, 1);
  assert.equal(value.calls.deliveries[0]?.body, "daily prepared report");

  await run(value, ms("2026-08-10T05:05:00.000Z"));
  assert.equal(value.calls.deliveries.length, 2);
  assert.equal(value.calls.deliveries[1]?.body, "weekly prepared report");
});

void test("a restart cannot redeliver a completed report", async (t) => {
  const value = harness(t);
  await run(value, ms("2026-08-11T02:00:00.000Z"));
  await run(value, ms("2026-08-11T05:00:00.000Z"));
  await run(value, ms("2026-08-11T05:05:00.000Z"));
  assert.equal(value.calls.deliveries.length, 1);
});

void test("definite delivery rejection retries after persisted backoff", async (t) => {
  const value = harness(t);
  await run(value, ms("2026-08-11T02:00:00.000Z"));
  value.failNextDelivery(new ProviderFailure("retryable", "telegram-503"));
  await run(value, ms("2026-08-11T05:00:00.000Z"));
  await run(value, ms("2026-08-11T05:00:59.000Z"));
  assert.equal(value.calls.deliveries.length, 1);
  await run(value, ms("2026-08-11T05:01:00.000Z"));
  assert.equal(value.calls.deliveries.length, 2);
});

void test("ambiguous Telegram transport outcome is not guessed or resent", async (t) => {
  const value = harness(t);
  await run(value, ms("2026-08-11T02:00:00.000Z"));
  value.failNextDelivery(new ProviderFailure("ambiguous", "transport-lost"));
  await run(value, ms("2026-08-11T05:00:00.000Z"));
  await run(value, ms("2026-08-11T06:00:00.000Z"));
  assert.equal(value.calls.deliveries.length, 1);
});

void test("a missed preparation is recovered and delivered late inside the window", async (t) => {
  const value = harness(t);
  await run(value, ms("2026-08-11T01:00:00.000Z"));
  const result = await run(value, ms("2026-08-11T09:00:00.000Z"));
  assert.equal(result.prepared, 1);
  assert.equal(result.delivered, 1);
  assert.equal(value.calls.deliveries[0]?.late, true);
});

void test("expired report periods are neither prepared nor delivered", async (t) => {
  const value = harness(t);
  await run(value, ms("2026-08-10T01:00:00.000Z"));
  const result = await run(value, ms("2026-08-16T17:00:00.001Z"));
  assert.equal(result.prepared, 0);
  assert.equal(result.delivered, 0);
  assert.ok(result.expired >= 1);
});

void test("critical alerts bypass quiet hours while high alerts wait until 08:00", async (t) => {
  const high: UrgentAlert = {
    fingerprint: "high-alert-00000001",
    severity: "high",
    title: "High",
    body: "High body",
    evidence: ["source:high"],
  };
  const critical: UrgentAlert = {
    fingerprint: "critical-alert-001",
    severity: "critical",
    title: "Critical",
    body: "Critical body",
    evidence: ["source:critical"],
  };
  const value = harness(t, { alerts: [high, critical] });
  await run(value, ms("2026-08-11T02:00:00.000Z")); // 05:00 Moscow
  assert.deepEqual(
    value.calls.alerts.map((alert) => alert.severity),
    ["critical"],
  );
  await run(value, ms("2026-08-11T05:00:00.000Z"));
  assert.deepEqual(value.calls.alerts.map((alert) => alert.severity).sort(), [
    "critical",
    "high",
  ]);
});

void test("commitment remains internal until owner confirmation, then creates one task", async (t) => {
  const suggestion: CommitmentSuggestion = {
    id: "commitment-1",
    title: "Prepare the launch note",
    evidence: ["telegram:message:1:2"],
  };
  const value = harness(t, { suggestions: [suggestion] });
  await run(value, ms("2026-08-11T02:00:00.000Z"));
  await run(value, ms("2026-08-11T05:00:00.000Z"));
  assert.equal(value.calls.tasksCreated.length, 0);
  const confirm = value.calls.deliveries[0]?.actions.find((action) =>
    action.callbackData.startsWith("iva_commitment:c:"),
  );
  assert.ok(confirm);
  const token = confirm.callbackData.slice("iva_commitment:c:".length);
  assert.equal(
    value.store.decideCommitment({
      token,
      ownerId: "101",
      decision: "confirmed",
      nowMs: ms("2026-08-11T05:01:00.000Z"),
    }).status,
    "accepted",
  );

  await run(value, ms("2026-08-11T05:05:00.000Z"));
  await run(value, ms("2026-08-11T05:10:00.000Z"));
  assert.equal(value.calls.tasksCreated.length, 1);
});
