/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and injected senders retain async contracts. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deliverRelationshipReport,
  prepareRelationshipReport,
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
