/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, require-yield -- Node's test runner owns registration; injected failure sources intentionally throw before yielding. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runUnifiedInbox } from "./pipeline.ts";
import { inboxStatePaths, loadInboxState } from "./state.ts";
import {
  InboxAnalysisSchema,
  InboxObservationSchema,
  ObservationPageSchema,
  canonicalObservationId,
  type InboxClassifier,
  type InboxObservation,
  type InboxSource,
  type InboxSourceName,
  type ObservationPage,
} from "./types.ts";

const now = new Date("2026-08-09T08:00:00.000Z");

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-unified-inbox-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function observation(
  source: InboxSourceName,
  externalId: string,
): InboxObservation {
  const sourceAccountId =
    source === "gmail" ? "me" : source === "calendar" ? "primary" : "7";
  const identity = { source, sourceAccountId, externalId };
  const event = source === "calendar";
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: "1",
    kind: event ? "event" : "message",
    occurredAt: event ? "2026-08-09T10:00:00.000Z" : "2026-08-09T07:00:00.000Z",
    updatedAt: "2026-08-09T07:00:00.000Z",
    title: event ? "Project review" : "Message",
    excerpt: event ? "Discuss open decisions" : "Can you reply before noon?",
    actor:
      source === "gmail"
        ? {
            id: "alice@example.com",
            label: "Alice",
            address: "alice@example.com",
          }
        : source === "telegram"
          ? { id: "telegram:user:11", label: "Alice" }
          : undefined,
    participants: event
      ? [
          {
            id: "alice@example.com",
            label: "Alice",
            address: "alice@example.com",
          },
        ]
      : [],
    startsAt: event ? "2026-08-09T10:00:00.000Z" : undefined,
    endsAt: event ? "2026-08-09T11:00:00.000Z" : undefined,
    evidence: {
      source,
      externalId,
      timestamp: event
        ? "2026-08-09T10:00:00.000Z"
        : "2026-08-09T07:00:00.000Z",
      locator: `${source} ${externalId}`,
    },
  });
}

const telegram = observation("telegram", "11:41");
const gmail = observation("gmail", "m-1");
const calendar = observation("calendar", "event-1");

function page(item: InboxObservation, order: number): ObservationPage {
  const key = item.source === "telegram" ? "telegram:11" : item.source;
  return ObservationPageSchema.parse({
    schemaVersion: 1,
    source: item.source,
    sourceAccountId: item.sourceAccountId,
    cursor: { key, value: String(order), order },
    observations: [item],
  });
}

function source(item: InboxObservation, order: number): InboxSource {
  return {
    source: item.source,
    async *collect() {
      yield page(item, order);
    },
  };
}

function fixtureClassifier(): InboxClassifier {
  return {
    async analyze({ observations, meetings }) {
      const gmailItem = observations.find((item) => item.source === "gmail");
      return InboxAnalysisSchema.parse({
        schemaVersion: 1,
        decisions: observations.map((item) => ({
          observationId: item.id,
          category:
            item.source === "gmail"
              ? "needs_reply"
              : item.source === "telegram"
                ? "urgent"
                : "informational",
          rationale:
            item.source === "gmail"
              ? "Direct question."
              : item.source === "telegram"
                ? "Immediate owner attention requested."
                : "Upcoming meeting.",
          evidenceIds: [item.id],
        })),
        meetingBriefs: meetings.map((meeting) => ({
          eventObservationId: meeting.eventObservationId,
          summary: "Review the open decision before the meeting.",
          preparationPoints: ["Read the latest message"],
          openQuestions: ["Which option is approved?"],
          evidenceIds: [
            meeting.eventObservationId,
            ...meeting.relatedObservationIds,
          ],
        })),
        draftProposals: gmailItem
          ? [
              {
                messageObservationId: gmailItem.id,
                to: "alice@example.com",
                subject: "Re: Message",
                body: "Thanks, I will reply before noon.",
                evidenceIds: [gmailItem.id],
              },
            ]
          : [],
      });
    },
  };
}

