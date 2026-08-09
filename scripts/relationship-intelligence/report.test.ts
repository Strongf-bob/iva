/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and injected senders retain async contracts. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectCalendarMeetings,
  deliverRelationshipReport,
  prepareRelationshipReport,
  resolveOwnerReportRoute,
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

test("owner report routing rejects group or ambiguous legacy destinations", () => {
  assert.deepEqual(
    resolveOwnerReportRoute({
      multiUser: false,
      role: undefined,
      assignedUserId: undefined,
      routedOwnerId: "7",
      allowedUserIds: "7",
      digestChatId: "7",
    }),
    { ownerUserId: "7", destination: "7", role: "owner" },
  );
  assert.throws(
    () =>
      resolveOwnerReportRoute({
        multiUser: false,
        role: undefined,
        assignedUserId: undefined,
        routedOwnerId: "7",
        allowedUserIds: "7",
        digestChatId: "-1001",
      }),
    /owner private chat/u,
  );
  assert.throws(
    () =>
      resolveOwnerReportRoute({
        multiUser: false,
        role: undefined,
        assignedUserId: undefined,
        routedOwnerId: undefined,
        allowedUserIds: "7,8",
        digestChatId: undefined,
      }),
    /exactly one owner/u,
  );
});

test("scheduled report collection uses one fixed read-only Calendar call", async () => {
  const calls: string[][] = [];
  const meetings = await collectCalendarMeetings({
    period: "daily",
    now: "2026-08-09T04:45:00Z",
    timeZone: "Europe/Moscow",
    run: async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            {
              id: "event-1",
              summary: "Planning",
              start: { dateTime: "2026-08-09T10:00:00+03:00" },
            },
          ],
        }),
      };
    },
  });
  assert.deepEqual(calls[0].slice(0, 3), ["calendar", "events", "list"]);
  assert.equal(calls.length, 1);
  const params = JSON.parse(calls[0][calls[0].indexOf("--params") + 1]) as {
    timeMin: string;
    timeMax: string;
  };
  assert.deepEqual(params, {
    calendarId: "primary",
    timeMin: "2026-08-08T21:00:00.000Z",
    timeMax: "2026-08-09T21:00:00.000Z",
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });
  assert.equal(meetings[0].id, "event-1");
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

test("a crashed delivery becomes ambiguous and cannot wedge later preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-report-"));
  const paths = relationshipPaths(root, "data");
  await mutateRegistry(paths, () => true);
  await prepareRelationshipReport({
    paths,
    period: "daily",
    now: "2026-08-09T07:45:00Z",
  });
  const reportFile = join(paths.reportsDir, "daily.json");
  const report = JSON.parse(await readFile(reportFile, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    reportFile,
    JSON.stringify({
      ...report,
      deliveryState: "sending",
      deliveryAttemptId: "crashed-attempt",
      deliveryStartedAt: "2026-08-09T08:00:00Z",
    }),
  );
  let sends = 0;
  assert.deepEqual(
    await deliverRelationshipReport({
      paths,
      period: "daily",
      ownerUserId: "7",
      destination: "7",
      role: "owner",
      now: "2026-08-09T08:20:01Z",
      send: async () => {
        sends += 1;
      },
    }),
    { delivered: false },
  );
  assert.equal(sends, 0);
  const recovered = JSON.parse(await readFile(reportFile, "utf8")) as {
    deliveryState?: string;
  };
  assert.equal(recovered.deliveryState, "ambiguous");
  const next = await prepareRelationshipReport({
    paths,
    period: "daily",
    now: "2026-08-10T07:45:00Z",
  });
  assert.equal(next.deliveryState, "pending");
});
