/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and injected senders retain async contracts. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deliverRelationshipReport,
  prepareRelationshipReport,
  relationshipReportPrompt,
} from "./report.ts";
import { mutateRegistry, relationshipPaths } from "./store.ts";

test("prepared reports deliver once only to the owner private chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-report-"));
  const paths = relationshipPaths(root, "data");
  await mutateRegistry(paths, () => true);
  const prepared = await prepareRelationshipReport({
    paths,
    period: "daily",
    now: "2026-08-09T07:45:00Z",
  });
  const sent: Array<[string, string]> = [];
  const result = await deliverRelationshipReport({
    paths,
    period: "daily",
    ownerUserId: "7",
    destination: "7",
    role: "owner",
    now: "2026-08-09T08:00:00Z",
    send: async (chat, text) => {
      sent.push([chat, text]);
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(sent[0][0], "7");
  assert.match(sent[0][1], /Relationship daily review/u);
  assert.equal(
    (
      await deliverRelationshipReport({
        paths,
        period: "daily",
        ownerUserId: "7",
        destination: "7",
        role: "owner",
        now: "2026-08-09T08:01:00Z",
        send: async () => {
          throw new Error("duplicate");
        },
      })
    ).delivered,
    false,
  );
  assert.equal(prepared.schema, "iva-relationship-report/v1");
  await assert.rejects(
    () =>
      deliverRelationshipReport({
        paths,
        period: "daily",
        ownerUserId: "7",
        destination: "8",
        role: "owner",
        now: "2026-08-09T08:02:00Z",
        send: async () => {},
      }),
    /private chat/u,
  );
});

test("period prompts request the complete evidence-linked report views", () => {
  assert.match(
    relationshipReportPrompt("daily"),
    /birthdays.*today's meetings/isu,
  );
  assert.match(
    relationshipReportPrompt("weekly"),
    /activity.*next-week meetings/isu,
  );
  assert.match(
    relationshipReportPrompt("weekly"),
    /relationship-report skill/iu,
  );
});

test("parallel delivery reserves the artifact before external send", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-report-"));
  const paths = relationshipPaths(root, "data");
  await mutateRegistry(paths, () => true);
  await prepareRelationshipReport({
    paths,
    period: "daily",
    now: "2026-08-09T07:45:00Z",
  });
  let sends = 0;
  const deliver = () =>
    deliverRelationshipReport({
      paths,
      period: "daily" as const,
      ownerUserId: "7",
      destination: "7",
      role: "owner",
      now: "2026-08-09T08:00:00Z",
      send: async () => {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
  const results = await Promise.all([deliver(), deliver()]);
  assert.equal(sends, 1);
  assert.equal(results.filter((result) => result.delivered).length, 1);
});
