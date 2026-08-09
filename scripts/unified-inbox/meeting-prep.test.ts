/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registration; injected providers intentionally resolve synchronously. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EmptyRelationshipContextProvider,
  buildMeetingContexts,
} from "./meeting-prep.ts";
import {
  InboxObservationSchema,
  canonicalObservationId,
  type InboxObservation,
  type RelationshipContextProvider,
} from "./types.ts";

const now = new Date("2026-08-09T08:00:00.000Z");

function observation(input: {
  source: "gmail" | "telegram" | "calendar";
  externalId: string;
  occurredAt: string;
  actorId?: string;
  actorAddress?: string;
  participants?: { id: string; label: string; address?: string }[];
  startsAt?: string;
  endsAt?: string;
}): InboxObservation {
  const sourceAccountId =
    input.source === "gmail"
      ? "me"
      : input.source === "calendar"
        ? "primary"
        : "7";
  const identity = {
    source: input.source,
    sourceAccountId,
    externalId: input.externalId,
  };
  const isEvent = input.source === "calendar";
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: "1",
    kind: isEvent ? "event" : "message",
    occurredAt: input.occurredAt,
    updatedAt: input.occurredAt,
    title: isEvent ? "Project review" : "Message",
    excerpt: "Evidence",
    actor: input.actorId
      ? {
          id: input.actorId,
          label: "Alice",
          ...(input.actorAddress ? { address: input.actorAddress } : {}),
        }
      : undefined,
    participants: input.participants ?? [],
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    evidence: {
      source: input.source,
      externalId: input.externalId,
      timestamp: input.occurredAt,
      locator: `${input.source} ${input.externalId}`,
    },
  });
}

const calendar = observation({
  source: "calendar",
  externalId: "event-1",
  occurredAt: "2026-08-09T10:00:00.000Z",
  participants: [
    { id: "alice@example.com", label: "Alice", address: "alice@example.com" },
  ],
  startsAt: "2026-08-09T10:00:00.000Z",
  endsAt: "2026-08-09T11:00:00.000Z",
});
const gmail = observation({
  source: "gmail",
  externalId: "m-1",
  occurredAt: "2026-08-09T07:00:00.000Z",
  actorId: "alice@example.com",
  actorAddress: "alice@example.com",
});
const telegram = observation({
  source: "telegram",
  externalId: "11:41",
  occurredAt: "2026-08-08T07:00:00.000Z",
  actorId: "telegram:user:11",
});

test("meeting contexts join exact participants and relationship evidence", async () => {
  const lookups: unknown[] = [];
  const relationships: RelationshipContextProvider = {
    async lookup(input) {
      lookups.push(input);
      return [
        {
          subjectId: "telegram:user:11",
          label: "Alice",
          summary: "Project collaborator",
          evidenceObservationIds: [telegram.id],
        },
      ];
    },
  };

  const contexts = await buildMeetingContexts(
    [calendar, gmail, telegram],
    relationships,
    now,
  );

  assert.deepEqual(lookups, [
    {
      eventObservationId: calendar.id,
      participantKeys: ["alice@example.com"],
    },
  ]);
  assert.deepEqual(contexts[0]?.relatedObservationIds, [gmail.id, telegram.id]);
  assert.equal(
    contexts[0]?.relationshipContext[0]?.subjectId,
    "telegram:user:11",
  );
});

test("empty relationship provider keeps direct exact matching useful", async () => {
  const contexts = await buildMeetingContexts(
    [calendar, gmail, telegram],
    new EmptyRelationshipContextProvider(),
    now,
  );
  assert.deepEqual(contexts[0]?.relatedObservationIds, [gmail.id]);
  assert.deepEqual(contexts[0]?.relationshipContext, []);
});

test("past and distant Calendar events stay outside the 48-hour preparation window", async () => {
  const past = observation({
    source: "calendar",
    externalId: "past",
    occurredAt: "2026-08-08T05:00:00.000Z",
    startsAt: "2026-08-08T05:00:00.000Z",
    endsAt: "2026-08-08T06:00:00.000Z",
  });
  const distant = observation({
    source: "calendar",
    externalId: "distant",
    occurredAt: "2026-08-12T10:00:00.000Z",
    startsAt: "2026-08-12T10:00:00.000Z",
    endsAt: "2026-08-12T11:00:00.000Z",
  });
  const contexts = await buildMeetingContexts(
    [past, calendar, distant],
    new EmptyRelationshipContextProvider(),
    now,
  );
  assert.deepEqual(
    contexts.map((context) => context.eventObservationId),
    [calendar.id],
  );
});

test("relationship providers cannot invent evidence IDs", async () => {
  const relationships: RelationshipContextProvider = {
    async lookup() {
      return [
        {
          subjectId: "contact:alice",
          label: "Alice",
          summary: "Unknown source",
          evidenceObservationIds: ["gmail:00000000000000000000000000000000"],
        },
      ];
    },
  };
  await assert.rejects(
    () => buildMeetingContexts([calendar, gmail], relationships, now),
    /unified_inbox_relationship_unknown_evidence/u,
  );
});

test("meeting preparation input stays within the analysis schema bound", async () => {
  const events = Array.from({ length: 101 }, (_, index) =>
    observation({
      source: "calendar",
      externalId: `event-${index}`,
      occurredAt: "2026-08-09T10:00:00.000Z",
      startsAt: "2026-08-09T10:00:00.000Z",
      endsAt: "2026-08-09T11:00:00.000Z",
    }),
  );

  const contexts = await buildMeetingContexts(
    events,
    new EmptyRelationshipContextProvider(),
    now,
  );
  assert.equal(contexts.length, 100);
});

test("related meeting evidence is deterministically capped", async () => {
  const related = Array.from({ length: 201 }, (_, index) =>
    observation({
      source: "gmail",
      externalId: `related-${index}`,
      occurredAt: "2026-08-09T07:00:00.000Z",
      actorId: "alice@example.com",
      actorAddress: "alice@example.com",
    }),
  );

  const contexts = await buildMeetingContexts(
    [calendar, ...related],
    new EmptyRelationshipContextProvider(),
    now,
  );
  assert.equal(contexts[0]?.relatedObservationIds.length, 200);
});

test("participant and relationship context arrays are capped before validation", async () => {
  const participants = Array.from({ length: 100 }, (_, index) => ({
    id: `participant-${index}@example.com`,
    label: `Participant ${index}`,
    address: `participant-${index}@example.com`,
  }));
  const crowdedEvent = observation({
    source: "calendar",
    externalId: "crowded-event",
    occurredAt: "2026-08-09T10:00:00.000Z",
    actorId: "organizer@example.com",
    actorAddress: "organizer@example.com",
    participants,
    startsAt: "2026-08-09T10:00:00.000Z",
    endsAt: "2026-08-09T11:00:00.000Z",
  });
  const relationships: RelationshipContextProvider = {
    async lookup() {
      return Array.from({ length: 101 }, (_, index) => ({
        subjectId: `contact-${index}`,
        label: `Contact ${index}`,
        summary: "Known relationship.",
        evidenceObservationIds: [gmail.id],
      }));
    },
  };

  const contexts = await buildMeetingContexts(
    [crowdedEvent, gmail],
    relationships,
    now,
  );
  assert.equal(contexts[0]?.participantKeys.length, 100);
  assert.equal(contexts[0]?.relationshipContext.length, 100);
});
