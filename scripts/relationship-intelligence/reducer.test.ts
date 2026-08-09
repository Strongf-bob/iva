/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations and the fixture intentionally builds a union member. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reduceRelationshipObservations } from "./reducer.ts";
import { loadRegistry, relationshipPaths } from "./store.ts";
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
