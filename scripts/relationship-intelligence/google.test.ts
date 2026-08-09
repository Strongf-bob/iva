/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and injected runners retain async contracts. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  confirmGoogleTask,
  createGmailDraft,
  prepareTaskConfirmation,
} from "./google.ts";
import { loadRegistry, mutateRegistry, relationshipPaths } from "./store.ts";

const NOW = "2026-08-09T12:00:00.000Z";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "iva-google-relationship-"));
  const paths = relationshipPaths(root, "data");
  await mutateRegistry(paths, (registry) => {
    registry.commitments.push({
      id: "RI-aaaaaaaaaaaaaaaa",
      text: "Send report",
      direction: "owner_to_contact",
      contactIds: ["telegram:user:44"],
      dueAt: null,
      status: "pending_suggestion",
      evidence: [
        {
          source: "telegram",
          sourceId: "telegram:message:44:9",
          observedAt: NOW,
        },
      ],
      firstSeenAt: NOW,
      updatedAt: NOW,
      googleTask: null,
      confirmation: null,
    });
  });
  return paths;
}

test("Google Task requires an exact unexpired owner confirmation and is idempotent", async () => {
  const paths = await setup();
  const prepared = await prepareTaskConfirmation({
    paths,
    id: "RI-aaaaaaaaaaaaaaaa",
    role: "owner",
    now: NOW,
    nonce: "ABCD12",
  });
  await assert.rejects(
    () =>
      confirmGoogleTask({
        paths,
        id: prepared.id,
        phrase: "wrong",
        role: "owner",
        now: NOW,
        run: async () => ({ stdout: "{}", exitCode: 0 }),
      }),
    /confirmation/u,
  );
  const calls: string[][] = [];
  const receipt = await confirmGoogleTask({
    paths,
    id: prepared.id,
    phrase: prepared.phrase,
    role: "owner",
    now: NOW,
    run: async (args) => {
      calls.push([...args]);
      return args.includes("list")
        ? { stdout: '{"items":[]}', exitCode: 0 }
        : { stdout: '{"id":"task-1"}', exitCode: 0 };
    },
  });
  assert.equal(receipt.taskId, "task-1");
  assert.equal(
    (await loadRegistry(paths)).commitments[0].status,
    "confirmed_task",
  );
  const again = await confirmGoogleTask({
    paths,
    id: prepared.id,
    phrase: prepared.phrase,
    role: "owner",
    now: NOW,
    run: async () => {
      throw new Error("must not call Google twice");
    },
  });
  assert.equal(again.taskId, "task-1");
  assert.equal(calls.length, 2);
});

test("Gmail adapter creates a draft and exposes no send path", async () => {
  const calls: string[][] = [];
  const result = await createGmailDraft(
    { to: "alex@example.com", subject: "Hello", body: "Draft body" },
    async (args) => {
      calls.push([...args]);
      return { stdout: '{"id":"draft-1"}', exitCode: 0 };
    },
  );
  assert.deepEqual(result, { draftId: "draft-1" });
  assert.deepEqual(calls[0].slice(0, 3), ["gmail", "users", "drafts"]);
  assert.ok(calls[0].includes("create"));
  assert.ok(!calls[0].includes("send"));
});
