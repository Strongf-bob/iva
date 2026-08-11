import {
  ObservationSchema,
  type Observation,
} from "../contact-analysis/types.ts";
import { mutateRegistry, type RelationshipPaths } from "./store.ts";
import {
  commitmentId,
  type ContactActivity,
  type RelationshipEvidence,
} from "./types.ts";

export interface ReduceRelationshipInput {
  paths: RelationshipPaths;
  ownerUserId: number;
  observations: readonly Observation[];
  now?: string;
}

function evidenceFor(observation: Observation): RelationshipEvidence[] {
  return observation.evidence.map((item) => ({
    source: "telegram" as const,
    sourceId: `telegram:message:${item.chatId}:${item.messageId}`,
    observedAt: item.timestamp,
  }));
}

function emptyContact(): ContactActivity {
  return {
    birthday: null,
    lastMeaningfulContactAt: null,
    meaningfulContactEvidence: null,
    followUps: [],
  };
}

export async function reduceRelationshipObservations({
  paths,
  ownerUserId,
  observations,
  now = new Date().toISOString(),
}: ReduceRelationshipInput): Promise<void> {
  const parsed = observations.map((item) => ObservationSchema.parse(item));
  await mutateRegistry(paths, (registry) => {
    const before = JSON.stringify(registry);
    for (const observation of parsed) {
      const relevant = [
        "commitment",
        "follow_up",
        "birthday",
        "meaningful_contact",
      ].includes(observation.predicate);
      if (!relevant || observation.value === undefined) continue;
      if (!/^telegram:user:-?[1-9]\d*$/u.test(observation.subjectId)) continue;
      const contact =
        registry.contacts[observation.subjectId] ??
        (registry.contacts[observation.subjectId] = emptyContact());
      const evidence = evidenceFor(observation);
      const newest = [...evidence]
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .at(-1)!;

      if (observation.predicate === "birthday") {
        if (observation.confidence !== "EXTRACTED") continue;
        if (
          contact.birthday === null ||
          newest.observedAt >= contact.birthday.evidence.observedAt
        ) {
          contact.birthday = { value: observation.value, evidence: newest };
        }
        continue;
      }
      if (observation.predicate === "meaningful_contact") {
        if (
          contact.lastMeaningfulContactAt === null ||
          newest.observedAt >= contact.lastMeaningfulContactAt
        ) {
          contact.lastMeaningfulContactAt = newest.observedAt;
          contact.meaningfulContactEvidence = newest;
        }
        continue;
      }

      const ownerCanonical = `telegram:user:${ownerUserId}`;
      const contactIds =
        observation.subjectId === ownerCanonical ? [] : [observation.subjectId];
      const draft = {
        text: observation.value,
        evidence,
      };
      const direction =
        observation.predicate === "follow_up"
          ? "owner_to_contact"
          : (observation.relationship?.direction ?? "unknown");
      const id = commitmentId(draft);
      let item = registry.commitments.find((candidate) => candidate.id === id);
      if (!item) {
        item = {
          id,
          text: observation.value,
          direction,
          contactIds,
          dueAt: observation.relationship?.dueAt ?? null,
          status: "pending_suggestion",
          evidence,
          firstSeenAt: evidence.map((item) => item.observedAt).sort()[0],
          updatedAt: now,
          googleTask: null,
          confirmation: null,
        };
        registry.commitments.push(item);
      } else {
        item.contactIds = [
          ...new Set([...item.contactIds, ...contactIds]),
        ].sort();
        const evidenceKeys = new Set(
          item.evidence.map(
            (entry) => `${entry.source}:${entry.sourceId}:${entry.observedAt}`,
          ),
        );
        for (const entry of evidence) {
          const key = `${entry.source}:${entry.sourceId}:${entry.observedAt}`;
          if (!evidenceKeys.has(key)) item.evidence.push(entry);
        }
        item.evidence.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        if (item.direction === "unknown") item.direction = direction;
        else if (direction !== "unknown" && item.direction !== direction)
          item.direction = "mutual";
        if (observation.relationship?.dueAt)
          item.dueAt = observation.relationship.dueAt;
        item.updatedAt = now;
      }
      if (
        observation.predicate === "follow_up" &&
        !contact.followUps.includes(item.id)
      ) {
        contact.followUps.push(item.id);
      }
    }
    return JSON.stringify(registry) !== before;
  });
}
