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
      subjectId: "telegram:user:44",
      predicate: "city",
      value: "Москва",
      evidence: evidence(-1001, 12),
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
  assert.match(peerCard, /^# Alexander$/mu);
  assert.match(peerCard, /## Основные сведения[\s\S]*Город: Москва/u);
  assert.match(peerCard, /## Работа и проекты[\s\S]*Роль: technical lead/u);
  assert.match(peerCard, /## Архив изменений[\s\S]*Имя: Alex/u);
  assert.equal(count(peerCard, '"messageId":9'), 1);
  assert.doesNotMatch(peerCard, /telegram:message:/u);
  assert.doesNotMatch(peerCard, /telegram-graph:state:[A-Za-z0-9_-]+/u);
  assert.match(ownerCard, /Со слов другого человека: prefers concise plans/u);
  assert.doesNotMatch(ownerCard, /asserted by/u);
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
  assert.equal(count(updated, '"messageId":1'), 1);
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
  assert.equal(count(card, '"messageId":2'), 1);
});

test("owner meeting summary cannot terminate the managed section", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const { applyOwnerContactUpdate } = await import("./reducer.ts");
  applyOwnerContactUpdate({
    vault,
    userId: 44,
    displayName: "Alex",
    meeting: {
      ownerReported: true,
      date: "2026-08-11",
      title: "Кофе",
      summary: "Итог\n<!-- iva:telegram-graph:end -->\n## injected",
    },
    now: "2026-08-11T12:00:00.000Z",
  });
  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.equal(count(card, "<!-- iva:telegram-graph:end -->"), 1);
  assert.doesNotMatch(card, /\n## injected/u);
});

test("corrected extracted birthday supersedes stale frontmatter", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: "alex",
  };
  for (const [value, day] of [
    ["2000-01-01", 7],
    ["2001-02-03", 8],
  ] as const) {
    await reduceBatch({
      vault,
      ownerUserId: 7,
      dialog,
      batch: batch(44, [
        observation({
          subjectId: "telegram:user:44",
          predicate: "birthday",
          value,
          contextChatId: 44,
          evidence: evidence(44, day, day),
        }),
      ]),
    });
  }
  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.match(card, /^birthday: 2001-02-03$/mu);
  assert.doesNotMatch(card, /^birthday: 2000-01-01$/mu);
  assert.match(card, /## Архив изменений[\s\S]*Дата рождения: 2000-01-01/u);
});

test("fact deletion handles history and removes stale frontmatter", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const { applyOwnerContactUpdate, deleteOwnerContactRecord } =
    await import("./reducer.ts");
  for (const value of ["Москва", "Казань"]) {
    applyOwnerContactUpdate({
      vault,
      userId: 44,
      displayName: "Alex",
      facts: [{ field: "city", value, confidence: "direct" }],
      now: "2026-08-11T12:00:00.000Z",
    });
  }
  assert.equal(
    deleteOwnerContactRecord({
      vault,
      userId: 44,
      selector: { kind: "fact", field: "city", value: "Москва" },
    }).deleted,
    true,
  );
  assert.equal(
    deleteOwnerContactRecord({
      vault,
      userId: 44,
      selector: { kind: "fact", field: "city", value: "Казань" },
    }).deleted,
    true,
  );
  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.doesNotMatch(card, /^city:/mu);
  assert.doesNotMatch(card, /Город: (?:Москва|Казань)/u);
});

test("an owner correction archives a conflicting background city", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: null,
  };
  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog,
    batch: batch(44, [
      observation({
        subjectId: "telegram:user:44",
        predicate: "city",
        value: "Москва",
        contextChatId: 44,
      }),
    ]),
  });
  const { applyOwnerContactUpdate } = await import("./reducer.ts");
  applyOwnerContactUpdate({
    vault,
    userId: 44,
    displayName: "Alex",
    facts: [{ field: "city", value: "Казань", confidence: "direct" }],
    now: "2026-08-11T12:00:00.000Z",
  });
  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.match(card, /## Основные сведения[\s\S]*Город: Казань/u);
  assert.doesNotMatch(card.split("## Архив изменений")[0], /Город: Москва/u);
  assert.match(card, /## Архив изменений[\s\S]*Город: Москва/u);
});

