import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { acquireLock, atomicWrite } from "../../agent/lib/card-store.ts";
import {
  activeTasksForPerson,
  parsePeopleTaskDocument,
  renderPeopleTaskDocument,
  type PersonTask,
} from "../../agent/lib/people-task-store.ts";
import { safeHumanInline } from "../../agent/lib/contact-memory.ts";
import { withContactMemoryLockAsync } from "../../agent/lib/contact-memory-transaction.ts";

const START = "<!-- iva:person-open-tasks:start -->";
const END = "<!-- iva:person-open-tasks:end -->";

function assertContained(vault: string, file: string): void {
  const lexical = resolve(file);
  const lexicalRoot = resolve(vault);
  if (!lexical.startsWith(`${lexicalRoot}${sep}`))
    throw new Error("contact-memory path is outside the vault");
  const vaultRoot = realpathSync(vault);
  const actual = realpathSync(file);
  if (!actual.startsWith(`${vaultRoot}${sep}`))
    throw new Error("contact-memory symlink points outside the vault");
}

export function personTaskReconciliationFiles(input: {
  vault: string;
  personPaths?: string[];
}): string[] {
  const tasksFile = join(input.vault, "tasks", "people.md");
  if (!existsSync(tasksFile)) return [];
  assertContained(input.vault, tasksFile);
  const tasks = parsePeopleTaskDocument(readFileSync(tasksFile, "utf8"));
  const people = new Set([
    ...tasks.map((task) => task.personPath),
    ...(input.personPaths ?? []),
  ]);
  const files = [tasksFile];
  for (const personPath of [...people].sort()) {
    const file = join(input.vault, `${personPath}.md`);
    if (!existsSync(file)) continue;
    assertContained(input.vault, file);
    files.push(file);
  }
  return files;
}

function renderOpenTasks(tasks: PersonTask[]): string {
  if (tasks.length === 0) return "";
  return [
    START,
    "## Открытые дела",
    "",
    ...tasks.map((task) => `- [[tasks/people|${safeHumanInline(task.title)}]]`),
    END,
  ].join("\n");
}

function replaceRegion(content: string, region: string): string {
  const start = content.indexOf(START);
  if (start === -1) {
    return region ? `${content.trimEnd()}\n\n${region}\n` : content;
  }
  const end = content.indexOf(END, start + START.length);
  if (end === -1)
    throw new Error("person open-task region is missing its end marker");
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + END.length).trimStart();
  return [before, region, after]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\s*$/u, "\n");
}

export async function reconcilePersonTasks(input: {
  vault: string;
  today: string;
  personPaths?: string[];
  transactionLocked?: boolean;
}): Promise<{ changedFiles: string[] }> {
  if (!input.transactionLocked) {
    return withContactMemoryLockAsync(input.vault, () =>
      reconcilePersonTasks({ ...input, transactionLocked: true }),
    );
  }
  const tasksFile = join(input.vault, "tasks", "people.md");
  if (!existsSync(tasksFile)) return { changedFiles: [] };
  assertContained(input.vault, tasksFile);
  const taskRelease = acquireLock(tasksFile);
  const changedFiles: string[] = [];
  try {
    const existing = readFileSync(tasksFile, "utf8");
    const tasks = parsePeopleTaskDocument(existing);
    const repaired = renderPeopleTaskDocument(existing, tasks, input.today);
    if (repaired !== existing) {
      atomicWrite(tasksFile, repaired);
      changedFiles.push(tasksFile);
    }
    const people = [
      ...new Set([
        ...tasks.map((task) => task.personPath),
        ...(input.personPaths ?? []),
      ]),
    ].sort();
    for (const personPath of people) {
      const file = join(input.vault, `${personPath}.md`);
      if (!existsSync(file)) continue;
      assertContained(input.vault, file);
      const release = acquireLock(file);
      try {
        const personExisting = readFileSync(file, "utf8");
        const active = activeTasksForPerson(tasks, personPath);
        const rendered = replaceRegion(personExisting, renderOpenTasks(active));
        if (rendered !== personExisting) {
          atomicWrite(file, rendered);
          changedFiles.push(file);
        }
      } finally {
        release();
      }
    }
  } finally {
    taskRelease();
  }
  return { changedFiles };
}
