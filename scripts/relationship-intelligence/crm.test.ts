/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { RelationshipRegistry } from "./types.ts";

import "../lib/ts-esm-hooks.ts";

const { renderRelationshipCrm } = await import("./crm.ts");

test("CRM renders relationship status while preserving handwritten content", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-crm-"));
  const contact = join(vault, "cards/contacts/telegram-user-44.md");
  await mkdir(dirname(contact), { recursive: true });
  await writeFile(contact, "# Alex\n\nHandwritten note.\n");
  const registry: RelationshipRegistry = {
    schema: "iva-relationship-commitments/v1",
    revision: 1,
    contacts: {
      "telegram:user:44": {
        birthday: {
          value: "--08-17",
          evidence: {
            source: "telegram",
            sourceId: "telegram:message:44:1",
            observedAt: "2026-08-01T00:00:00Z",
          },
        },
        lastMeaningfulContactAt: "2026-07-01T00:00:00Z",
        meaningfulContactEvidence: {
          source: "telegram",
          sourceId: "telegram:message:44:2",
          observedAt: "2026-07-01T00:00:00Z",
        },
        followUps: [],
      },
    },
    commitments: [
      {
        id: "RI-aaaaaaaaaaaaaaaa",
        text: "Send report",
        direction: "owner_to_contact",
        contactIds: ["telegram:user:44"],
        dueAt: "2026-08-08T00:00:00Z",
        status: "pending_suggestion",
        evidence: [
          {
            source: "telegram",
            sourceId: "telegram:message:44:3",
            observedAt: "2026-07-01T00:00:00Z",
          },
        ],
        firstSeenAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        googleTask: null,
        confirmation: null,
      },
    ],
  };

  await renderRelationshipCrm({ vault, registry, now: "2026-08-09T00:00:00Z" });
  const card = await readFile(contact, "utf8");
  const overview = await readFile(
    join(vault, "cards/notes/relationship-crm.md"),
    "utf8",
  );
  assert.match(card, /Handwritten note\./u);
  assert.match(card, /Birthday: --08-17/u);
  assert.match(card, /Send report.*overdue/u);
  assert.match(overview, /RI-aaaaaaaaaaaaaaaa.*Send report/u);
});
