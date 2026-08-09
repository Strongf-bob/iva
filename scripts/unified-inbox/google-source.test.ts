/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns test registration; injected async fakes intentionally resolve synchronously. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createCalendarInboxSource,
  createGmailInboxSource,
  validateReadOnlyGwsArgs,
  type GwsResult,
  type GwsRunner,
} from "./google-source.ts";
import type {
  CollectSourceInput,
  InboxSource,
  ObservationPage,
} from "./types.ts";

const now = "2026-08-09T08:00:00.000Z";

async function collect(
  source: InboxSource,
  cursors: CollectSourceInput["cursors"] = {},
): Promise<ObservationPage[]> {
  const pages: ObservationPage[] = [];
  for await (const page of source.collect({ cursors, now })) pages.push(page);
  return pages;
}

function jsonResult(value: unknown): GwsResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

test("Gmail lists inbox messages, fetches details, and advances internalDate", async () => {
  const calls: string[][] = [];
  const runner: GwsRunner = async (args) => {
    calls.push([...args]);
    if (args[3] === "list") {
      return jsonResult({
        messages: [{ id: "m-1", threadId: "t-1" }],
        resultSizeEstimate: 1,
      });
    }
    return jsonResult({
      id: "m-1",
      threadId: "t-1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Can you reply before noon?",
      historyId: "900",
      internalDate: "1723181400000",
      sizeEstimate: 120,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "To", value: "Owner <owner@example.com>" },
          { name: "Subject", value: "Project review" },
          { name: "Message-ID", value: "<provider-message-id>" },
        ],
        body: { size: 31 },
      },
    });
  };

  const pages = await collect(
    createGmailInboxSource({ runner, sourceAccountId: "me" }),
    { gmail: { key: "gmail", value: "1723181300000", order: 1723181300000 } },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(0, 5), [
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
  ]);
  const listParams: unknown = JSON.parse(calls[0]?.[5] ?? "null");
  assert.equal(
    typeof listParams === "object" && listParams !== null && "q" in listParams
      ? listParams.q
      : undefined,
    "in:inbox after:1723181240",
  );
  assert.deepEqual(calls[1]?.slice(0, 5), [
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
  ]);
  assert.equal(pages[0]?.cursor.order, 1723181400000);
  assert.equal(pages[0]?.observations[0]?.actor?.address, "alice@example.com");
  assert.equal(pages[0]?.observations[0]?.title, "Project review");
  assert.equal(pages[0]?.observations[0]?.revision, "900");
  assert.equal(
    pages[0]?.observations[0]?.evidence.locator,
    "Gmail message m-1",
  );
});

test("Gmail pagination accepts only bounded provider tokens", async () => {
  const calls: string[][] = [];
  const runner: GwsRunner = async (args) => {
    calls.push([...args]);
    if (calls.length === 1) {
      return jsonResult({ messages: [], nextPageToken: "page-2" });
    }
    return jsonResult({ messages: [] });
  };

  await collect(createGmailInboxSource({ runner, sourceAccountId: "me" }));
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.[5] ?? "", /"pageToken":"page-2"/u);

  const invalid: GwsRunner = async () =>
    jsonResult({ messages: [], nextPageToken: "x".repeat(1001) });
  await assert.rejects(
    () =>
      collect(
        createGmailInboxSource({ runner: invalid, sourceAccountId: "me" }),
      ),
    /unified_inbox_google_response_invalid/u,
  );
});

test("Google pagination carries a monotonic watermark across older pages", async () => {
  let gmailListPage = 0;
  const gmailRunner: GwsRunner = async (args) => {
    if (args[3] === "list") {
      gmailListPage += 1;
      return jsonResult({
        messages: [{ id: gmailListPage === 1 ? "m-new" : "m-old" }],
        ...(gmailListPage === 1 ? { nextPageToken: "page-2" } : {}),
      });
    }
    const params = JSON.parse(args[5] ?? "null") as { id: string };
    const internalDate =
      params.id === "m-new" ? "1723181500000" : "1723181400000";
    return jsonResult({
      id: params.id,
      threadId: `thread-${params.id}`,
      internalDate,
      payload: { headers: [] },
    });
  };
  const gmailPages = await collect(
    createGmailInboxSource({ runner: gmailRunner }),
  );
  assert.deepEqual(
    gmailPages.map((page) => page.cursor.order),
    [1723181500000, 1723181500000],
  );

  let calendarPage = 0;
  const calendarRunner: GwsRunner = async () => {
    calendarPage += 1;
    const updated =
      calendarPage === 1
        ? "2026-08-09T07:00:00.000Z"
        : "2026-08-09T06:00:00.000Z";
    return jsonResult({
      items: [
        {
          id: `event-${calendarPage}`,
          updated,
          start: { dateTime: "2026-08-09T10:00:00.000Z" },
          end: { dateTime: "2026-08-09T11:00:00.000Z" },
        },
      ],
      ...(calendarPage === 1 ? { nextPageToken: "page-2" } : {}),
    });
  };
  const calendarPages = await collect(
    createCalendarInboxSource({ runner: calendarRunner }),
  );
  assert.deepEqual(
    calendarPages.map((page) => page.cursor.value),
    ["2026-08-09T07:00:00.000Z", "2026-08-09T07:00:00.000Z"],
  );
});

