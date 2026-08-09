import { chmod, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import { loadRegistry, type RelationshipPaths } from "./store.ts";
import { classifyCommitment, nextBirthdayOccurrence } from "./types.ts";
import type { GoogleRunner } from "./google.ts";

export type ReportPeriod = "daily" | "weekly";
export interface RelationshipReport {
  schema: "iva-relationship-report/v1";
  period: ReportPeriod;
  preparedAt: string;
  text: string;
  deliveredAt: string | null;
  deliveryState?: "pending" | "sending" | "ambiguous" | "delivered";
  deliveryAttemptId?: string | null;
  deliveryStartedAt?: string | null;
}

const DELIVERY_LEASE_MS = 15 * 60 * 1000;

function deliveryLeaseIsFresh(
  report: RelationshipReport,
  now: string,
): boolean {
  const startedAt = report.deliveryStartedAt ?? report.preparedAt;
  const age = Date.parse(now) - Date.parse(startedAt);
  return Number.isFinite(age) && age >= 0 && age <= DELIVERY_LEASE_MS;
}

export interface CalendarMeeting {
  id: string;
  summary: string;
  start: string;
}

function safe(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#|])/gu, "\\$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function zonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const local = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const next = target - (represented - candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

export function calendarReportWindow({
  period,
  now,
  timeZone,
}: {
  period: ReportPeriod;
  now: string;
  timeZone: string;
}): { timeMin: string; timeMax: string } {
  const current = new Date(now);
  const local = zonedParts(current, timeZone);
  const start = zonedMidnight(local.year, local.month, local.day, timeZone);
  const nextDate = new Date(
    Date.UTC(
      local.year,
      local.month - 1,
      local.day + (period === "daily" ? 1 : 7),
    ),
  );
  const end = zonedMidnight(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    timeZone,
  );
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

export async function collectCalendarMeetings({
  period,
  now,
  timeZone = process.env.ASSISTANT_TIMEZONE ?? "Europe/Moscow",
  run,
}: {
  period: ReportPeriod;
  now: string;
  timeZone?: string;
  run: GoogleRunner;
}): Promise<CalendarMeeting[]> {
  const { timeMin, timeMax } = calendarReportWindow({
    period,
    now,
    timeZone,
  });
  const result = await run([
    "calendar",
    "events",
    "list",
    "--params",
    JSON.stringify({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
    }),
  ]);
  if (result.exitCode !== 0) throw new Error("Calendar read failed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Calendar returned invalid JSON");
  }
  const items =
    typeof parsed === "object" && parsed !== null && "items" in parsed
      ? (parsed as { items?: unknown }).items
      : undefined;
  if (items === undefined) return [];
  if (!Array.isArray(items)) throw new Error("Calendar items are invalid");
  return items.slice(0, 100).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const event = item as {
      id?: unknown;
      summary?: unknown;
      start?: { dateTime?: unknown; date?: unknown };
    };
    const id = typeof event.id === "string" ? event.id : "";
    const summary = typeof event.summary === "string" ? event.summary : "";
    const eventStart =
      typeof event.start?.dateTime === "string"
        ? event.start.dateTime
        : typeof event.start?.date === "string"
          ? event.start.date
          : "";
    return id && summary && eventStart
      ? [{ id, summary: safe(summary), start: eventStart }]
      : [];
  });
}

export function resolveOwnerReportRoute({
  multiUser,
  role,
  assignedUserId,
  routedOwnerId,
  allowedUserIds,
  digestChatId,
}: {
  multiUser: boolean;
  role: string | undefined;
  assignedUserId: string | undefined;
  routedOwnerId: string | undefined;
  allowedUserIds: string | undefined;
  digestChatId: string | undefined;
}): { ownerUserId: string; destination: string; role: "owner" } {
  const isPrivateId = (value: string | undefined): value is string =>
    value !== undefined && /^[1-9]\d*$/u.test(value);
  let ownerUserId: string;
  if (multiUser) {
    if (role !== "owner" || !isPrivateId(assignedUserId))
      throw new Error("relationship reports require exactly one owner");
    ownerUserId = assignedUserId;
  } else if (isPrivateId(routedOwnerId)) {
    ownerUserId = routedOwnerId;
  } else {
    const allowed = String(allowedUserIds ?? "")
      .split(/[,\s]+/u)
      .filter(isPrivateId);
    if (allowed.length !== 1)
      throw new Error("relationship reports require exactly one owner");
    ownerUserId = allowed[0];
  }
  const destination = digestChatId?.trim() || ownerUserId;
  if (destination !== ownerUserId)
    throw new Error("relationship reports require the owner private chat");
  return { ownerUserId, destination, role: "owner" };
}

