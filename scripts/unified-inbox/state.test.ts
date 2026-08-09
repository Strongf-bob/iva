/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration. */
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InboxStateSchema,
  inboxStatePaths,
  loadInboxState,
  pruneInboxState,
  recordClassifications,
  recordSourceFailure,
  reduceObservationPage,
  saveInboxState,
  selectReportingObservations,
  withInboxLock,
} from "./state.ts";
import {
  InboxObservationSchema,
  ObservationPageSchema,
  canonicalObservationId,
  type InboxObservation,
  type ObservationPage,
} from "./types.ts";

const occurredAt = "2026-08-09T05:30:00.000Z";

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-unified-inbox-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function observation(revision = "100"): InboxObservation {
  const identity = {
    source: "gmail" as const,
    sourceAccountId: "me",
    externalId: "message-7",
  };
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision,
    kind: "message",
    occurredAt,
    updatedAt: occurredAt,
    title: "Project review",
    excerpt: `Revision ${revision}`,
    actor: {
      id: "alice@example.com",
      label: "Alice",
      address: "alice@example.com",
    },
    participants: [],
    threadId: "thread-3",
    evidence: {
      source: "gmail",
      externalId: "message-7",
      timestamp: occurredAt,
      locator: "Gmail message message-7",
    },
  });
}

function page(
  order = 100,
  item: InboxObservation = observation(),
): ObservationPage {
  return ObservationPageSchema.parse({
    schemaVersion: 1,
    source: "gmail",
    sourceAccountId: "me",
    cursor: { key: "gmail", value: String(order), order },
    observations: [item],
  });
}

test("fresh state is owner scoped and saved with private filesystem modes", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const state = await loadInboxState(paths);

  assert.equal(state.ownerId, "7");
  assert.deepEqual(state.cursors, {});
  await saveInboxState(paths, state);

  assert.equal((await lstat(paths.baseDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(paths.ownerDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(paths.stateFile)).mode & 0o777, 0o600);
  const persisted: unknown = JSON.parse(
    await readFile(paths.stateFile, "utf8"),
  );
  assert.equal(
    typeof persisted === "object" &&
      persisted !== null &&
      "ownerId" in persisted
      ? persisted.ownerId
      : undefined,
    "7",
  );
});

test("a replayed page keeps one observation and one fingerprint", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  let state = reduceObservationPage(await loadInboxState(paths), page());
  await saveInboxState(paths, state);

  state = reduceObservationPage(await loadInboxState(paths), page());
  assert.equal(Object.keys(state.observations).length, 1);
  assert.equal(state.processedFingerprints.length, 1);
  assert.equal(state.cursors.gmail?.order, 100);
});

test("a new revision replaces the stable observation and keeps both fingerprints", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  let state = reduceObservationPage(await loadInboxState(paths), page());
  state = reduceObservationPage(state, page(101, observation("101")));

  assert.equal(Object.keys(state.observations).length, 1);
  assert.equal(state.observations[observation().id]?.revision, "101");
  assert.equal(state.processedFingerprints.length, 2);
  assert.equal(state.cursors.gmail?.order, 101);
});

test("cursor regression fails before the persisted state is overwritten", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const state = reduceObservationPage(await loadInboxState(paths), page(100));
  await saveInboxState(paths, state);

  assert.throws(
    () => reduceObservationPage(state, page(99)),
    /unified_inbox_cursor_regression/u,
  );
  assert.equal((await loadInboxState(paths)).cursors.gmail?.order, 100);
});

test("schema and owner mismatches are quarantined and fail closed", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  await saveInboxState(paths, await loadInboxState(paths));
  const raw = InboxStateSchema.parse(
    JSON.parse(await readFile(paths.stateFile, "utf8")) as unknown,
  );
  await writeFile(
    paths.stateFile,
    JSON.stringify({ ...raw, ownerId: "8" }),
    "utf8",
  );

  await assert.rejects(
    () => loadInboxState(paths),
    /unified_inbox_state_invalid/u,
  );
  const names = await readdir(paths.ownerDir);
  assert.equal(
    names.some((name) => name.startsWith("state.json.trash-schema-")),
    true,
  );
});

test("state directories reject existing symbolic links", async (t) => {
  const root = await temporaryRoot(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(root, "data"));
  const paths = inboxStatePaths(root, "data", "7");

  await assert.rejects(() => loadInboxState(paths), /symbolic link/u);
});

test("pipeline lock serializes concurrent state operations", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const events: string[] = [];
  let releaseFirst!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withInboxLock(paths, async () => {
    events.push("first:start");
    await hold;
    events.push("first:end");
  });
  while (!events.includes("first:start"))
    await new Promise((resolve) => setTimeout(resolve, 5));
  const second = withInboxLock(paths, () => {
    events.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("reporting selection is timestamp based and source failures are sanitized", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  let state = reduceObservationPage(await loadInboxState(paths), page());
  state = recordSourceFailure(
    state,
    "gmail",
    new Error("token alice@example.com"),
  );

  assert.deepEqual(
    selectReportingObservations(
      state,
      new Date("2026-08-10T05:30:00.000Z"),
    ).map((item) => item.id),
    [observation().id],
  );
  assert.equal(
    state.sourceHealth.gmail?.errorCode,
    "unified_inbox_source_failed",
  );
  assert.equal(JSON.stringify(state).includes("alice@example.com"), true);
  assert.equal(
    JSON.stringify(state.sourceHealth).includes("alice@example.com"),
    false,
  );
});

test("retention prunes expired non-actionable observations by source timestamp", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const makeObservation = (
    externalId: string,
    sourceTimestamp: string,
  ): InboxObservation => {
    const identity = {
      source: "gmail" as const,
      sourceAccountId: "me",
      externalId,
    };
    return InboxObservationSchema.parse({
      ...observation(),
      ...identity,
      id: canonicalObservationId(identity),
      occurredAt: sourceTimestamp,
      updatedAt: sourceTimestamp,
      evidence: {
        source: "gmail",
        externalId,
        timestamp: sourceTimestamp,
        locator: `Gmail message ${externalId}`,
      },
    });
  };
  const oldInfo = makeObservation("old-info", "2026-07-01T00:00:00.000Z");
  const oldUrgent = makeObservation("old-urgent", "2026-07-01T00:00:00.000Z");
  const recentIgnore = makeObservation(
    "recent-ignore",
    "2026-08-31T00:00:00.000Z",
  );
  let state = await loadInboxState(paths);
  for (const [order, item] of [oldInfo, oldUrgent, recentIgnore].entries()) {
    state = reduceObservationPage(state, page(order + 1, item));
  }
  state = recordClassifications(state, {
    [oldInfo.id]: "informational",
    [oldUrgent.id]: "urgent",
    [recentIgnore.id]: "ignorable",
  });

  const pruned = pruneInboxState(state, new Date("2026-09-01T00:00:00.000Z"));

  assert.equal(pruned.observations[oldInfo.id], undefined);
  assert.equal(pruned.classifications[oldInfo.id], undefined);
  assert.equal(pruned.observations[oldUrgent.id]?.id, oldUrgent.id);
  assert.equal(pruned.observations[recentIgnore.id]?.id, recentIgnore.id);
  assert.equal(pruned.processedFingerprints.length, 3);
});
