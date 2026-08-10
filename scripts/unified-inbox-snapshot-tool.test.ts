/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import snapshotTool from "../agent/tools/unified_inbox_snapshot.ts";
import { inboxStatePaths, saveInboxState } from "./unified-inbox/state.ts";
import { canonicalObservationId } from "./unified-inbox/types.ts";

const root = mkdtempSync(join(tmpdir(), "iva-inbox-snapshot-tool-"));
const dataDir = join(root, "data");
const ownerId = "20";
const execute = (
  snapshotTool as unknown as {
    execute: (input: Record<string, never>) => Promise<Record<string, unknown>>;
  }
).execute;

after(() => rmSync(root, { recursive: true, force: true }));

test("unified inbox snapshot tool is owner-only, bounded, and read-only", async () => {
  const identity = {
    source: "gmail" as const,
    sourceAccountId: "owner@example.com",
    externalId: "message-1",
  };
  const id = canonicalObservationId(identity);
  const paths = inboxStatePaths(root, dataDir, ownerId);
  await saveInboxState(paths, {
    schemaVersion: 1,
    ownerId,
    cursors: {},
    observations: {
      [id]: {
        schemaVersion: 1,
        id,
        ...identity,
        revision: "1",
        kind: "message",
        occurredAt: "2026-08-10T06:00:00.000Z",
        title: "Contract approval",
        excerpt: "Please review the attached contract before noon.",
        participants: [],
        evidence: {
          source: "gmail",
          externalId: "message-1",
          timestamp: "2026-08-10T06:00:00.000Z",
          locator: "gmail:message-1",
        },
      },
    },
    processedFingerprints: [],
    classifications: { [id]: "urgent" },
    sourceHealth: {},
    lastReport: null,
  });

  const previous = { ...process.env };
  try {
    process.env.ASSISTANT_MULTI_USER = "1";
    process.env.ASSISTANT_ROLE = "owner";
    process.env.ASSISTANT_USER_ID = ownerId;
    process.env.ASSISTANT_APP_DIR = root;
    process.env.ASSISTANT_DATA_DIR = dataDir;
    const owner = await execute({});
    assert.equal(owner.ok, true);
    assert.equal(owner.totalActionable, 1);
    assert.deepEqual(owner.items, [
      {
        category: "urgent",
        source: "gmail",
        occurredAt: "2026-08-10T06:00:00.000Z",
        title: "Contract approval",
        excerpt: "Please review the attached contract before noon.",
        evidence: {
          locator: "gmail:message-1",
          timestamp: "2026-08-10T06:00:00.000Z",
        },
      },
    ]);

    process.env.ASSISTANT_ROLE = "user";
    assert.deepEqual(await execute({}), {
      ok: false,
      error: "owner_only",
    });

    process.env.ASSISTANT_ROLE = "owner";
    for (const invalid of ["{broken", JSON.stringify({ schemaVersion: 1 })]) {
      writeFileSync(paths.stateFile, invalid, { mode: 0o600 });
      const before = statSync(paths.stateFile);
      assert.deepEqual(await execute({}), {
        ok: false,
        error: "snapshot_unavailable",
      });
      assert.equal(readFileSync(paths.stateFile, "utf8"), invalid);
      assert.equal(statSync(paths.stateFile).mode, before.mode);
      assert.deepEqual(readdirSync(paths.ownerDir), ["state.json"]);
    }
  } finally {
    process.env = previous;
  }
});
