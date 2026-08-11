/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registrations. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContactMemoryInput } from "../agent/tools/contact_memory.ts";

import "./lib/ts-esm-hooks.ts";

const vault = await mkdtemp(join(tmpdir(), "iva-contact-memory-tool-"));
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.ASSISTANT_TIMEZONE = "Europe/Moscow";
const { default: contactMemory } =
  await import("../agent/tools/contact_memory.ts");
type ContactMemoryResult = {
  ok: boolean;
  message?: string;
  error?: string;
  profile?: string;
  age?: number | null;
};
type ParseSchema<T> = { parse: (value: unknown) => T };
const inputSchema =
  contactMemory.inputSchema as unknown as ParseSchema<ContactMemoryInput>;
const testTool = contactMemory as unknown as {
  execute: (input: ContactMemoryInput) => Promise<ContactMemoryResult>;
};
const call = (args: unknown) => testTool.execute(inputSchema.parse(args));

test("record_meeting appends one readable meeting, facts, and linked tasks", async () => {
  const result = await call({
    action: "record_meeting",
    telegram_user_id: 44,
    display_name: "Иван Петров",
    meeting: {
      ownerReported: true,
      date: "2026-08-11",
      title: "встреча после учёбы",
      summary: "Обсудили поступление в магистратуру и образовательный проект.",
      updates: [
        { field: "city", value: "Москва", confidence: "direct" },
        {
          field: "birthday",
          value: "2004-03-18",
          confidence: "direct",
        },
      ],
      followups: ["Спросить, какую программу он выбрал"],
    },
    tasks: [
      {
        title: "Отправить презентацию Ивану",
        direction: "owner_to_person",
        due: "2026-08-14",
        context: "для поступления",
      },
    ],
    now: "2026-08-11T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.match(
    result.message ?? "",
    /Добавила встречу в профиль «Иван Петров»/u,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /iva:|telegram:user|EXTRACTED|AMBIGUOUS/u,
  );

  const card = await readFile(
    join(vault, "cards/contacts/telegram-user-44.md"),
    "utf8",
  );
  const tasks = await readFile(join(vault, "tasks/people.md"), "utf8");
  assert.match(card, /## Основные сведения[\s\S]*Город: Москва/u);
  assert.match(card, /## История встреч[\s\S]*встреча после учёбы/u);
  assert.match(card, /## К следующему разговору[\s\S]*какую программу/u);
  assert.match(
    card,
    /## Открытые дела[\s\S]*\[\[tasks\/people\|Отправить презентацию Ивану\]\]/u,
  );
  assert.match(tasks, /Отправить презентацию Ивану/u);
});

test("replayed meeting and task do not duplicate", async () => {
  const args = {
    action: "record_meeting",
    telegram_user_id: 44,
    display_name: "Иван Петров",
    meeting: {
      ownerReported: true,
      date: "2026-08-12",
      title: "короткий созвон",
      summary: "Уточнили следующий шаг.",
    },
    tasks: [
      {
        title: "Прислать ссылку Ивану",
        direction: "owner_to_person",
      },
      {
        title: "Прислать документ Ивану",
        direction: "owner_to_person",
      },
    ],
    now: "2026-08-12T12:00:00.000Z",
  };
  await call(args);
  await call(args);
  const card = await readFile(
    join(vault, "cards/contacts/telegram-user-44.md"),
    "utf8",
  );
  const tasks = await readFile(join(vault, "tasks/people.md"), "utf8");
  assert.equal(card.match(/^### 2026-08-12 — короткий созвон$/gmu)?.length, 1);
  assert.equal(tasks.match(/^- \[ \] Прислать ссылку Ивану$/gmu)?.length, 1);
});

test("get returns a clean profile with current age", async () => {
  const result = await call({
    action: "get",
    telegram_user_id: 44,
    now: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.age, 22);
  assert.doesNotMatch(
    result.profile ?? "",
    /<!--|---|telegram_user_id|iva:record|cards\/|telegram-(?:user|group|channel)/u,
  );
  assert.match(result.profile ?? "", /Иван Петров/u);
});

test("a natural name resolves one existing card and ambiguity fails closed", async () => {
  const found = await call({
    action: "get",
    person_name: "иван петров",
    now: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(found.ok, true);
  await call({
    action: "update_profile",
    telegram_user_id: 66,
    display_name: "Иван Петров",
    facts: [{ field: "city", value: "Омск", confidence: "direct" }],
  });
  const ambiguous = await call({ action: "get", person_name: "Иван Петров" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /несколько людей/u);
});

test("an exact completion moves the linked task and ambiguity fails closed", async () => {
  const completed = await call({
    action: "complete_task",
    telegram_user_id: 44,
    task_title: "Отправить презентацию Ивану",
    now: "2026-08-15T12:00:00.000Z",
  });
  assert.equal(completed.ok, true);
  assert.match(completed.message ?? "", /выполнен/u);

  const ambiguous = await call({
    action: "complete_task",
    telegram_user_id: 44,
    task_title: "Прислать",
    fuzzy: true,
    now: "2026-08-15T12:00:00.000Z",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /не нашла|несколько/u);
});

test("profile corrections archive old current values and scoped deletion removes one record", async () => {
  await call({
    action: "update_profile",
    telegram_user_id: 44,
    display_name: "Иван Петров",
    facts: [
      { field: "city", value: "Санкт-Петербург", confidence: "direct" },
      {
        field: "interesting_fact",
        value: "Коллекционирует открытки",
        confidence: "direct",
      },
    ],
    now: "2026-08-16T12:00:00.000Z",
  });
  let card = await readFile(
    join(vault, "cards/contacts/telegram-user-44.md"),
    "utf8",
  );
  assert.match(card, /## Основные сведения[\s\S]*Город: Санкт-Петербург/u);
  assert.match(card, /## Архив изменений[\s\S]*Город: Москва/u);

  const deleted = await call({
    action: "delete_record",
    telegram_user_id: 44,
    record_kind: "fact",
    field: "interesting_fact",
    value: "Коллекционирует открытки",
  });
  assert.equal(deleted.ok, true);
  assert.doesNotMatch(JSON.stringify(deleted), /iva:record|fact-/u);
  card = await readFile(
    join(vault, "cards/contacts/telegram-user-44.md"),
    "utf8",
  );
  assert.doesNotMatch(card, /Коллекционирует открытки/u);
  assert.match(card, /Санкт-Петербург/u);
});

test("deleting a meeting removes facts and tasks that came only from it", async () => {
  await call({
    action: "record_meeting",
    telegram_user_id: 55,
    display_name: "Анна",
    meeting: {
      ownerReported: true,
      date: "2026-08-10",
      title: "ужин",
      summary: "Обсудили переезд.",
      updates: [{ field: "city", value: "Тула", confidence: "direct" }],
    },
    tasks: [{ title: "Отправить Анне адрес", direction: "owner_to_person" }],
    now: "2026-08-10T20:00:00.000Z",
  });
  const deleted = await call({
    action: "delete_record",
    telegram_user_id: 55,
    record_kind: "meeting",
    meeting_date: "2026-08-10",
    meeting_title: "ужин",
    now: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(deleted.ok, true);
  const card = await readFile(
    join(vault, "cards/contacts/telegram-user-55.md"),
    "utf8",
  );
  const tasks = await readFile(join(vault, "tasks/people.md"), "utf8");
  assert.doesNotMatch(
    card,
    /Обсудили переезд|Город: Тула|Отправить Анне адрес/u,
  );
  assert.doesNotMatch(tasks, /Отправить Анне адрес/u);
});