test("first run collects three sources and replay stays deduplicated", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const options = {
    paths,
    ownerId: "7",
    targetChatId: "7",
    now,
    sources: [source(telegram, 41), source(gmail, 100), source(calendar, 200)],
    classifier: fixtureClassifier(),
  };

  const first = await runUnifiedInbox(options);
  assert.equal(first.collected.newObservations, 3);
  assert.equal(first.report.categories.urgent.length, 1);
  assert.equal(first.report.categories.needsReply.length, 1);
  assert.equal(first.report.meetings.length, 1);
  assert.equal(first.report.draftProposals.length, 1);
  assert.equal(first.envelope.targetChatId, "7");

  const second = await runUnifiedInbox(options);
  assert.equal(second.collected.newObservations, 0);
  assert.equal(second.collected.totalObservations, 3);
  assert.equal(
    Object.keys((await loadInboxState(paths)).observations).length,
    3,
  );
});

test("source failures produce a sanitized partial report from committed sources", async (t) => {
  const root = await temporaryRoot(t);
  const failingSource: InboxSource = {
    source: "calendar",
    async *collect() {
      throw new Error("token alice@example.com");
    },
  };
  const result = await runUnifiedInbox({
    paths: inboxStatePaths(root, "data", "7"),
    ownerId: "7",
    targetChatId: "7",
    now,
    sources: [source(gmail, 100), failingSource],
    classifier: fixtureClassifier(),
  });

  assert.equal(result.report.partial, true);
  assert.deepEqual(result.report.sourceHealth, [
    { source: "gmail", status: "ok", collected: 1, errorCode: null },
    {
      source: "calendar",
      status: "failed",
      collected: 0,
      errorCode: "unified_inbox_source_failed",
    },
  ]);
  assert.equal(
    JSON.stringify(result.report).includes("alice@example.com"),
    true,
  );
  assert.equal(
    JSON.stringify(result.report.sourceHealth).includes("alice@example.com"),
    false,
  );
});

test("fatal source invariants stop before classification or envelope construction", async (t) => {
  const root = await temporaryRoot(t);
  let classifierCalls = 0;
  const fatal: InboxSource = {
    source: "telegram",
    async *collect() {
      throw new Error("unified_inbox_cursor_regression");
    },
  };
  await assert.rejects(
    () =>
      runUnifiedInbox({
        paths: inboxStatePaths(root, "data", "7"),
        ownerId: "7",
        targetChatId: "7",
        now,
        sources: [fatal],
        classifier: {
          async analyze() {
            classifierCalls += 1;
            return fixtureClassifier().analyze({
              observations: [],
              meetings: [],
            });
          },
        },
      }),
    /unified_inbox_cursor_regression/u,
  );
  assert.equal(classifierCalls, 0);
});

test("invented model evidence is fatal and leaves lastReport unset", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const classifier: InboxClassifier = {
    async analyze({ observations }) {
      return InboxAnalysisSchema.parse({
        schemaVersion: 1,
        decisions: observations.map((item) => ({
          observationId: item.id,
          category: "urgent",
          rationale: "Invented evidence.",
          evidenceIds: ["gmail:00000000000000000000000000000000"],
        })),
        meetingBriefs: [],
        draftProposals: [],
      });
    },
  };
  await assert.rejects(
    () =>
      runUnifiedInbox({
        paths,
        ownerId: "7",
        targetChatId: "7",
        now,
        sources: [source(gmail, 100)],
        classifier,
      }),
    /unified_inbox_analysis_unknown_evidence/u,
  );
  assert.equal((await loadInboxState(paths)).lastReport, null);
});

