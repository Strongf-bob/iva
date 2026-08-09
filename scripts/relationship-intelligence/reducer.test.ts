/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations and the fixture intentionally builds a union member. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reduceRelationshipObservations } from "./reducer.ts";
import { loadRegistry, mutateRegistry, relationshipPaths } from "./store.ts";
import type { Observation } from "../contact-analysis/types.ts";

const observedAt = "2026-08-09T10:00:00Z";
const evidence = [{ chatId: 44, messageId: 9, timestamp: observedAt }];

function observation(overrides: Partial<Observation>): Observation {
  return {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    kind: "commitment",
    predicate: "commitment",
    value: "Send the report",
    confidence: "EXTRACTED",
    contextChatId: 44,
    evidence,
    relationship: { direction: "owner_to_contact", dueAt: null },
    ...overrides,
  } as Observation;
}

test("Telegram observations become pending commitments and contact activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-reducer-"));
  const paths = relationshipPaths(root, "data");
  const observations = [
    observation({}),
    observation({
      kind: "fact",
      predicate: "birthday",
      value: "--05-17",
      relationship: undefined,
    }),
    observation({
      kind: "behavior",
      predicate: "meaningful_contact",
      value: "Discussed launch",
      relationship: undefined,
    }),
  ];

  await reduceRelationshipObservations({
    paths,
    ownerUserId: 7,
    observations,
    now: observedAt,
  });
  await reduceRelationshipObservations({
    paths,
    ownerUserId: 7,
    observations,
    now: observedAt,
  });

  const registry = await loadRegistry(paths);
  assert.equal(registry.commitments.length, 1);
  assert.equal(registry.commitments[0].status, "pending_suggestion");
  assert.equal(
    registry.commitments[0].evidence[0].sourceId,
    "telegram:message:44:9",
  );
  assert.equal(
    registry.contacts["telegram:user:44"].birthday?.value,
    "--05-17",
  );
  assert.equal(
    registry.contacts["telegram:user:44"].lastMeaningfulContactAt,
    observedAt,
  );
});

test("only explicitly correlated observations enrich a commitment", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-reducer-"));
  const paths = relationshipPaths(root, "data");
  await reduceRelationshipObservations({
    paths,
    ownerUserId: 7,
    observations: [observation({})],
    now: observedAt,
  });
  await mutateRegistry(paths, (registry) => {
    registry.commitments[0].status = "dismissed";
  });
  await reduceRelationshipObservations({
    paths,
    ownerUserId: 7,
    observations: [
      observation({
        subjectId: "telegram:user:55",
        evidence,
        relationship: {
          direction: "owner_to_contact",
          dueAt: "2026-08-15T10:00:00Z",
        },
      }),
    ],
    now: "2026-08-10T10:00:00Z",
  });
  const registry = await loadRegistry(paths);
  assert.equal(registry.commitments.length, 1);
  assert.equal(registry.commitments[0].status, "dismissed");
  assert.deepEqual(registry.commitments[0].contactIds.sort(), [
    "telegram:user:44",
    "telegram:user:55",
  ]);
  assert.equal(registry.commitments[0].evidence.length, 1);
  assert.equal(registry.commitments[0].dueAt, "2026-08-15T10:00:00Z");
});

test("equal text with disjoint evidence remains separate commitments", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-reducer-"));
  const paths = relationshipPaths(root, "data");
  await reduceRelationshipObservations({
    paths,
    ownerUserId: 7,
    observations: [
      observation({}),
      observation({
        subjectId: "telegram:user:55",
        evidence: [
          {
            chatId: 55,
            messageId: 10,
            timestamp: "2026-08-10T10:00:00Z",
          },
        ],
        relationship: {
          direction: "owner_to_contact",
          dueAt: "2026-08-15T10:00:00Z",
        },
      }),
    ],
  });
  assert.equal((await loadRegistry(paths)).commitments.length, 2);
});
