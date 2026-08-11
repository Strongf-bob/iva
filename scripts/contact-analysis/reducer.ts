import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

import {
  parseFrontmatter,
  writeFrontmatter,
  type FmFields,
} from "../../agent/lib/frontmatter.ts";
import { acquireLock, atomicWrite } from "../../agent/lib/card-store.ts";
import {
  withContactMemoryLock,
  runContactMemoryTransaction,
} from "../../agent/lib/contact-memory-transaction.ts";
import {
  MeetingSchema,
  ProfileFactSchema,
  parseInternalRecord,
  serializeInternalRecord,
  stableRecordId,
  safeHumanInline,
  type Meeting,
  type ProfileFact,
} from "../../agent/lib/contact-memory.ts";
import {
  AnalysisPageSchema,
  ObservationSchema,
  type AnalysisPage,
  type Observation,
  type TelegramDialog,
} from "./types.ts";

const START = "<!-- iva:telegram-graph:start -->";
const END = "<!-- iva:telegram-graph:end -->";
const STATE_PREFIX = "<!-- iva:telegram-graph:state:";

const ManagedLinkSchema = z.strictObject({
  target: z.string().min(1),
  label: z.string().min(1).max(500),
});
const StoredFactSchema = ProfileFactSchema.extend({
  id: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  originMeetingId: z.string().min(1).optional(),
  originMeetingIds: z.array(z.string().min(1)).optional(),
});
type StoredFact = z.infer<typeof StoredFactSchema>;
const StoredMeetingSchema = MeetingSchema.extend({
  id: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});
const ManagedStateSchema = z.strictObject({
  current: z.array(ObservationSchema),
  history: z.array(ObservationSchema),
  candidates: z.array(ObservationSchema).default([]),
  links: z.array(ManagedLinkSchema),
  ownerFacts: z.array(StoredFactSchema).default([]),
  factHistory: z.array(StoredFactSchema).default([]),
  meetings: z.array(StoredMeetingSchema).default([]),
});
type ManagedState = z.infer<typeof ManagedStateSchema>;

interface CardState {
  file: string;
  cardType: "contact" | "note" | "project";
  numericId: number | null;
  title: string;
  original: string | undefined;
  managed: ManagedState;
}

export interface ReduceBatchInput {
  vault: string;
  ownerUserId: number;
  dialog: TelegramDialog;
  batch: AnalysisPage;
  transactionLocked?: boolean;
}

export interface ReduceResult {
  writtenFiles: string[];
  observationIds: string[];
}

function requireSafeNonZeroInteger(id: number, name: string): number {
  if (!Number.isSafeInteger(id) || id === 0) {
    throw new TypeError(`${name} must be a safe non-zero integer`);
  }
  return id;
}

export function contactCardPath(vault: string, userId: number): string {
  return join(
    vault,
    "cards",
    "contacts",
    `telegram-user-${requireSafeNonZeroInteger(userId, "user ID")}.md`,
  );
}

export function chatCardPath(vault: string, dialog: TelegramDialog): string {
  const id = Math.abs(requireSafeNonZeroInteger(dialog.id, "chat ID"));
  return join(vault, "cards", "notes", `telegram-${dialog.kind}-${id}.md`);
}

function projectSlug(title: string): string {
  return (
    title
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) ||
    createHash("sha256").update(title).digest("hex").slice(0, 16)
  );
}