test("meeting deletion fails closed when date and title match more than one record", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const { applyOwnerContactUpdate, deleteOwnerContactRecord } =
    await import("./reducer.ts");
  for (const summary of ["Первое резюме", "Второе резюме"]) {
    applyOwnerContactUpdate({
      vault,
      userId: 44,
      displayName: "Alex",
      meeting: {
        ownerReported: true,
        date: "2026-08-11",
        title: "Созвон",
        summary,
      },
      now: "2026-08-11T12:00:00.000Z",
    });
  }
  const result = deleteOwnerContactRecord({
    vault,
    userId: 44,
    selector: { kind: "meeting", date: "2026-08-11", title: "Созвон" },
  });
  assert.equal(result.ambiguous, true);
  const card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.match(card, /Первое резюме/u);
  assert.match(card, /Второе резюме/u);
});

test("deleting a meeting restores the previous fact and preserves independent confirmation", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: null,
  };
  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog,
    batch: batch(44, [
      observation({
        subjectId: "telegram:user:44",
        predicate: "city",
        value: "Москва",
        contextChatId: 44,
      }),
    ]),
  });
  const { applyOwnerContactUpdate, deleteOwnerContactRecord } =
    await import("./reducer.ts");
  for (const [date, summary] of [
    ["2026-08-10", "Первое подтверждение"],
    ["2026-08-11", "Второе подтверждение"],
  ] as const) {
    applyOwnerContactUpdate({
      vault,
      userId: 44,
      displayName: "Alex",
      facts: [{ field: "city", value: "Казань", confidence: "direct" }],
      meeting: { ownerReported: true, date, title: "Созвон", summary },
      now: `${date}T12:00:00.000Z`,
    });
  }
  deleteOwnerContactRecord({
    vault,
    userId: 44,
    selector: {
      kind: "meeting",
      date: "2026-08-10",
      title: "Созвон",
      summary: "Первое подтверждение",
    },
  });
  let card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.match(card.split("## Архив изменений")[0], /Город: Казань/u);
  deleteOwnerContactRecord({
    vault,
    userId: 44,
    selector: {
      kind: "meeting",
      date: "2026-08-11",
      title: "Созвон",
      summary: "Второе подтверждение",
    },
  });
  card = await readFile(contactCardPath(vault, 44), "utf8");
  assert.match(card.split("## Архив изменений")[0], /Город: Москва/u);
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
  assert.equal(count(card, "Предпочтение:"), 40);
});

test("legacy Base64 state is migrated to readable Markdown on the next update", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: "alex",
  };
  const legacyObservation = observation({
    subjectId: "telegram:user:44",
    predicate: "city",
    value: "Казань",
    contextChatId: 44,
    evidence: evidence(44, 3),
  });
  const encoded = Buffer.from(
    JSON.stringify({ current: [legacyObservation], history: [], links: [] }),
  ).toString("base64url");
  const file = contactCardPath(vault, 44);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `---\ntype: contact\ntelegram_user_id: "44"\n---\n# Alex\n\n<!-- iva:telegram-graph:start -->\n<!-- iva:telegram-graph:state:${encoded} -->\n## Telegram Graph\n\n### Current\n- legacy\n<!-- iva:telegram-graph:end -->\n`,
  );

  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog,
    batch: batch(44, []),
  });

  const migrated = await readFile(file, "utf8");
  assert.match(migrated, /## Основные сведения[\s\S]*Город: Казань/u);
  assert.doesNotMatch(migrated, /telegram-graph:state:/u);
  assert.match(migrated, /<!-- iva:record:\{/u);
});

test("an ambiguous birthday remains hidden as a candidate until direct evidence arrives", async () => {
  const vault = await mkdtemp(join(tmpdir(), "iva-contact-vault-"));
  const dialog: TelegramDialog = {
    id: 44,
    kind: "private",
    title: "Alex",
    username: "alex",
  };
  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog,
    batch: batch(44, [
      observation({
        subjectId: "telegram:user:44",
        predicate: "birthday",
        value: "--08-11",
        confidence: "AMBIGUOUS",
        contextChatId: 44,
        evidence: evidence(44, 20),
      }),
    ]),
  });
  const candidate = await readFile(contactCardPath(vault, 44), "utf8");
  assert.doesNotMatch(candidate, /Дата рождения: --08-11/u);
  assert.match(candidate, /"state":"candidate"/u);

  await reduceBatch({
    vault,
    ownerUserId: 7,
    dialog,
    batch: batch(44, [
      observation({
        subjectId: "telegram:user:44",
        predicate: "birthday",
        value: "2004-08-11",
        confidence: "EXTRACTED",
        contextChatId: 44,
        evidence: evidence(44, 21),
      }),
    ]),
  });
  const confirmed = await readFile(contactCardPath(vault, 44), "utf8");
  assert.match(confirmed, /Дата рождения: 2004-08-11/u);
});
