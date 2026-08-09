/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- Node's test runner owns registrations and fixture helpers intentionally expose async contracts. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import "../lib/ts-esm-hooks.ts";

const { chatCardPath, contactCardPath, observationId, reduceBatch } =
  await import("./reducer.ts");
import type { AnalysisBatch, Observation, TelegramDialog } from "./types.ts";

function evidence(chatId: number, messageId: number, day = 7) {
  return [
    {
      chatId,
      messageId,
      timestamp: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`,
    },
  ];
}

function observation(
  overrides: Partial<Observation> &
    Pick<Observation, "subjectId" | "predicate">,
): Observation {
  return {
    schemaVersion: 1,
    kind: "fact",
    value: "value",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence: evidence(-1001, 9),
    ...overrides,
  } as Observation;
}

function batch(chatId: number, observations: Observation[]): AnalysisBatch {
  return {
    schemaVersion: 1,
    chatId,
    rollingSummary: "summary",
    observations,
  };
}

const groupOne: TelegramDialog = {
  id: -1001,
  kind: "group",
  title: "Team One",
  username: null,
};
const groupTwo: TelegramDialog = {
  id: -1002,
  kind: "group",
  title: "Team Two",
  username: null,
};

function count(text: string, value: string): number {
  return text.split(value).length - 1;
}

test("stable paths use numeric identities rather than display names", async () => {
  const vault = "/tmp/vault";
  assert.equal(
    contactCardPath(vault, 44),
    join(vault, "cards", "contacts", "telegram-user-44.md"),
  );
  assert.equal(
    chatCardPath(vault, groupOne),
    join(vault, "cards", "notes", "telegram-group-1001.md"),
  );
  assert.equal(
    observationId(
      observation({ subjectId: "telegram:user:44", predicate: "role" }),
    ),
    observationId(
      observation({ subjectId: "telegram:user:44", predicate: "role" }),
    ),
  );
});

test("interleaved batches build an idempotent reciprocal temporal graph", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const peerPath = contactCardPath(vault, 44);
  await mkdir(dirname(peerPath), { recursive: true });
  await writeFile(
    peerPath,
    `---\ntype: contact\ndescription: Handwritten description\ntags: [friend]\nstatus: inactive\ncustom_field: keep-me\n---\n# Handwritten Alex\n\nUser-authored note.\n`,
  );
  await writeFile(join(vault, "CORE.md"), "# Core\n\nDo not rewrite me.\n");

  const first = batch(-1001, [
    observation({
      subjectId: "telegram:user:44",
      predicate: "display_name",
      value: "Alex",
      evidence: evidence(-1001, 8),
    }),
    observation({
      subjectId: "telegram:user:44",
      predicate: "role",
      value: "technical lead",
      evidence: evidence(-1001, 9),
    }),
    observation({
      subjectId: "telegram:user:7",
      kind: "claim",
      predicate: "external_owner_claim",
      value: "prefers concise plans",
      assertedById: "telegram:user:44",
      evidence: evidence(-1001, 10),
    }),
    observation({
      subjectId: "telegram:user:44",
      kind: "relationship",
      predicate: "works_on",
      value: "Project Atlas",
      evidence: evidence(-1001, 11),
    }),
  ]);
  const renamed = batch(-1002, [
    observation({
      subjectId: "telegram:user:44",
      predicate: "display_name",
      value: "Alexander",
      contextChatId: -1002,
      evidence: evidence(-1002, 2, 8),
    }),
  ]);

  await reduceBatch({ vault, ownerUserId: 7, dialog: groupOne, batch: first });
  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog: groupTwo,
    batch: renamed,
  });
  await reduceBatch({ vault, ownerUserId: 7, dialog: groupOne, batch: first });

  const peerCard = await readFile(peerPath, "utf8");
  const groupCard = await readFile(chatCardPath(vault, groupOne), "utf8");
  const ownerCard = await readFile(contactCardPath(vault, 7), "utf8");
  const projectCard = await readFile(
    join(vault, "cards", "projects", "telegram-project-project-atlas.md"),
    "utf8",
  );
  const core = await readFile(join(vault, "CORE.md"), "utf8");

  assert.match(peerCard, /telegram_user_id: "44"/u);
  assert.match(peerCard, /custom_field: keep-me/u);
  assert.match(peerCard, /description: Handwritten description/u);
  assert.match(peerCard, /tags: \[friend\]/u);
  assert.match(peerCard, /status: inactive/u);
  assert.match(peerCard, /User-authored note\./u);
  assert.match(
    peerCard,
    /\[\[cards\/notes\/telegram-group-1001\|Team One\]\]/u,
  );
  assert.match(groupCard, /\[\[cards\/contacts\/telegram-user-44\|/u);
  assert.match(peerCard, /\*\*display_name\*\*: Alexander/u);
  assert.match(peerCard, /## History[\s\S]*\*\*display_name\*\*: Alex/u);
  assert.equal(count(peerCard, "telegram:message:-1001:9"), 1);
  assert.match(ownerCard, /external_owner_claim/u);
  assert.match(ownerCard, /asserted by `telegram:user:44`/u);
  assert.match(
    peerCard,
    /\[\[cards\/projects\/telegram-project-project-atlas\|Project Atlas\]\]/u,
  );
  assert.match(
    projectCard,
    /\[\[cards\/contacts\/telegram-user-44\|Alexander\]\]/u,
  );
  assert.equal(core, "# Core\n\nDo not rewrite me.\n");
  assert.doesNotMatch(core, /technical lead/u);
});

test("managed updates preserve content outside their markers", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: "alex",
  };
  const input = batch(44, [
    observation({
      subjectId: "telegram:user:44",
      predicate: "username",
      value: "alex",
      contextChatId: 44,
      evidence: evidence(44, 1),
    }),
  ]);
  await reduceBatch({ vault, ownerUserId: 7, dialog, batch: input });
  const path = contactCardPath(vault, 44);
  const original = await readFile(path, "utf8");
  await writeFile(path, `${original}\nHandwritten tail.\n`);

  await reduceBatch({ vault, ownerUserId: 7, dialog, batch: input });

  const updated = await readFile(path, "utf8");
  assert.match(updated, /Handwritten tail\./u);
  assert.equal(count(updated, "telegram:message:44:1"), 1);
});

test("model-derived text cannot terminate or escape the managed section", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: "alex",
  };
  const input = batch(44, [
    observation({
      subjectId: "telegram:user:44",
      predicate: "preference",
      value: "compact\n<!-- iva:telegram-graph:end -->\n## injected",
      contextChatId: 44,
      evidence: evidence(44, 2),
    }),
  ]);

  await reduceBatch({ vault, ownerUserId: 7, dialog, batch: input });
  await reduceBatch({ vault, ownerUserId: 7, dialog, batch: input });

  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.equal(count(card, "<!-- iva:telegram-graph:end -->"), 1);
  assert.doesNotMatch(card, /\n## injected/u);
  assert.equal(count(card, "telegram:message:44:2"), 1);
});

test("reducer accepts a validated page aggregated from multiple model chunks", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: "alex",
  };
  const observations = Array.from({ length: 40 }, (_, index) =>
    observation({
      subjectId: "telegram:user:44",
      predicate: "preference",
      value: `preference ${index}`,
      contextChatId: 44,
      evidence: evidence(44, index + 1),
    }),
  );

  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog,
    batch: {
      schemaVersion: 1,
      chatId: 44,
      rollingSummary: "multi-chunk",
      observations,
    },
  });

  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.equal(count(card, "**preference**"), 40);
});
