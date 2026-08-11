import { z } from "zod";

import {
  PersonTaskDraftSchema,
  parseInternalRecord,
  safeHumanInline,
  serializeInternalRecord,
  stableRecordId,
  type PersonTaskDraft,
} from "./contact-memory.ts";

const START = "<!-- iva:people-tasks:start -->";
const END = "<!-- iva:people-tasks:end -->";

export const PersonTaskSchema = PersonTaskDraftSchema.extend({
  id: z.string().min(1),
  personPath: z
    .string()
    .regex(
      /^cards\/(?:contacts\/telegram-user--?[1-9]\d*|notes\/telegram-(?:group|channel)-[1-9]\d*)$/u,
    ),
  personName: z.string().trim().min(1).max(200),
  status: z.enum(["open", "done", "cancelled"]),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PersonTask = z.infer<typeof PersonTaskSchema>;

export interface PersonReference {
  path: string;
  name: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/\s+/gu, " ")
    .trim();
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
    .format(new Date(`${value}T00:00:00.000Z`))
    .replace(/\s*г\.$/u, "");
}

function monthLabel(value: string): string {
  const result = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00.000Z`));
  const clean = result.replace(/\s*г\.$/u, "");
  return clean.charAt(0).toLocaleUpperCase("ru-RU") + clean.slice(1);
}

export function addPersonTask(
  tasks: PersonTask[],
  draft: PersonTaskDraft,
  person: PersonReference,
  now: string,
): { tasks: PersonTask[]; created: boolean; task: PersonTask } {
  const parsedDraft = PersonTaskDraftSchema.parse(draft);
  const identity = {
    title: normalize(parsedDraft.title),
    direction: parsedDraft.direction,
    due: parsedDraft.due ?? null,
    context: parsedDraft.context ? normalize(parsedDraft.context) : null,
    personPath: person.path,
    originMeetingId: parsedDraft.originMeetingId ?? null,
    occurrence:
      parsedDraft.originMeetingId === undefined
        ? tasks.filter(
            (task) =>
              task.personPath === person.path &&
              normalize(task.title) === normalize(parsedDraft.title) &&
              task.status !== "open",
          ).length
        : 0,
  };
  const id = stableRecordId("task", identity);
  const existing = tasks.find((task) => task.id === id);
  if (existing) return { tasks, created: false, task: existing };
  const task = PersonTaskSchema.parse({
    ...parsedDraft,
    due: parsedDraft.due ?? null,
    id,
    personPath: person.path,
    personName: person.name,
    status: "open",
    createdAt: now,
    completedAt: null,
  });
  return { tasks: [...tasks, task], created: true, task };
}

export function activeTasksForPerson(
  tasks: PersonTask[],
  personPath: string,
): PersonTask[] {
  return tasks.filter(
    (task) => task.personPath === personPath && task.status === "open",
  );
}

export type TaskSelector = {
  id?: string;
  personPath?: string;
  title?: string;
  fuzzy?: boolean;
};

export function transitionPersonTask(
  tasks: PersonTask[],
  selector: TaskSelector,
  status: "done" | "cancelled",
  now: string,
): {
  tasks: PersonTask[];
  outcome: "changed" | "not_found" | "ambiguous";
  matches: PersonTask[];
} {
  const wanted = selector.title ? normalize(selector.title) : null;
  const matches = tasks.filter((task) => {
    if (task.status !== "open") return false;
    if (selector.id) return task.id === selector.id;
    if (selector.personPath && task.personPath !== selector.personPath)
      return false;
    if (!wanted) return false;
    const title = normalize(task.title);
    return selector.fuzzy ? title.includes(wanted) : title === wanted;
  });
  if (matches.length === 0) return { tasks, outcome: "not_found", matches };
  if (matches.length > 1) return { tasks, outcome: "ambiguous", matches };
  const id = matches[0].id;
  return {
    tasks: tasks.map((task) =>
      task.id === id ? { ...task, status, completedAt: now } : task,
    ),
    outcome: "changed",
    matches,
  };
}

function marker(task: PersonTask): string {
  return serializeInternalRecord({
    v: 1,
    id: task.id,
    kind: "person-task",
    task,
  });
}

function taskLines(task: PersonTask): string[] {
  const checked = task.status === "open" ? " " : "x";
  const lines = [
    `- [${checked}] ${safeHumanInline(task.title)}`,
    `  - **С кем:** [[${task.personPath}|${safeHumanInline(task.personName)}]]`,
  ];
  const direction = {
    owner_to_person: "Я должен этому человеку",
    person_to_owner: "Этот человек должен мне",
    follow_up: "Вернуться к разговору",
  }[task.direction];
  lines.push(`  - **Кто кому:** ${direction}`);
  if (task.due) lines.push(`  - **Срок:** ${dateLabel(task.due)}`);
  if (task.context)
    lines.push(`  - **Контекст:** ${safeHumanInline(task.context)}`);
  if (task.status !== "open" && task.completedAt) {
    const label = task.status === "done" ? "Выполнено" : "Отменено";
    lines.push(`  - **${label}:** ${dateLabel(task.completedAt.slice(0, 10))}`);
  }
  lines.push(`  ${marker(task)}`);
  return lines;
}

function managedRegion(tasks: PersonTask[], today: string): string {
  const open = tasks.filter((task) => task.status === "open");
  const done = tasks.filter((task) => task.status !== "open");
  const overdue = open.filter((task) => task.due && task.due < today);
  const dueToday = open.filter((task) => task.due === today);
  const upcoming = open.filter((task) => task.due && task.due > today);
  const undated = open.filter((task) => !task.due);
  const lines = [START];
  for (const [heading, items] of [
    ["Просрочено", overdue],
    ["Сегодня", dueToday],
    ["Предстоящие", upcoming],
    ["Без срока", undated],
  ] as const) {
    lines.push("", `## ${heading}`, "");
    for (const task of items) lines.push(...taskLines(task));
  }
  lines.push("", "## Выполнено", "");
  const months = new Map<string, PersonTask[]>();
  for (const task of done) {
    const month = (task.completedAt ?? task.createdAt).slice(0, 7) + "-01";
    const items = months.get(month) ?? [];
    items.push(task);
    months.set(month, items);
  }
  for (const month of [...months.keys()].sort().reverse()) {
    lines.push(`### ${monthLabel(month)}`, "");
    for (const task of months.get(month)!) lines.push(...taskLines(task));
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n");
}

export function renderPeopleTaskDocument(
  existing: string,
  tasks: PersonTask[],
  today: string,
): string {
  const region = managedRegion(PersonTaskSchema.array().parse(tasks), today);
  const start = existing.indexOf(START);
  let output: string;
  if (start === -1) {
    const prefix = existing.trimEnd() || "# Дела, связанные с людьми";
    output = `${prefix}\n\n${region}\n`;
  } else {
    const end = existing.indexOf(END, start + START.length);
    if (end === -1)
      throw new Error("people task region is missing its end marker");
    output = `${existing.slice(0, start)}${region}${existing.slice(end + END.length)}`;
  }
  return output.replace(/\s*$/u, "\n");
}

export function parsePeopleTaskDocument(content: string): PersonTask[] {
  const start = content.indexOf(START);
  if (start === -1) return [];
  const end = content.indexOf(END, start + START.length);
  if (end === -1)
    throw new Error("people task region is missing its end marker");
  const region = content.slice(start, end + END.length);
  const markers = region.match(/<!-- iva:record:\{.*\} -->/gu) ?? [];
  const tasks = markers.map((value) => {
    const record = parseInternalRecord(value);
    if (record.kind !== "person-task")
      throw new Error("people task region contains unsupported record");
    return PersonTaskSchema.parse(record.task);
  });
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate people task ${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}