test("classifier input is capped deterministically and reports deferred observations", async (t) => {
  const root = await temporaryRoot(t);
  const items = Array.from({ length: 501 }, (_, index) =>
    observation("gmail", `bulk-${index}`),
  );
  const bulkSource: InboxSource = {
    source: "gmail",
    async *collect({ cursors }) {
      const base = cursors.gmail?.order ?? 0;
      yield ObservationPageSchema.parse({
        schemaVersion: 1,
        source: "gmail",
        sourceAccountId: "me",
        cursor: { key: "gmail", value: String(base + 1), order: base + 1 },
        observations: items.slice(0, 500),
      });
      yield ObservationPageSchema.parse({
        schemaVersion: 1,
        source: "gmail",
        sourceAccountId: "me",
        cursor: { key: "gmail", value: String(base + 2), order: base + 2 },
        observations: items.slice(500),
      });
    },
  };
  let analyzedIds: string[] = [];
  const result = await runUnifiedInbox({
    paths: inboxStatePaths(root, "data", "7"),
    ownerId: "7",
    targetChatId: "7",
    now,
    sources: [bulkSource],
    classifier: {
      async analyze({ observations }) {
        analyzedIds = observations.map((item) => item.id);
        return InboxAnalysisSchema.parse({
          schemaVersion: 1,
          decisions: observations.map((item) => ({
            observationId: item.id,
            category: "informational",
            rationale: "Bounded batch.",
            evidenceIds: [item.id],
          })),
          meetingBriefs: [],
          draftProposals: [],
        });
      },
    },
  });

  assert.equal(analyzedIds.length, 500);
  assert.equal(result.report.deferredObservationCount, 1);
  assert.match(result.envelope.text, /Отложено до следующего отчёта: 1/u);
  const deferredId = items.find((item) => !analyzedIds.includes(item.id))?.id;
  assert.ok(deferredId);

  await runUnifiedInbox({
    paths: inboxStatePaths(root, "data", "7"),
    ownerId: "7",
    targetChatId: "7",
    now,
    sources: [bulkSource],
    classifier: {
      async analyze({ observations }) {
        analyzedIds = observations.map((item) => item.id);
        return InboxAnalysisSchema.parse({
          schemaVersion: 1,
          decisions: observations.map((item) => ({
            observationId: item.id,
            category: "informational",
            rationale: "Bounded batch.",
            evidenceIds: [item.id],
          })),
          meetingBriefs: [],
          draftProposals: [],
        });
      },
    },
  });
  assert.ok(analyzedIds.includes(deferredId));
});

test("Calendar reconciliation receives only stored events overlapping its snapshot", async (t) => {
  const root = await temporaryRoot(t);
  const paths = inboxStatePaths(root, "data", "7");
  const timedEvent = (
    externalId: string,
    startsAt: string,
    endsAt: string,
  ): InboxObservation => {
    const identity = {
      source: "calendar" as const,
      sourceAccountId: "primary",
      externalId,
    };
    return InboxObservationSchema.parse({
      ...calendar,
      ...identity,
      id: canonicalObservationId(identity),
      occurredAt: startsAt,
      startsAt,
      endsAt,
      evidence: {
        source: "calendar",
        externalId,
        timestamp: startsAt,
        locator: `calendar ${externalId}`,
      },
    });
  };
  const historical = timedEvent(
    "historical",
    "2026-08-07T10:00:00.000Z",
    "2026-08-07T11:00:00.000Z",
  );
  const imminent = timedEvent(
    "imminent",
    "2026-08-09T10:00:00.000Z",
    "2026-08-09T11:00:00.000Z",
  );
  const lowerBoundary = timedEvent(
    "lower-boundary",
    "2026-08-08T07:00:00.000Z",
    "2026-08-08T08:00:00.000Z",
  );
  const upperBoundary = timedEvent(
    "upper-boundary",
    "2026-08-16T08:00:00.000Z",
    "2026-08-16T09:00:00.000Z",
  );
  await runUnifiedInbox({
    paths,
    ownerId: "7",
    targetChatId: "7",
    now,
    sources: [
      {
        source: "calendar",
        async *collect() {
          yield ObservationPageSchema.parse({
            schemaVersion: 1,
            source: "calendar",
            sourceAccountId: "primary",
            cursor: { key: "calendar", value: "1", order: 1 },
            observations: [historical, lowerBoundary, imminent, upperBoundary],
          });
        },
      },
    ],
    classifier: fixtureClassifier(),
  });

  let knownObservationIds: string[] = [];
  await runUnifiedInbox({
    paths,
    ownerId: "7",
    targetChatId: "7",
    now,
    sources: [
      {
        source: "calendar",
        async *collect(input) {
          knownObservationIds = input.knownObservationIds ?? [];
        },
      },
    ],
    classifier: fixtureClassifier(),
  });

  assert.deepEqual(knownObservationIds, [imminent.id]);
  assert.ok((await loadInboxState(paths)).observations[historical.id]);
  assert.ok((await loadInboxState(paths)).observations[lowerBoundary.id]);
  assert.ok((await loadInboxState(paths)).observations[upperBoundary.id]);
});
