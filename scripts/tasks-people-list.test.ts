/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  addPersonTask,
  renderPeopleTaskDocument,
} from "../agent/lib/people-task-store.ts";
import "./lib/ts-esm-hooks.ts";

const root = await mkdtemp(join(tmpdir(), "iva-tasks-people-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_VAULT_DIR = join(root, "vault");
const { default: tasksTool } = await import("../agent/tools/tasks.ts");

test("tasks list includes clean person-linked obligations without internal IDs", async () => {
  const task = addPersonTask(
    [],
    { title: "Отправить презентацию", direction: "owner_to_person" },
    { path: "cards/contacts/telegram-user-44", name: "Иван" },
    "2026-08-11T12:00:00.000Z",
  ).tasks;
  const file = join(process.env.ASSISTANT_VAULT_DIR!, "tasks/people.md");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, renderPeopleTaskDocument("", task, "2026-08-11"));

  const tool = tasksTool as unknown as {
    execute: (input: {
      action: "list";
      includeDone?: boolean;
    }) => Promise<Record<string, unknown>>;
  };
  const result = await tool.execute({ action: "list" });
  assert.equal(result.peopleCount, 1);
  assert.match(JSON.stringify(result.peopleTasks), /Отправить презентацию/u);
  assert.doesNotMatch(
    JSON.stringify(result.peopleTasks),
    /task-|iva:|telegram-user/u,
  );
});
