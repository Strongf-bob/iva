/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  InboxAnalysisSchema,
  InboxObservationSchema,
  ObservationPageSchema,
  PrivateInboxReportEnvelopeSchema,
  canonicalObservationId,
  observationFingerprint,
  truncateCodePoints,
  type InboxObservation,
  type InboxReport,
} from "./types.ts";

const occurredAt = "2026-08-09T05:30:00.000Z";

function gmailObservation(
  overrides: Partial<InboxObservation> = {},
): InboxObservation {
  const identity = {
    source: "gmail" as const,
    sourceAccountId: "me",
    externalId: "message-7",
  };
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: "1723181400000",
    kind: "message",
    occurredAt,
    updatedAt: occurredAt,
    title: "Project review",
    excerpt: "Can you reply before noon?",
    actor: {
      id: "alice@example.com",
      label: "Alice",
      address: "alice@example.com",
    },
    participants: [
      {
        id: "owner@example.com",
        label: "Owner",
        address: "owner@example.com",
      },
    ],
    threadId: "thread-3",
    evidence: {
      source: "gmail",
      externalId: "message-7",
      timestamp: occurredAt,
      locator: "Gmail message message-7",
    },
    ...overrides,
  });
}

function emptyReport(): InboxReport {
  return {
    schemaVersion: 1,
    generatedAt: occurredAt,
    categories: {
      urgent: [],
      needsReply: [],
      informational: [],
    },
    meetings: [],
    draftProposals: [],
    informationalCount: 0,
    ignorableCount: 0,
    sourceHealth: [],
    partial: false,
  };
}

test("canonical identity is stable across revisions while fingerprints are not", () => {
  const identity = {
    source: "gmail" as const,
    sourceAccountId: "me",
    externalId: "message-7",
  };

  assert.equal(
    canonicalObservationId(identity),
    canonicalObservationId(identity),
  );
  assert.match(canonicalObservationId(identity), /^gmail:[a-f0-9]{32}$/u);
  assert.notEqual(
    observationFingerprint({ ...identity, revision: "100" }),
    observationFingerprint({ ...identity, revision: "101" }),
  );
});

test("canonical identity length-prefixes fields instead of joining ambiguous text", () => {
  assert.notEqual(
    canonicalObservationId({
      source: "gmail",
      sourceAccountId: "a:b",
      externalId: "c",
    }),
    canonicalObservationId({
      source: "gmail",
      sourceAccountId: "a",
      externalId: "b:c",
    }),
  );
});

test("truncateCodePoints never splits emoji and keeps the requested total bound", () => {
  assert.equal(truncateCodePoints("ab😀cd", 4), "ab😀…");
  assert.equal([...truncateCodePoints("ab😀cd", 4)].length, 4);
  assert.equal(truncateCodePoints("😀", 1), "😀");
  assert.throws(() => truncateCodePoints("text", 0), /positive integer/u);
});

test("observation schema is strict and requires Calendar event bounds", () => {
  assert.throws(
    () =>
      InboxObservationSchema.parse({ ...gmailObservation(), surprise: true }),
    /unrecognized|unknown/iu,
  );

  const identity = {
    source: "calendar" as const,
    sourceAccountId: "primary",
    externalId: "event-1",
  };
  assert.throws(
    () =>
      InboxObservationSchema.parse({
        ...gmailObservation({
          ...identity,
          id: canonicalObservationId(identity),
          kind: "event",
          actor: undefined,
          threadId: undefined,
          evidence: {
            source: "calendar",
            externalId: "event-1",
            timestamp: occurredAt,
            locator: "Calendar event event-1",
          },
        }),
      }),
    /startsAt|endsAt/u,
  );
});

test("observation pages require source-qualified cursors and one source account", () => {
  const observation = gmailObservation();
  const parsed = ObservationPageSchema.parse({
    schemaVersion: 1,
    source: "gmail",
    sourceAccountId: "me",
    cursor: { key: "gmail", value: "1723181400000", order: 1723181400000 },
    observations: [observation],
  });
  assert.equal(parsed.observations[0]?.id, observation.id);

  assert.throws(() =>
    ObservationPageSchema.parse({
      ...parsed,
      cursor: { key: "calendar", value: occurredAt, order: 1723181400000 },
    }),
  );
  assert.throws(() =>
    ObservationPageSchema.parse({
      ...parsed,
      observations: [gmailObservation({ sourceAccountId: "other" })],
    }),
  );
});

test("analysis schemas reject duplicate decisions and unbounded prose", () => {
  const observation = gmailObservation();
  const decision = {
    observationId: observation.id,
    category: "needs_reply" as const,
    rationale: "The sender asks a direct question.",
    evidenceIds: [observation.id],
  };
  assert.throws(() =>
    InboxAnalysisSchema.parse({
      schemaVersion: 1,
      decisions: [decision, decision],
      meetingBriefs: [],
      draftProposals: [],
    }),
  );
  assert.throws(() =>
    InboxAnalysisSchema.parse({
      schemaVersion: 1,
      decisions: [{ ...decision, rationale: "x".repeat(1001) }],
      meetingBriefs: [],
      draftProposals: [],
    }),
  );
});

test("private report envelopes reject redirected or non-private destinations", () => {
  const base = {
    schemaVersion: 1 as const,
    ownerChatId: "7",
    targetChatId: "7",
    chatKind: "private" as const,
    generatedAt: occurredAt,
    text: "No urgent messages.",
    report: emptyReport(),
  };
  assert.equal(PrivateInboxReportEnvelopeSchema.parse(base).targetChatId, "7");
  assert.throws(() =>
    PrivateInboxReportEnvelopeSchema.parse({ ...base, targetChatId: "8" }),
  );
  assert.throws(() =>
    PrivateInboxReportEnvelopeSchema.parse({ ...base, chatKind: "group" }),
  );
});
