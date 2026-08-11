/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PersonTaskSchema,
  addPersonTask,
  activeTasksForPerson,
  parsePeopleTaskDocument,
  renderPeopleTaskDocument,
  transitionPersonTask,
} from "./people-task-store.ts";

const person = {
  path: "cards/contacts/telegram-user-44",
  name: "Иван Петров",
};

test("person task paths are limited to canonical contact and chat cards", () => {
  const base = {
    id: "task-1",
    title: "Отправить файл",
    direction: "owner_to_person" as const,
    personName: "Иван",
    status: "open" as const,
    createdAt: "2026-08-11T12:00:00.000Z",
    completedAt: null,
  };
  assert.equal(
    PersonTaskSchema.safeParse({
      ...base,
      personPath: "cards/contacts/../outside",
    }).success,
    false,
  );
  assert.equal(
    PersonTaskSchema.safeParse({
      ...base,
      personPath: "cards/notes/telegram-group-1001",
    }).success,
    true,
  );
});

test("task prose cannot terminate managed regions or create wiki links", () => {
  const { tasks } = addPersonTask(
    [],
    {
      title: "Файл\n<!-- iva:people-tasks:end -->\n## Подмена",
      direction: "owner_to_person",
      context: "[[секрет|ссылка]]",
    },
    { ...person, name: "Иван]]\n## Подмена" },
    "2026-08-11T12:00:00.000Z",
  );
  const markdown = renderPeopleTaskDocument("", tasks, "2026-08-11");
  assert.equal(markdown.split("<!-- iva:people-tasks:end -->").length - 1, 1);
  assert.doesNotMatch(markdown, /\n## Подмена/u);
  assert.doesNotMatch(markdown, /\*\*Контекст:\*\* \[\[/u);
  assert.deepEqual(parsePeopleTaskDocument(markdown), tasks);
});

test("person task renders in a due-date section with a reciprocal link", () => {
  const { tasks } = addPersonTask(
    [],
    {
      title: "Отправить презентацию Ивану",
      direction: "owner_to_person",
      due: "2026-08-14",
      context: "для поступления",
    },
    person,
    "2026-08-11T12:00:00.000Z",
  );
  const markdown = renderPeopleTaskDocument("", tasks, "2026-08-11");

  assert.match(markdown, /^# Дела, связанные с людьми$/mu);
  assert.match(markdown, /## Предстоящие/u);
  assert.match(
    markdown,
    /\[\[cards\/contacts\/telegram-user-44\|Иван Петров\]\]/u,
  );
  assert.match(markdown, /\*\*Срок:\*\* 14 августа 2026/u);
  assert.match(markdown, /<!-- iva:record:\{/u);
  assert.deepEqual(parsePeopleTaskDocument(markdown), tasks);
  assert.equal(activeTasksForPerson(tasks, person.path).length, 1);
});

test("replayed task creation is idempotent", () => {
  const draft = {
    title: "Отправить презентацию Ивану",
    direction: "owner_to_person" as const,
    due: "2026-08-14",
    context: "для поступления",
  };
  const first = addPersonTask([], draft, person, "2026-08-11T12:00:00.000Z");
  const second = addPersonTask(
    first.tasks,
    draft,
    person,
    "2026-08-11T12:01:00.000Z",
  );
  assert.equal(second.created, false);
  assert.equal(second.tasks.length, 1);
});

test("the same obligation can recur after its earlier occurrence is done", () => {
  const draft = {
    title: "Отправить отчёт",
    direction: "owner_to_person" as const,
  };
  const first = addPersonTask(
    [],
    draft,
    person,
    "2026-08-11T12:00:00.000Z",
  ).tasks;
  const done = transitionPersonTask(
    first,
    { id: first[0].id },
    "done",
    "2026-08-12T12:00:00.000Z",
  ).tasks;
  const recurring = addPersonTask(
    done,
    draft,
    person,
    "2026-09-11T12:00:00.000Z",
  );
  assert.equal(recurring.created, true);
  assert.equal(recurring.tasks.length, 2);
  assert.notEqual(recurring.tasks[0].id, recurring.tasks[1].id);
});

test("only one exact open match completes automatically", () => {
  const first = addPersonTask(
    [],
    { title: "Отправить презентацию", direction: "owner_to_person" },
    person,
    "2026-08-11T12:00:00.000Z",
  ).tasks;
  const completed = transitionPersonTask(
    first,
    { personPath: person.path, title: "отправить презентацию" },
    "done",
    "2026-08-12T10:00:00.000Z",
  );
  assert.equal(completed.outcome, "changed");
  assert.equal(completed.tasks[0]?.status, "done");
  assert.equal(completed.tasks[0]?.completedAt, "2026-08-12T10:00:00.000Z");
});

test("ambiguous completion leaves every task open", () => {
  const one = addPersonTask(
    [],
    { title: "Отправить файл", direction: "owner_to_person" },
    person,
    "2026-08-11T12:00:00.000Z",
  ).tasks;
  const two = addPersonTask(
    one,
    { title: "Отправить файл ещё раз", direction: "owner_to_person" },
    person,
    "2026-08-11T12:01:00.000Z",
  ).tasks;
  const result = transitionPersonTask(
    two,
    { personPath: person.path, title: "отправить файл", fuzzy: true },
    "done",
    "2026-08-12T10:00:00.000Z",
  );
  assert.equal(result.outcome, "ambiguous");
  assert.equal(
    result.tasks.every((task) => task.status === "open"),
    true,
  );
});

test("cancelled and completed tasks move to the completed month", () => {
  const open = addPersonTask(
    [],
    { title: "Созвониться", direction: "follow_up" },
    person,
    "2026-08-11T12:00:00.000Z",
  ).tasks;
  const cancelled = transitionPersonTask(
    open,
    { id: open[0].id },
    "cancelled",
    "2026-08-13T10:00:00.000Z",
  ).tasks;
  const markdown = renderPeopleTaskDocument("", cancelled, "2026-08-13");
  assert.match(markdown, /## Выполнено[\s\S]*### Август 2026/u);
  assert.match(markdown, /\*\*Отменено:\*\* 13 августа 2026/u);
});

test("manual prose outside the managed task region survives rerender", () => {
  const existing = "# Мои заметки\n\nЭтот текст написан вручную.\n";
  const markdown = renderPeopleTaskDocument(existing, [], "2026-08-11");
  assert.match(markdown, /Этот текст написан вручную\./u);
  assert.equal(renderPeopleTaskDocument(markdown, [], "2026-08-11"), markdown);
});