function file(paths: RelationshipPaths, period: ReportPeriod): string {
  return join(paths.reportsDir, `${period}.json`);
}

export async function prepareRelationshipReport({
  paths,
  period,
  now = new Date().toISOString(),
  calendarMeetings = [],
}: {
  paths: RelationshipPaths;
  period: ReportPeriod;
  now?: string;
  calendarMeetings?: readonly CalendarMeeting[];
}): Promise<RelationshipReport> {
  const registry = await loadRegistry(paths);
  const open = registry.commitments.filter(
    (item) => !["completed", "dismissed"].includes(item.status),
  );
  const row = (item: (typeof open)[number]) => {
    const contact = item.contactIds[0]
      ? registry.contacts[item.contactIds[0]]
      : undefined;
    const state = classifyCommitment(
      item,
      now,
      contact?.lastMeaningfulContactAt ?? null,
    );
    const flags = [
      state.overdue && "overdue",
      state.forgotten && "forgotten",
      item.status,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${item.id}: ${safe(item.text)} (${flags}; evidence: ${item.evidence.map((entry) => safe(entry.sourceId)).join(", ")})`;
  };
  const overdue = open.filter(
    (item) =>
      classifyCommitment(
        item,
        now,
        item.contactIds[0]
          ? (registry.contacts[item.contactIds[0]]?.lastMeaningfulContactAt ??
              null)
          : null,
      ).overdue,
  );
  const forgotten = open.filter(
    (item) =>
      classifyCommitment(
        item,
        now,
        item.contactIds[0]
          ? (registry.contacts[item.contactIds[0]]?.lastMeaningfulContactAt ??
              null)
          : null,
      ).forgotten,
  );
  const horizon = Date.parse(now) + 30 * 24 * 60 * 60 * 1000;
  const birthdays = Object.entries(registry.contacts)
    .flatMap(([id, contact]) => {
      if (!contact.birthday) return [];
      const occurrence = nextBirthdayOccurrence(contact.birthday.value, now);
      return Date.parse(`${occurrence}T00:00:00Z`) <= horizon
        ? [
            `- ${safe(id)}: ${occurrence} (evidence: ${safe(contact.birthday.evidence.sourceId)})`,
          ]
        : [];
    })
    .sort();
  const meetingRows = calendarMeetings
    .slice(0, 100)
    .map(
      (event) =>
        `- ${safe(event.start)}: ${safe(event.summary)} (calendar:event:${safe(event.id)})`,
    );
  const since = Date.parse(now) - 7 * 24 * 60 * 60 * 1000;
  const activity = Object.entries(registry.contacts)
    .filter(([, contact]) =>
      contact.lastMeaningfulContactAt
        ? Date.parse(contact.lastMeaningfulContactAt) >= since
        : false,
    )
    .map(
      ([id, contact]) =>
        `- ${safe(id)}: meaningful contact ${contact.lastMeaningfulContactAt} (evidence: ${safe(contact.meaningfulContactEvidence?.sourceId ?? "unknown")})`,
    );
  const newPending = open.filter(
    (item) =>
      item.status === "pending_suggestion" &&
      Date.parse(item.firstSeenAt) >= since,
  );
  const section = (title: string, rows: readonly string[]) => [
    `## ${title}`,
    "",
    ...(rows.length ? rows : ["- None."]),
    "",
  ];
  const text =
    period === "daily"
      ? [
          "# Relationship daily review",
          "",
          ...section("Upcoming birthdays (30 days)", birthdays),
          ...section("Today's meetings", meetingRows),
          ...section("Overdue promises", overdue.map(row)),
          ...section("Forgotten follow-ups", forgotten.map(row)),
        ].join("\n")
      : [
          "# Relationship weekly review",
          "",
          ...section("Relationship activity", activity),
          ...section("New pending commitments", newPending.map(row)),
          ...section("Unresolved promises", open.map(row)),
          ...section("Next-week meetings", meetingRows),
          ...section("Upcoming birthdays (30 days)", birthdays),
        ].join("\n");
  const boundedText =
    text.length <= 24_000
      ? text
      : `${text.slice(0, 23_960)}\n\n[Report truncated safely]`;
  const report: RelationshipReport = {
    schema: "iva-relationship-report/v1",
    period,
    preparedAt: now,
    text: boundedText,
    deliveredAt: null,
    deliveryState: "pending",
    deliveryAttemptId: null,
    deliveryStartedAt: null,
  };
  await mkdir(paths.reportsDir, { recursive: true, mode: 0o700 });
  await chmod(paths.reportsDir, 0o700);
  const reportFile = file(paths, period);
  const lockFile = `${reportFile}.lock`;
  const token = await acquireLock(lockFile);
  try {
    const current = await loadJsonStrict<RelationshipReport | null>(
      reportFile,
      null,
    );
    if (
      current?.deliveryState === "sending" &&
      deliveryLeaseIsFresh(current, now)
    )
      throw new Error("relationship report delivery is in progress");
    await saveJsonAtomic(reportFile, report);
    await chmod(reportFile, 0o600);
  } finally {
    releaseLock(lockFile, token);
  }
  return report;
}

export async function deliverRelationshipReport({
  paths,
  period,
  ownerUserId,
  destination,
  role,
  now = new Date().toISOString(),
  send,
}: {
  paths: RelationshipPaths;
  period: ReportPeriod;
  ownerUserId: string | undefined;
  destination: string | undefined;
  role: string | undefined;
  now?: string;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<{ delivered: boolean }> {
  if (role !== "owner" || !ownerUserId || destination !== ownerUserId)
    throw new Error("relationship reports require the owner private chat");
  await mkdir(paths.reportsDir, { recursive: true, mode: 0o700 });
  const reportFile = file(paths, period);
  const lockFile = `${reportFile}.lock`;
  const attemptId = randomUUID();
  const token = await acquireLock(lockFile);
  let report: RelationshipReport;
  try {
    const loaded = await loadJsonStrict<RelationshipReport | null>(
      reportFile,
      null,
    );
    if (
      !loaded ||
      loaded.schema !== "iva-relationship-report/v1" ||
      loaded.period !== period
    )
      throw new Error("fresh prepared relationship report is required");
    if (
      loaded.deliveredAt !== null ||
      loaded.deliveryState === "delivered" ||
      loaded.deliveryState === "ambiguous"
    )
      return { delivered: false };
    if (loaded.deliveryState === "sending") {
      if (deliveryLeaseIsFresh(loaded, now)) return { delivered: false };
      await saveJsonAtomic(reportFile, {
        ...loaded,
        deliveryState: "ambiguous",
        deliveryAttemptId: null,
        deliveryStartedAt: null,
      });
      await chmod(reportFile, 0o600);
      return { delivered: false };
    }
    const age = Date.parse(now) - Date.parse(loaded.preparedAt);
    if (age < 0 || age > 2 * 60 * 60 * 1000)
      throw new Error("prepared relationship report is stale");
    report = {
      ...loaded,
      deliveryState: "sending",
      deliveryAttemptId: attemptId,
      deliveryStartedAt: now,
    };
    await saveJsonAtomic(reportFile, report);
    await chmod(reportFile, 0o600);
  } finally {
    releaseLock(lockFile, token);
  }
  try {
    await send(destination, report.text);
  } catch (error) {
    const rollbackToken = await acquireLock(lockFile);
    try {
      const current = await loadJsonStrict<RelationshipReport>(
        reportFile,
        report,
      );
      if (current.deliveryAttemptId === attemptId) {
        await saveJsonAtomic(reportFile, {
          ...current,
          deliveryState: "pending",
          deliveryAttemptId: null,
          deliveryStartedAt: null,
        });
      }
    } finally {
      releaseLock(lockFile, rollbackToken);
    }
    throw error;
  }
  const receiptToken = await acquireLock(lockFile);
  try {
    const current = await loadJsonStrict<RelationshipReport>(
      reportFile,
      report,
    );
    if (current.deliveryAttemptId === attemptId) {
      await saveJsonAtomic(reportFile, {
        ...current,
        deliveredAt: now,
        deliveryState: "delivered",
        deliveryAttemptId: null,
        deliveryStartedAt: null,
      });
      await chmod(reportFile, 0o600);
    }
  } finally {
    releaseLock(lockFile, receiptToken);
  }
  return { delivered: true };
}