function projectCardPath(vault: string, title: string): string {
  return join(
    vault,
    "cards",
    "projects",
    `telegram-project-${projectSlug(title)}.md`,
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function observationId(observation: Observation): string {
  const parsed = ObservationSchema.parse(observation);
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

function emptyManaged(): ManagedState {
  return {
    current: [],
    history: [],
    candidates: [],
    links: [],
    ownerFacts: [],
    factHistory: [],
    meetings: [],
  };
}

function ownedRegion(body: string): string | null {
  const start = body.indexOf(START);
  if (start === -1) return null;
  const end = body.indexOf(END, start + START.length);
  if (end === -1) {
    throw new Error("Telegram graph managed section is missing its end marker");
  }
  return body.slice(start, end + END.length);
}

function parseManaged(body: string): ManagedState {
  const region = ownedRegion(body);
  if (region === null) return emptyManaged();
  const stateStart = region.indexOf(STATE_PREFIX);
  if (stateStart === -1) {
    const managed = emptyManaged();
    const markers = region.match(/<!-- iva:record:\{.*\} -->/gu) ?? [];
    for (const marker of markers) {
      const record = parseInternalRecord(marker);
      if (record.kind === "observation") {
        const observation = ObservationSchema.parse(record.observation);
        if (record.state === "current") managed.current.push(observation);
        else if (record.state === "history") managed.history.push(observation);
        else if (record.state === "candidate")
          managed.candidates.push(observation);
        else throw new Error("contact-memory observation has invalid state");
      } else if (record.kind === "link") {
        managed.links.push(
          ManagedLinkSchema.parse({
            target: record.target,
            label: record.label,
          }),
        );
      } else if (record.kind === "profile-fact") {
        const fact = StoredFactSchema.parse(record.fact);
        if (record.state === "current") managed.ownerFacts.push(fact);
        else if (record.state === "history") managed.factHistory.push(fact);
        else throw new Error("contact-memory fact has invalid state");
      } else if (record.kind === "meeting") {
        managed.meetings.push(StoredMeetingSchema.parse(record.meeting));
      } else {
        throw new Error("contact-memory record has unsupported kind");
      }
    }
    return ManagedStateSchema.parse(managed);
  }
  const payloadStart = stateStart + STATE_PREFIX.length;
  const payloadEnd = region.indexOf(" -->", payloadStart);
  if (payloadEnd === -1) {
    throw new Error("Telegram graph managed state payload is malformed");
  }
  try {
    const decoded = Buffer.from(
      region.slice(payloadStart, payloadEnd),
      "base64url",
    ).toString("utf8");
    return ManagedStateSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("Telegram graph managed state payload is invalid");
  }
}

function readCard(
  file: string,
  cardType: CardState["cardType"],
  numericId: number | null,
  title: string,
): CardState {
  const original = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const body = original === undefined ? "" : parseFrontmatter(original).body;
  return {
    file,
    cardType,
    numericId,
    title,
    original,
    managed: parseManaged(body),
  };
}

function newestEvidenceTimestamp(observation: Observation): string {
  return observation.evidence
    .map((item) => item.timestamp)
    .sort()
    .at(-1)!;
}

function supersessionKey(observation: Observation): string | null {
  if (
    [
      "display_name",
      "username",
      "birthday",
      "city",
      "timezone",
      "education",
      "employer",
    ].includes(observation.predicate)
  ) {
    return `${observation.subjectId}:${observation.predicate}`;
  }
  if (
    ["role", "communication_style", "relationship"].includes(
      observation.predicate,
    )
  ) {
    return `${observation.subjectId}:${observation.predicate}:${observation.contextChatId}`;
  }
  return null;
}

function mergeObservation(managed: ManagedState, incoming: Observation): void {
  const incomingId = observationId(incoming);
  if (
    [...managed.current, ...managed.history, ...managed.candidates].some(
      (item) => observationId(item) === incomingId,
    )
  ) {
    return;
  }
  const candidateOnly = new Set<Observation["predicate"]>([
    "birthday",
    "city",
    "timezone",
    "phone",
    "email",
    "education",
    "employer",
  ]);
  if (
    candidateOnly.has(incoming.predicate) &&
    incoming.confidence !== "EXTRACTED"
  ) {
    managed.candidates.push(incoming);
    return;
  }
  if (candidateOnly.has(incoming.predicate)) {
    managed.candidates = managed.candidates.filter(
      (item) => item.predicate !== incoming.predicate,
    );
  }
  const key = supersessionKey(incoming);
  if (key === null) {
    managed.current.push(incoming);
    return;
  }
  const conflicts = managed.current.filter(
    (item) => supersessionKey(item) === key,
  );
  if (conflicts.length === 0) {
    managed.current.push(incoming);
    return;
  }
  const incomingTimestamp = newestEvidenceTimestamp(incoming);
  const newestCurrent = conflicts.map(newestEvidenceTimestamp).sort().at(-1)!;
  if (incomingTimestamp >= newestCurrent) {
    const conflictIds = new Set(conflicts.map(observationId));
    managed.current = managed.current.filter(
      (item) => !conflictIds.has(observationId(item)),
    );
    managed.history.push(...conflicts, incoming);
    managed.current.push(incoming);
    managed.history = managed.history.filter(
      (item) => observationId(item) !== incomingId,
    );
  } else {
    managed.history.push(incoming);
  }
}

function vaultLink(vault: string, targetFile: string): string {
  return relative(vault, targetFile).split(sep).join("/").replace(/\.md$/u, "");
}

function addLink(managed: ManagedState, target: string, label: string): void {
  const existing = managed.links.find((link) => link.target === target);
  if (existing) existing.label = label;
  else managed.links.push({ target, label });
}

function subjectUserId(subjectId: string): number | null {
  const match = /^telegram:user:(-?[1-9]\d*)$/u.exec(subjectId);
  return match ? Number(match[1]) : null;
}

function displayName(state: CardState): string {
  const latest = state.managed.current.find(
    (item) => item.predicate === "display_name" && item.value,
  );
  return latest?.value ?? state.title;
}

function safeInline(value: string): string {
  return safeHumanInline(value);
}

function renderObservation(observation: Observation): string {
  const target =
    observation.value === undefined
      ? `[[${observation.objectId}]]`
      : safeInline(observation.value);
  const labels: Record<Observation["predicate"], string> = {
    display_name: "Имя",
    username: "Telegram",
    relationship: "Контекст отношений",
    role: "Роль",
    member_of: "Участник",
    works_on: "Проект",
    communication_style: "Как общается",
    commitment: "Обязательство",
    preference: "Предпочтение",
    owner_mention: "Упоминание владельца",
    external_owner_claim: "Со слов другого человека",
    birthday: "Дата рождения",
    city: "Город",
    timezone: "Часовой пояс",
    phone: "Телефон",
    email: "Email",
    education: "Учёба",
    employer: "Работа",
    interest: "Интерес",
    important_date: "Важная дата",
    gift_idea: "Идея подарка",
    interesting_fact: "Факт",
  };
  const marker = serializeObservation(observation, "current");
  return `- ${labels[observation.predicate]}: ${target}\n  ${marker}`;
}

function serializeObservation(
  observation: Observation,
  state: "current" | "history" | "candidate",
): string {
  return serializeInternalRecord({
    v: 1,
    id: observationId(observation),
    kind: "observation",
    state,
    observation,
  });
}

function sortedObservations(items: Observation[]): Observation[] {
  return [...items].sort((left, right) => {
    const predicate = left.predicate.localeCompare(right.predicate);
    return predicate || observationId(left).localeCompare(observationId(right));
  });
}

function observationSection(observation: Observation): string {
  if (["display_name"].includes(observation.predicate)) return "Как обращаться";
  if (["birthday", "city", "timezone"].includes(observation.predicate))
    return "Основные сведения";
  if (["username", "phone", "email"].includes(observation.predicate))
    return "Контакты";
  if (
    [
      "relationship",
      "member_of",
      "owner_mention",
      "external_owner_claim",
    ].includes(observation.predicate)
  )
    return "Наши отношения";
  if (observation.predicate === "education") return "Учёба";
  if (["role", "works_on", "employer"].includes(observation.predicate))
    return "Работа и проекты";
  if (
    ["communication_style", "preference", "interest"].includes(
      observation.predicate,
    )
  )
    return "Интересы и предпочтения";
  if (observation.predicate === "important_date") return "Важные даты";
  if (observation.predicate === "gift_idea") return "Подарки и идеи";
  if (observation.predicate === "commitment") return "Открытые дела";
  return "Интересные факты";
}

function renderManaged(
  managed: ManagedState,
  cardType: CardState["cardType"],
): string {
  const normalized = ManagedStateSchema.parse({
    current: sortedObservations(managed.current),
    history: sortedObservations(managed.history),
    candidates: sortedObservations(managed.candidates),
    links: [...managed.links].sort((left, right) =>
      left.target.localeCompare(right.target),
    ),
    ownerFacts: [...managed.ownerFacts].sort(
      (left, right) =>
        left.field.localeCompare(right.field) ||
        left.id.localeCompare(right.id),
    ),
    factHistory: [...managed.factHistory].sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.id.localeCompare(right.id),
    ),
    meetings: [...managed.meetings].sort(
      (left, right) =>
        right.date.localeCompare(left.date) || right.id.localeCompare(left.id),
    ),
  });
  const lines = [
    START,
    ...normalized.candidates.map((item) =>
      serializeObservation(item, "candidate"),
    ),
  ];
  const grouped = new Map<string, Observation[]>();
  for (const item of normalized.current) {
    const section =
      cardType === "contact" ? observationSection(item) : "Что известно";
    const items = grouped.get(section) ?? [];
    items.push(item);
    grouped.set(section, items);
  }
  const factLabels: Record<ProfileFact["field"], string> = {
    full_name: "Полное имя",
    preferred_name: "Предпочтительное имя",
    nickname: "Прозвище",
    pronunciation: "Произношение",
    formality: "Форма обращения",
    birthday: "Дата рождения",
    city: "Город",
    timezone: "Часовой пояс",
    language: "Язык",
    family_context: "Семейный контекст",
    phone: "Телефон",
    email: "Email",
    telegram_username: "Telegram",
    other_contact: "Другой контакт",
    preferred_channel: "Предпочтительный канал",
    preferred_contact_time: "Когда лучше писать",
    relationship: "Контекст отношений",
    education: "Учёба",
    work: "Работа",
    project: "Проект",
    interest: "Интерес",
    preference: "Предпочтение",
    important_date: "Важная дата",
    gift_given: "Подарено",
    gift_wish: "Пожелание",
    gift_idea: "Идея подарка",
    interesting_fact: "Факт",
    conversation_followup: "Обсудить",
  };
  const factSection = (fact: StoredFact): string => {
    if (
      [
        "full_name",
        "preferred_name",
        "nickname",
        "pronunciation",
        "formality",
      ].includes(fact.field)
    )
      return "Как обращаться";
    if (
      ["birthday", "city", "timezone", "language", "family_context"].includes(
        fact.field,
      )
    )
      return "Основные сведения";
    if (
      [
        "phone",
        "email",
        "telegram_username",
        "other_contact",
        "preferred_channel",
        "preferred_contact_time",
      ].includes(fact.field)
    )
      return "Контакты";
    if (fact.field === "relationship") return "Наши отношения";
    if (fact.field === "education") return "Учёба";
    if (["work", "project"].includes(fact.field)) return "Работа и проекты";
    if (["interest", "preference"].includes(fact.field))
      return "Интересы и предпочтения";
    if (fact.field === "important_date") return "Важные даты";
    if (["gift_given", "gift_wish", "gift_idea"].includes(fact.field))
      return "Подарки и идеи";
    if (fact.field === "conversation_followup") return "К следующему разговору";
    return "Интересные факты";
  };
  const ownerFacts = new Map<string, StoredFact[]>();
  for (const fact of normalized.ownerFacts) {
    const section = factSection(fact);
    const items = ownerFacts.get(section) ?? [];
    items.push(fact);
    ownerFacts.set(section, items);
  }
  const order = [
    "Как обращаться",
    "Основные сведения",
    "Контакты",
    "Наши отношения",
    "Учёба",
    "Работа и проекты",
    "Интересы и предпочтения",
    "Важные даты",
    "Подарки и идеи",
    "Интересные факты",
    "К следующему разговору",
    "Открытые дела",
    "Что известно",
  ];
  for (const section of order) {
    const items = grouped.get(section) ?? [];
    const facts = ownerFacts.get(section) ?? [];
    if (!items.length && !facts.length) continue;
    lines.push("", `## ${section}`, "", ...items.map(renderObservation));
    for (const fact of facts) {
      lines.push(
        `- ${fact.label ?? factLabels[fact.field]}: ${safeInline(fact.value)}`,
      );
      lines.push(
        `  ${serializeInternalRecord({ v: 1, id: fact.id, kind: "profile-fact", state: "current", fact })}`,
      );
    }
  }
  if (normalized.links.length > 0) {
    lines.push("", "## Связанные люди, группы и проекты", "");
    for (const link of normalized.links) {
      lines.push(`- [[${link.target}|${safeInline(link.label)}]]`);
      lines.push(
        `  ${serializeInternalRecord({
          v: 1,
          id: createHash("sha256")
            .update(link.target)
            .digest("hex")
            .slice(0, 20),
          kind: "link",
          target: link.target,
          label: link.label,
        })}`,
      );
    }
  }
  if (normalized.meetings.length > 0) {
    lines.push("", "## История встреч", "");
    for (const meeting of normalized.meetings) {
      lines.push(
        `### ${meeting.date} — ${safeInline(meeting.title)}`,
        "",
        safeInline(meeting.summary),
      );
      const updates = meeting.updates ?? [];
      const followups = meeting.followups ?? [];
      if (updates.length || followups.length) {
        lines.push("", "**После встречи обновилось:**", "");
        for (const update of updates)
          lines.push(`- ${safeInline(update.value)}`);
        for (const followup of followups)
          lines.push(`- ${safeInline(followup)}`);
      }
      lines.push(
        "",
        serializeInternalRecord({
          v: 1,
          id: meeting.id,
          kind: "meeting",
          meeting,
        }),
        "",
      );
    }
  }
  if (normalized.history.length > 0 || normalized.factHistory.length > 0) {
    lines.push("", "## Архив изменений", "");
    for (const item of normalized.history) {
      const visible = renderObservation(item).split("\n")[0];
      lines.push(`${visible}\n  ${serializeObservation(item, "history")}`);
    }
    for (const fact of normalized.factHistory) {
      lines.push(
        `- ${fact.label ?? factLabels[fact.field]}: ${safeInline(fact.value)}`,
      );
      lines.push(
        `  ${serializeInternalRecord({ v: 1, id: fact.id, kind: "profile-fact", state: "history", fact })}`,
      );
    }
  }
  lines.push(END);
  return lines.join("\n");
}

const SINGLE_VALUE_FIELDS = new Set<ProfileFact["field"]>([
  "full_name",
  "preferred_name",
  "pronunciation",
  "formality",
  "birthday",
  "city",
  "timezone",
  "relationship",
  "education",
  "work",
  "preferred_channel",
  "preferred_contact_time",
]);

const OWNER_TO_OBSERVATION_FIELD: Partial<
  Record<ProfileFact["field"], Observation["predicate"]>
> = {
  full_name: "display_name",
  birthday: "birthday",
  city: "city",
  timezone: "timezone",
  relationship: "relationship",
  education: "education",
  work: "employer",
};

export interface ApplyOwnerContactUpdateInput {
  vault: string;
  userId: number;
  displayName: string;
  facts?: ProfileFact[];
  meeting?: Meeting;
  now?: string;
  transactionLocked?: boolean;
}

export function applyOwnerContactUpdate(input: ApplyOwnerContactUpdateInput): {
  file: string;
  factIds: string[];
  meetingId: string | null;
  changed: boolean;
} {
  if (!input.transactionLocked) {
    return withContactMemoryLock(input.vault, () =>
      applyOwnerContactUpdate({ ...input, transactionLocked: true }),
    );
  }
  const file = contactCardPath(input.vault, input.userId);
  mkdirSync(dirname(file), { recursive: true });
  const release = acquireLock(file);
  try {
    const card = readCard(file, "contact", input.userId, input.displayName);
    const now = input.now ?? new Date().toISOString();
    const meeting = input.meeting ? MeetingSchema.parse(input.meeting) : null;
    const meetingId = meeting
      ? stableRecordId("meeting", {
          userId: input.userId,
          date: meeting.date,
          title: meeting.title,
          summary: meeting.summary,
        })
      : null;
    const factIds: string[] = [];
    for (const raw of input.facts ?? []) {
      const fact = ProfileFactSchema.parse(raw);
      const id = stableRecordId("fact", {
        userId: input.userId,
        field: fact.field,
        value: fact.value,
        label: fact.label ?? null,
      });
      factIds.push(id);
      const existingFact = card.managed.ownerFacts.find(
        (item) => item.id === id,
      );
      if (existingFact) {
        if (
          meetingId &&
          (existingFact.originMeetingId !== undefined ||
            existingFact.originMeetingIds !== undefined)
        ) {
          existingFact.originMeetingIds = [
            ...new Set([
              ...(existingFact.originMeetingIds ?? []),
              ...(existingFact.originMeetingId
                ? [existingFact.originMeetingId]
                : []),
              meetingId,
            ]),
          ];
          delete existingFact.originMeetingId;
          existingFact.updatedAt = now;
        }
        continue;
      }
      if (SINGLE_VALUE_FIELDS.has(fact.field)) {
        const superseded = card.managed.ownerFacts.filter(
          (item) => item.field === fact.field && item.value !== fact.value,
        );
        card.managed.ownerFacts = card.managed.ownerFacts.filter(
          (item) => !superseded.some((old) => old.id === item.id),
        );
        card.managed.factHistory.push(
          ...superseded.map((item) => ({ ...item, updatedAt: now })),
        );
        const predicate = OWNER_TO_OBSERVATION_FIELD[fact.field];
        if (predicate) {
          const background = card.managed.current.filter(
            (item) => item.predicate === predicate,
          );
          card.managed.current = card.managed.current.filter(
            (item) => item.predicate !== predicate,
          );
          card.managed.history.push(...background);
        }
      }
      card.managed.ownerFacts.push({
        ...fact,
        id,
        createdAt: now,
        updatedAt: now,
        ...(meetingId ? { originMeetingIds: [meetingId] } : {}),
      });
    }
    if (meeting && meetingId) {
      if (!card.managed.meetings.some((item) => item.id === meetingId)) {
        card.managed.meetings.push({
          ...meeting,
          id: meetingId,
          createdAt: now,
        });
      }
    }
    const rendered = renderCard(card);
    const changed = rendered !== card.original;
    if (changed) atomicWrite(file, rendered);
    return { file, factIds, meetingId, changed };
  } finally {
    release();
  }
}

export type OwnerRecordSelector =
  | { kind: "fact"; field: ProfileFact["field"]; value: string }
  | { kind: "meeting"; date: string; title: string; summary?: string };

export function deleteOwnerContactRecord(input: {
  vault: string;
  userId: number;
  selector: OwnerRecordSelector;
  transactionLocked?: boolean;
}): {
  deleted: boolean;
  ambiguous?: boolean;
  file: string;
  deletedMeetingId?: string;
} {
  if (!input.transactionLocked) {
    return withContactMemoryLock(input.vault, () =>
      deleteOwnerContactRecord({ ...input, transactionLocked: true }),
    );
  }
  const file = contactCardPath(input.vault, input.userId);
  if (!existsSync(file)) return { deleted: false, file };
  const release = acquireLock(file);
  try {
    const card = readCard(
      file,
      "contact",
      input.userId,
      `Telegram user ${input.userId}`,
    );
    const beforeFacts = card.managed.ownerFacts.length;
    const beforeHistory = card.managed.factHistory.length;
    const beforeMeetings = card.managed.meetings.length;
    let deletedMeetingId: string | undefined;
    if (input.selector.kind === "fact") {
      const selector = input.selector;
      card.managed.ownerFacts = card.managed.ownerFacts.filter(
        (fact) =>
          fact.field !== selector.field || fact.value !== selector.value,
      );
      card.managed.factHistory = card.managed.factHistory.filter(
        (fact) =>
          fact.field !== selector.field || fact.value !== selector.value,
      );
    } else {
      const selector = input.selector;
      const matches = card.managed.meetings.filter(
        (item) =>
          item.date === selector.date &&
          item.title === selector.title &&
          (selector.summary === undefined || item.summary === selector.summary),
      );
      if (matches.length > 1) return { deleted: false, ambiguous: true, file };
      deletedMeetingId = matches[0]?.id;
      card.managed.meetings = card.managed.meetings.filter(
        (meeting) => meeting.id !== deletedMeetingId,
      );
      if (deletedMeetingId) {
        const removedFields = new Set<ProfileFact["field"]>();
        const removeOrigin = (fact: StoredFact): StoredFact | null => {
          const origins = new Set([
            ...(fact.originMeetingIds ?? []),
            ...(fact.originMeetingId ? [fact.originMeetingId] : []),
          ]);
          if (!origins.delete(deletedMeetingId!)) return fact;
          if (origins.size === 0) {
            removedFields.add(fact.field);
            return null;
          }
          const updated = { ...fact, originMeetingIds: [...origins] };
          delete updated.originMeetingId;
          return StoredFactSchema.parse(updated);
        };
        card.managed.ownerFacts = card.managed.ownerFacts
          .map(removeOrigin)
          .filter((fact): fact is StoredFact => fact !== null);
        card.managed.factHistory = card.managed.factHistory
          .map(removeOrigin)
          .filter((fact): fact is StoredFact => fact !== null);
        for (const field of removedFields) {
          if (card.managed.ownerFacts.some((fact) => fact.field === field))
            continue;
          const previous = card.managed.factHistory
            .filter((fact) => fact.field === field)
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )
            .at(0);
          if (previous) {
            card.managed.factHistory = card.managed.factHistory.filter(
              (fact) => fact.id !== previous.id,
            );
            card.managed.ownerFacts.push(previous);
            continue;
          }
          const predicate = OWNER_TO_OBSERVATION_FIELD[field];
          if (
            !predicate ||
            card.managed.current.some((item) => item.predicate === predicate)
          )
            continue;
          const previousObservation = card.managed.history
            .filter((item) => item.predicate === predicate)
            .sort((left, right) =>
              newestEvidenceTimestamp(right).localeCompare(
                newestEvidenceTimestamp(left),
              ),
            )
            .at(0);
          if (previousObservation) {
            const previousId = observationId(previousObservation);
            card.managed.history = card.managed.history.filter(
              (item) => observationId(item) !== previousId,
            );
            card.managed.current.push(previousObservation);
          }
        }
      }
    }
    const deleted =
      beforeFacts !== card.managed.ownerFacts.length ||
      beforeHistory !== card.managed.factHistory.length ||
      beforeMeetings !== card.managed.meetings.length;
    if (deleted) atomicWrite(file, renderCard(card));
    return { deleted, file, ...(deletedMeetingId ? { deletedMeetingId } : {}) };
  } finally {
    release();
  }
}

function replaceManaged(body: string, rendered: string): string {
  const start = body.indexOf(START);
  if (start === -1) {
    return `${body.replace(/\s*$/u, "")}\n\n${rendered}\n`.replace(/^\n+/u, "");
  }
  const end = body.indexOf(END, start + START.length);
  if (end === -1) {
    throw new Error("Telegram graph managed section is missing its end marker");
  }
  return `${body.slice(0, start)}${rendered}${body.slice(end + END.length)}`;
}

function quotedTelegramIds(frontmatter: string): string {
  return frontmatter.replace(
    /^(telegram_(?:user|chat)_id): (-?\d+)$/gmu,
    '$1: "$2"',
  );
}

function withoutFrontmatterKeys(lines: string[], keys: Set<string>): string[] {
  const output: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const indented = /^[ \t]/u.test(line);
    if (dropping && indented) continue;
    dropping = false;
    const match = /^([^\s:#][^:]*):/u.exec(line);
    if (match && keys.has(match[1].trim())) {
      dropping = true;
      continue;
    }
    output.push(line);
  }
  return output;
}

function renderCard(card: CardState): string {
  const parsed = parseFrontmatter(card.original ?? "");
  const safeTitle = safeInline(displayName(card));
  const defaults: FmFields =
    card.cardType === "contact"
      ? {
          type: "contact",
          description: `Telegram contact ${card.numericId}`,
          tags: ["telegram", "contact-analysis"],
          status: "active",
          telegram_user_id: String(card.numericId),
          full_name: safeTitle,
        }
      : card.cardType === "note"
        ? {
            type: "note",
            description: `Telegram chat ${safeTitle}`,
            tags: ["telegram", "contact-analysis"],
            status: "active",
            telegram_chat_id: String(card.numericId),
          }
        : {
            type: "project",
            description: `Telegram-derived project ${safeTitle}`,
            tags: ["telegram", "contact-analysis"],
            status: "active",
          };
  const fields: FmFields = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (parsed.fields?.[key] === undefined) fields[key] = value;
  }
  if (card.cardType === "contact") {
    const currentValue = (
      predicate: Observation["predicate"],
    ): string | undefined =>
      card.managed.current.find(
        (item) => item.predicate === predicate && item.value !== undefined,
      )?.value;
    const ownerValue = (field: ProfileFact["field"]): string | undefined =>
      card.managed.ownerFacts.find((item) => item.field === field)?.value;
    fields.full_name = ownerValue("full_name") ?? safeTitle;
    const birthday = ownerValue("birthday") ?? currentValue("birthday");
    const city = ownerValue("city") ?? currentValue("city");
    const timezone = ownerValue("timezone") ?? currentValue("timezone");
    if (birthday) fields.birthday = birthday;
    if (city) fields.city = city;
    if (timezone) fields.timezone = timezone;
  }
  const removable = new Set(["birthday", "city", "timezone"]);
  for (const key of Object.keys(fields)) removable.delete(key);
  const frontmatter = quotedTelegramIds(
    writeFrontmatter(fields, withoutFrontmatterKeys(parsed.lines, removable)),
  );
  const initialBody =
    card.original === undefined
      ? `# ${safeTitle}\n`
      : parsed.body.replace(/^# .+$/mu, `# ${safeTitle}`);
  const body = replaceManaged(
    initialBody,
    renderManaged(card.managed, card.cardType),
  );
  return `---\n${frontmatter}\n---\n${body.replace(/\s*$/u, "")}\n`;
}

export function reduceBatchFiles(input: ReduceBatchInput): string[] {
  requireSafeNonZeroInteger(input.ownerUserId, "owner user ID");
  const batch = AnalysisPageSchema.parse(input.batch);
  if (batch.chatId !== input.dialog.id) {
    throw new Error("analysis batch chat does not match reducer dialog");
  }
  const collective = ["group", "channel"].includes(input.dialog.kind);
  const files = new Set<string>();
  if (collective) files.add(chatCardPath(input.vault, input.dialog));
  else files.add(contactCardPath(input.vault, input.dialog.id));
  for (const observation of batch.observations) {
    const userId = subjectUserId(observation.subjectId);
    if (userId !== null) files.add(contactCardPath(input.vault, userId));
    else if (observation.subjectId === `telegram:chat:${input.dialog.id}`) {
      files.add(chatCardPath(input.vault, input.dialog));
    } else {
      throw new Error(
        `unsupported observation subject ${observation.subjectId}`,
      );
    }
    if (observation.predicate === "works_on" && observation.value) {
      files.add(projectCardPath(input.vault, observation.value));
    }
  }

  return [...files].sort();
}

export async function reduceBatch(
  input: ReduceBatchInput,
): Promise<ReduceResult> {
  const batch = AnalysisPageSchema.parse(input.batch);
  const orderedFiles = reduceBatchFiles(input);
  const collective = ["group", "channel"].includes(input.dialog.kind);
  if (!input.transactionLocked) {
    return runContactMemoryTransaction(input.vault, orderedFiles, () =>
      reduceBatch({ ...input, transactionLocked: true }),
    );
  }
  for (const file of orderedFiles)
    mkdirSync(dirname(file), { recursive: true });
  const releases = orderedFiles.map((file) => acquireLock(file));
  try {
    const cards = new Map<string, CardState>();
    for (const file of orderedFiles) {
      const isContact = file.includes(`${sep}cards${sep}contacts${sep}`);
      const isProject = file.includes(`${sep}cards${sep}projects${sep}`);
      const match = /telegram-user-(-?\d+)\.md$/u.exec(file);
      const projectObservation = batch.observations.find(
        (observation) =>
          observation.predicate === "works_on" &&
          observation.value !== undefined &&
          projectCardPath(input.vault, observation.value) === file,
      );
      cards.set(
        file,
        readCard(
          file,
          isContact ? "contact" : isProject ? "project" : "note",
          isContact ? Number(match?.[1]) : isProject ? null : input.dialog.id,
          isContact
            ? `Telegram user ${match?.[1]}`
            : isProject
              ? (projectObservation?.value ?? "Telegram project")
              : input.dialog.title,
        ),
      );
    }

    for (const observation of batch.observations) {
      const userId = subjectUserId(observation.subjectId);
      const subjectFile =
        userId === null
          ? chatCardPath(input.vault, input.dialog)
          : contactCardPath(input.vault, userId);
      const subjectCard = cards.get(subjectFile);
      if (!subjectCard)
        throw new Error("reducer did not lock the subject card");
      mergeObservation(subjectCard.managed, observation);
    }

    if (collective) {
      const groupFile = chatCardPath(input.vault, input.dialog);
      const groupCard = cards.get(groupFile)!;
      const participantIds = new Set(
        batch.observations
          .map((observation) => subjectUserId(observation.subjectId))
          .filter((id): id is number => id !== null),
      );
      for (const userId of participantIds) {
        const personFile = contactCardPath(input.vault, userId);
        const personCard = cards.get(personFile)!;
        addLink(
          personCard.managed,
          vaultLink(input.vault, groupFile),
          input.dialog.title,
        );
        addLink(
          groupCard.managed,
          vaultLink(input.vault, personFile),
          displayName(personCard),
        );
      }
    }

    for (const observation of batch.observations) {
      if (observation.predicate !== "works_on" || !observation.value) continue;
      const userId = subjectUserId(observation.subjectId);
      if (userId === null) continue;
      const personFile = contactCardPath(input.vault, userId);
      const projectFile = projectCardPath(input.vault, observation.value);
      const personCard = cards.get(personFile)!;
      const projectCard = cards.get(projectFile)!;
      addLink(
        personCard.managed,
        vaultLink(input.vault, projectFile),
        observation.value,
      );
      addLink(
        projectCard.managed,
        vaultLink(input.vault, personFile),
        displayName(personCard),
      );
    }

    const writtenFiles: string[] = [];
    for (const file of orderedFiles) {
      const card = cards.get(file)!;
      const rendered = renderCard(card);
      if (rendered !== card.original) {
        atomicWrite(file, rendered);
        writtenFiles.push(file);
      }
    }
    return {
      writtenFiles,
      observationIds: batch.observations.map(observationId),
    };
  } finally {
    for (const release of releases.reverse()) release();
  }
}
