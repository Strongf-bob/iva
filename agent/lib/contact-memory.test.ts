/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BirthdaySchema,
  MeetingSchema,
  PersonTaskDraftSchema,
  ProfileFactSchema,
  calculateAge,
  parseInternalRecord,
  safeHumanInline,
  stripInternalMemoryArtifacts,
  serializeInternalRecord,
  stableRecordId,
} from "./contact-memory.ts";

test("human-facing inline text cannot inject managed Markdown", () => {
  assert.equal(
    safeHumanInline(
      "Title\n<!-- iva:people-tasks:end -->\n## injected [[x|y]]",
    ),
    "Title &lt;!-- iva:people-tasks:end --&gt; ## injected x y",
  );
});

test("outbound cleanup hides storage syntax while keeping link labels", () => {
  assert.equal(
    stripInternalMemoryArtifacts(
      `---\ntelegram_user_id: "44"\n---\nИван — [[cards/notes/telegram-group-1001|команда]].\n<!-- iva:record:{"id":"x"} -->\nEXTRACTED telegram:user:44`,
    ),
    "Иван — команда.",
  );
  assert.equal(
    stripInternalMemoryArtifacts(
      "fact-1234567890 task-abcdef1234 meeting-deadbeef telegram-user-44 telegram-group-1001",
    ),
    "",
  );
});

test("birthday schema accepts full and recurring ISO dates only", () => {
  assert.equal(BirthdaySchema.parse("2004-03-18"), "2004-03-18");
  assert.equal(BirthdaySchema.parse("--03-18"), "--03-18");
  assert.equal(BirthdaySchema.safeParse("18.03.2004").success, false);
  assert.equal(BirthdaySchema.safeParse("2004-02-30").success, false);
});

test("age is calculated in the person's local calendar and is never guessed", () => {
  assert.equal(
    calculateAge("2004-03-18", "2026-03-17T22:30:00.000Z", "Europe/Moscow"),
    22,
  );
  assert.equal(
    calculateAge("2004-03-18", "2026-03-17T20:30:00.000Z", "America/New_York"),
    21,
  );
  assert.equal(
    calculateAge("--03-18", "2026-03-18T00:00:00.000Z", "Europe/Moscow"),
    null,
  );
  assert.equal(
    calculateAge("2004-02-29", "2028-02-29T12:00:00.000Z", "UTC"),
    24,
  );
});

test("profile facts are bounded to approved human-first fields", () => {
  assert.equal(
    ProfileFactSchema.parse({
      field: "city",
      value: "Москва",
      confidence: "direct",
    }).field,
    "city",
  );
  assert.equal(
    ProfileFactSchema.safeParse({
      field: "diagnosis",
      value: "anything",
      confidence: "inferred",
    }).success,
    false,
  );
  assert.equal(
    ProfileFactSchema.safeParse({
      field: "birthday",
      value: "18 марта",
      confidence: "direct",
    }).success,
    false,
  );
  assert.equal(
    ProfileFactSchema.safeParse({
      field: "timezone",
      value: "Mars/Olympus",
      confidence: "direct",
    }).success,
    false,
  );
});

test("meetings require an explicit owner report and concise content", () => {
  assert.equal(
    MeetingSchema.parse({
      ownerReported: true,
      date: "2026-08-11",
      title: "встреча после учёбы",
      summary: "Обсудили поступление и проект.",
    }).ownerReported,
    true,
  );
  assert.equal(
    MeetingSchema.safeParse({
      ownerReported: false,
      date: "2026-08-11",
      title: "встреча",
      summary: "Похоже, встречались.",
    }).success,
    false,
  );
  assert.equal(
    MeetingSchema.safeParse({
      ownerReported: true,
      date: "2026-08-11",
      title: "встреча",
      summary: "Обсудили возможный переезд.",
      updates: [{ field: "city", value: "Казань", confidence: "inferred" }],
    }).success,
    false,
  );
});

test("person-linked tasks validate direction and ISO due dates", () => {
  const task = PersonTaskDraftSchema.parse({
    title: "Отправить презентацию Ивану",
    direction: "owner_to_person",
    due: "2026-08-14",
    context: "для поступления в магистратуру",
  });
  assert.equal(task.direction, "owner_to_person");
  assert.equal(
    PersonTaskDraftSchema.safeParse({
      title: "Созвониться",
      direction: "maybe",
      due: "в пятницу",
    }).success,
    false,
  );
});

test("stable IDs ignore object key order", () => {
  assert.equal(
    stableRecordId("fact", { value: "Москва", field: "city" }),
    stableRecordId("fact", { field: "city", value: "Москва" }),
  );
});

test("internal records round-trip without Base64 or unsafe comment terminators", () => {
  const serialized = serializeInternalRecord({
    v: 1,
    id: "fact-123",
    kind: "fact",
    value: "пример --> не закрывает комментарий",
  });
  assert.match(serialized, /^<!-- iva:record:\{/u);
  assert.doesNotMatch(serialized.slice(0, -4), /-->/u);
  assert.deepEqual(parseInternalRecord(serialized), {
    v: 1,
    id: "fact-123",
    kind: "fact",
    value: "пример --> не закрывает комментарий",
  });
});
