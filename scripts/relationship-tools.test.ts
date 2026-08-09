/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dismissCommitment } from "../agent/tools/relationship_intelligence.ts";
import {
  loadRegistry,
  mutateRegistry,
  relationshipPaths,
} from "./relationship-intelligence/store.ts";

test("commitment dismissal is an owner-only internal mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-relationship-tool-"));
  const paths = relationshipPaths(root, "data");
  await mutateRegistry(paths, (registry) => {
    registry.commitments.push({
      id: "RI-aaaaaaaaaaaaaaaa",
      text: "Send report",
      direction: "owner_to_contact",
      contactIds: [],
      dueAt: null,
      status: "pending_suggestion",
      evidence: [
        {
          source: "owner",
          sourceId: "owner:manual:1",
          observedAt: "2026-08-09T12:00:00.000Z",
        },
      ],
      firstSeenAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
      googleTask: null,
      confirmation: null,
    });
  });
  await assert.rejects(
    () =>
      dismissCommitment({
        paths,
        id: "RI-aaaaaaaaaaaaaaaa",
        role: "member",
      }),
    /only the owner/u,
  );
  await dismissCommitment({
    paths,
    id: "RI-aaaaaaaaaaaaaaaa",
    role: "owner",
    now: "2026-08-09T12:01:00.000Z",
  });
  assert.equal((await loadRegistry(paths)).commitments[0].status, "dismissed");
});

test("model tools cannot confirm tasks and trusted Telegram wiring owns confirmation", async () => {
  const tool = await readFile(
    new URL("../agent/tools/relationship_intelligence.ts", import.meta.url),
    "utf8",
  );
  const channel = await readFile(
    new URL("../agent/channels/telegram.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(tool, /confirm_google_task/u);
  assert.match(channel, /confirmGoogleTaskFromOwnerMessage/u);
  assert.match(channel, /message\.chat\.type/u);
});

test("scheduled reports collect fixed read-only evidence without an agent tool loop", async () => {
  const source = await readFile(
    new URL("./relationship-report.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["']eve\/client["']/u);
  assert.doesNotMatch(source, /\.session\(/u);
  assert.match(source, /collectCalendarMeetings/u);
  assert.match(source, /requireActiveTelegramOwner/u);
});