test("Calendar lists a bounded window and normalizes event revisions", async () => {
  const calls: string[][] = [];
  const runner: GwsRunner = async (args) => {
    calls.push([...args]);
    return jsonResult({
      items: [
        {
          id: "event-1",
          etag: '"rev-3"',
          status: "confirmed",
          summary: "Project review",
          description: "Discuss open decisions",
          location: "Meet",
          updated: "2026-08-09T07:00:00.000Z",
          organizer: {
            email: "alice@example.com",
            displayName: "Alice",
          },
          start: { dateTime: "2026-08-09T10:00:00.000Z" },
          end: { dateTime: "2026-08-09T11:00:00.000Z" },
          attendees: [
            {
              email: "owner@example.com",
              displayName: "Owner",
              responseStatus: "accepted",
            },
          ],
        },
      ],
    });
  };

  const pages = await collect(
    createCalendarInboxSource({ runner, sourceAccountId: "primary" }),
    {
      calendar: {
        key: "calendar",
        value: "2026-08-09T06:00:00.000Z",
        order: Date.parse("2026-08-09T06:00:00.000Z"),
      },
    },
  );

  assert.deepEqual(calls[0]?.slice(0, 4), [
    "calendar",
    "events",
    "list",
    "--params",
  ]);
  const params = JSON.parse(calls[0]?.[4] ?? "null") as Record<string, unknown>;
  assert.equal(params.calendarId, "primary");
  assert.equal(params.singleEvents, true);
  assert.equal(params.orderBy, "startTime");
  assert.equal(params.timeMin, "2026-08-08T08:00:00.000Z");
  assert.equal(params.timeMax, "2026-08-16T08:00:00.000Z");
  assert.equal("updatedMin" in params, false);
  assert.equal(pages[0]?.cursor.value, "2026-08-09T07:00:00.000Z");
  assert.equal(pages[0]?.observations[0]?.startsAt, "2026-08-09T10:00:00.000Z");
  assert.equal(pages[0]?.observations[0]?.revision, '"rev-3"');
});

test("Google runner allowlist has no Gmail send, mutation, Calendar insert, or Tasks surface", () => {
  const allowed = [
    ["gmail", "users", "messages", "list", "--params", "{}"],
    ["gmail", "users", "messages", "get", "--params", "{}"],
    ["calendar", "events", "list", "--params", "{}"],
  ] as const;
  for (const args of allowed)
    assert.doesNotThrow(() => validateReadOnlyGwsArgs(args));

  for (const args of [
    ["gmail", "+send", "--to", "user@example.com"],
    ["gmail", "users", "drafts", "create", "--json", "{}"],
    ["gmail", "users", "messages", "modify", "--params", "{}"],
    ["calendar", "events", "insert", "--json", "{}"],
    ["tasks", "tasks", "insert", "--json", "{}"],
  ]) {
    assert.throws(() => validateReadOnlyGwsArgs(args), /not allowed/u);
  }
});

test("Google payload and command failures return fixed secret-free errors", async () => {
  const invalidJson: GwsRunner = async () => ({
    stdout: "token=secret",
    stderr: "alice@example.com",
    exitCode: 1,
  });
  await assert.rejects(
    () =>
      collect(
        createGmailInboxSource({ runner: invalidJson, sourceAccountId: "me" }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "unified_inbox_google_command_failed",
  );

  const malformed: GwsRunner = async () => jsonResult({ messages: "secret" });
  await assert.rejects(
    () =>
      collect(
        createGmailInboxSource({ runner: malformed, sourceAccountId: "me" }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "unified_inbox_google_response_invalid",
  );
});
