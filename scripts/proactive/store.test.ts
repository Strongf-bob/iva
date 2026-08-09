import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommitmentSuggestion } from "./contracts.ts";
import { ProactiveStore } from "./store.ts";

function root(t: test.TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "iva-proactive-store-"));
  chmodSync(path, 0o700);
  t.after(() => {});
  return path;
}

const suggestion: CommitmentSuggestion = {
  id: "commitment-1",
  title: "Prepare the launch note",
  dueAt: Date.parse("2026-08-11T09:00:00.000Z"),
  evidence: ["telegram:message:1:2"],
};

void test("report versions are immutable, deduplicated by source fingerprint, and survive reopen", (t) => {
  const dataDir = root(t);
  let store = ProactiveStore.open(dataDir);
  const first = store.saveReportVersion({
    kind: "daily",
    periodKey: "2026-08-10",
    sourceFingerprint: "a".repeat(64),
    body: "Version one",
    suggestions: [suggestion],
    alerts: [],
    preparedAt: 100,
  });
  const duplicate = store.saveReportVersion({
    kind: "daily",
    periodKey: "2026-08-10",
    sourceFingerprint: "a".repeat(64),
    body: "Version one",
    suggestions: [suggestion],
    alerts: [],
    preparedAt: 200,
  });
  const second = store.saveReportVersion({
    kind: "daily",
    periodKey: "2026-08-10",
    sourceFingerprint: "b".repeat(64),
    body: "Version two",
    suggestions: [],
    alerts: [],
    preparedAt: 300,
  });

  assert.equal(first.version, 1);
  assert.equal(duplicate.id, first.id);
  assert.equal(second.version, 2);
  store.close();
  store = ProactiveStore.open(dataDir);
  assert.deepEqual(store.latestReadyVersion("daily", "2026-08-10"), second);
  store.close();

  assert.equal(lstatSync(join(dataDir, "proactive-reviews")).mode & 0o077, 0);
  assert.equal(
    lstatSync(join(dataDir, "proactive-reviews/state.sqlite")).mode & 0o077,
    0,
  );
});

void test("delivery admission has one winner and a receipt prevents restart duplicates", (t) => {
  const dataDir = root(t);
  let store = ProactiveStore.open(dataDir);
  const claim = {
    deliveryKey: "owner:daily:2026-08-10",
    versionIds: [1],
    dueAt: 1_000,
    expiresAt: 2_000,
    nowMs: 1_000,
  } as const;

  assert.equal(store.claimDelivery(claim)?.attempt, 1);
  assert.equal(store.claimDelivery(claim), null);
  store.recordDeliveryFailure({
    deliveryKey: claim.deliveryKey,
    kind: "retryable",
    code: "telegram-503",
    nextAttemptAt: 1_100,
    nowMs: 1_001,
  });
  assert.equal(store.claimDelivery({ ...claim, nowMs: 1_099 }), null);
  assert.equal(store.claimDelivery({ ...claim, nowMs: 1_100 })?.attempt, 2);
  store.completeDelivery(claim.deliveryKey, "message:42", 1_101);
  store.close();

  store = ProactiveStore.open(dataDir);
  assert.equal(store.claimDelivery({ ...claim, nowMs: 1_500 }), null);
  assert.equal(store.delivery(claim.deliveryKey)?.state, "delivered");
  store.close();
});

void test("ambiguous delivery is retained and never automatically reclaimed", (t) => {
  const store = ProactiveStore.open(root(t));
  const claim = {
    deliveryKey: "owner:daily:ambiguous",
    versionIds: [7],
    dueAt: 1_000,
    expiresAt: 2_000,
    nowMs: 1_000,
  } as const;
  store.claimDelivery(claim);
  store.recordDeliveryFailure({
    deliveryKey: claim.deliveryKey,
    kind: "ambiguous",
    code: "transport-lost",
    nextAttemptAt: null,
    nowMs: 1_001,
  });
  assert.equal(store.claimDelivery({ ...claim, nowMs: 1_500 }), null);
  assert.equal(store.delivery(claim.deliveryKey)?.state, "ambiguous");
  store.close();
});

void test("commitment tokens are stored only as hashes and task execution is idempotent", (t) => {
  const dataDir = root(t);
  let store = ProactiveStore.open(dataDir);
  const [action] = store.createCommitmentActions({
    ownerId: "101",
    reportVersionId: 9,
    suggestions: [suggestion],
    tokenSecret: "s".repeat(32),
    nowMs: 1_000,
  });
  assert.match(action.token, /^[A-Za-z0-9_-]{32,64}$/u);
  const databaseBytes = readFileSync(
    join(dataDir, "proactive-reviews/state.sqlite"),
  );
  assert.equal(databaseBytes.includes(Buffer.from(action.token)), false);

  assert.equal(
    store.decideCommitment({
      token: action.token,
      ownerId: "202",
      decision: "confirmed",
      nowMs: 1_100,
    }).status,
    "rejected",
  );
  assert.equal(
    store.decideCommitment({
      token: action.token,
      ownerId: "101",
      decision: "confirmed",
      nowMs: 1_100,
    }).status,
    "accepted",
  );
  assert.equal(
    store.decideCommitment({
      token: action.token,
      ownerId: "101",
      decision: "dismissed",
      nowMs: 1_200,
    }).status,
    "already-decided",
  );

  const work = store.claimConfirmedCommitment(1_300);
  assert.ok(work);
  assert.equal(work?.suggestion.id, suggestion.id);
  assert.match(work?.idempotencyKey ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(store.claimConfirmedCommitment(1_301), null);
  store.completeCommitmentTask(work.actionHash, "google-task:abc", 1_400);
  store.close();

  store = ProactiveStore.open(dataDir);
  assert.equal(store.claimConfirmedCommitment(2_000), null);
  store.close();
});

void test("dismissed commitments never become task work", (t) => {
  const store = ProactiveStore.open(root(t));
  const [action] = store.createCommitmentActions({
    ownerId: "101",
    reportVersionId: 9,
    suggestions: [suggestion],
    tokenSecret: "s".repeat(32),
    nowMs: 1_000,
  });
  store.decideCommitment({
    token: action.token,
    ownerId: "101",
    decision: "dismissed",
    nowMs: 1_100,
  });
  assert.equal(store.claimConfirmedCommitment(1_200), null);
  store.close();
});

void test("a symlinked proactive state directory is rejected before opening SQLite", (t) => {
  const dataDir = root(t);
  const outside = root(t);
  symlinkSync(outside, join(dataDir, "proactive-reviews"));
  assert.throws(
    () => ProactiveStore.open(dataDir),
    /must not be a symbolic link/u,
  );
});
