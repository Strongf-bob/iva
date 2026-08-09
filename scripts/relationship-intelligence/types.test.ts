/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCommitment,
  commitmentId,
  nextBirthdayOccurrence,
  transitionCommitment,
  type Commitment,
} from "./types.ts";

const NOW = "2026-08-09T12:00:00.000Z";

function fixture(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "RI-0123456789abcdef",
    text: "Send report",
    direction: "owner_to_contact",
    contactIds: ["telegram:user:44"],
    dueAt: null,
    status: "pending_suggestion",
    evidence: [
      {
        source: "telegram",
        sourceId: "telegram:message:44:9",
        observedAt: "2026-07-01T10:00:00.000Z",
      },
    ],
    firstSeenAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    googleTask: null,
    confirmation: null,
    ...overrides,
  };
}

test("stable IDs bind normalized content to exact evidence", () => {
  const evidence = fixture().evidence;
  assert.equal(
    commitmentId({ text: " Send   report ", evidence }),
    commitmentId({ text: "send report", evidence }),
  );
  assert.notEqual(
    commitmentId({ text: "send report", evidence }),
    commitmentId({
      text: "send report",
      evidence: [{ ...evidence[0], sourceId: "telegram:message:44:10" }],
    }),
  );
});

test("birthday occurrences advance deterministically", () => {
  assert.equal(
    nextBirthdayOccurrence("--08-17", "2026-08-09T00:00:00.000Z"),
    "2026-08-17",
  );
  assert.equal(
    nextBirthdayOccurrence("--01-01", "2026-08-09T00:00:00.000Z"),
    "2027-01-01",
  );
});

test("terminal commitments never return to pending", () => {
  assert.throws(
    () =>
      transitionCommitment(
        fixture({ status: "dismissed" }),
        "pending_suggestion",
        NOW,
      ),
    /terminal/u,
  );
});

test("overdue and forgotten are deterministic time classifications", () => {
  assert.deepEqual(
    classifyCommitment(
      fixture({ dueAt: "2026-08-08T12:00:00.000Z" }),
      NOW,
      "2026-06-01T00:00:00.000Z",
    ),
    { overdue: true, forgotten: false },
  );
  assert.deepEqual(
    classifyCommitment(fixture(), NOW, "2026-07-01T11:59:59.999Z"),
    { overdue: false, forgotten: true },
  );
});
