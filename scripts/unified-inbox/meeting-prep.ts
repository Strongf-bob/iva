import {
  InboxObservationSchema,
  MeetingContextSchema,
  RelationshipContextSchema,
  RelationshipLookupSchema,
  type InboxObservation,
  type MeetingContext,
  type RelationshipContext,
  type RelationshipContextProvider,
} from "./types.ts";

const PREPARATION_HORIZON_MS = 48 * 60 * 60 * 1_000;

export class EmptyRelationshipContextProvider implements RelationshipContextProvider {
  lookup(): Promise<RelationshipContext[]> {
    return Promise.resolve([]);
  }
}

function partyKeys(observation: InboxObservation): string[] {
  const keys = new Set<string>();
  for (const party of [observation.actor, ...observation.participants]) {
    if (!party) continue;
    keys.add(party.id.toLowerCase());
    if (party.address) keys.add(party.address.toLowerCase());
  }
  return [...keys].sort();
}

function upcomingEvents(
  observations: readonly InboxObservation[],
  now: Date,
): InboxObservation[] {
  const start = now.getTime();
  const horizon = start + PREPARATION_HORIZON_MS;
  return observations
    .filter(
      (observation) =>
        observation.source === "calendar" &&
        observation.kind === "event" &&
        observation.startsAt !== undefined &&
        observation.endsAt !== undefined &&
        Date.parse(observation.endsAt) >= start &&
        Date.parse(observation.startsAt) <= horizon,
    )
    .sort(
      (left, right) =>
        Date.parse(left.startsAt ?? left.occurredAt) -
          Date.parse(right.startsAt ?? right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
}

export async function buildMeetingContexts(
  rawObservations: readonly InboxObservation[],
  relationships: RelationshipContextProvider = new EmptyRelationshipContextProvider(),
  now = new Date(),
): Promise<MeetingContext[]> {
  const observations = rawObservations.map((observation) =>
    InboxObservationSchema.parse(observation),
  );
  const observationsById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  const contexts: MeetingContext[] = [];

  for (const event of upcomingEvents(observations, now)) {
    const participantKeys = partyKeys(event);
    const participantSet = new Set(participantKeys);
    const directlyRelated = observations
      .filter(
        (observation) =>
          observation.id !== event.id &&
          partyKeys(observation).some((key) => participantSet.has(key)),
      )
      .map((observation) => observation.id);
    const lookup = RelationshipLookupSchema.parse({
      eventObservationId: event.id,
      participantKeys,
    });
    const relationshipContext = (await relationships.lookup(lookup)).map(
      (context) => RelationshipContextSchema.parse(context),
    );
    const relationshipEvidence = relationshipContext.flatMap(
      (context) => context.evidenceObservationIds,
    );
    for (const evidenceId of relationshipEvidence) {
      if (!observationsById.has(evidenceId)) {
        throw new Error("unified_inbox_relationship_unknown_evidence");
      }
    }
    const relatedObservationIds = [
      ...new Set([...directlyRelated, ...relationshipEvidence]),
    ];
    contexts.push(
      MeetingContextSchema.parse({
        eventObservationId: event.id,
        participantKeys,
        relatedObservationIds,
        relationshipContext,
      }),
    );
  }
  return contexts;
}
