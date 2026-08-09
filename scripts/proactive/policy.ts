import type { AlertSeverity, ReportPeriod } from "./contracts.ts";

export const PROACTIVE_TIME_ZONE = "Europe/Moscow";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface ZonedDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function zonedParts(epochMs: number, timeZone: string): ZonedDate {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: fields.hour === "24" ? 0 : Number(fields.hour),
    minute: Number(fields.minute),
  };
}

function zonedToUtcMs(
  date: Pick<ZonedDate, "year" | "month" | "day">,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  for (let pass = 0; pass < 4; pass += 1) {
    const seen = zonedParts(guess, timeZone);
    const difference =
      Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) -
      Date.UTC(date.year, date.month - 1, date.day, hour, minute);
    if (difference === 0) break;
    guess -= difference;
  }
  return guess;
}

function shiftDate(
  date: Pick<ZonedDate, "year" | "month" | "day">,
  days: number,
): Pick<ZonedDate, "year" | "month" | "day"> {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day, 12) + days * DAY_MS,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function isoDate(date: Pick<ZonedDate, "year" | "month" | "day">): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function mondayOffset(date: Pick<ZonedDate, "year" | "month" | "day">): number {
  return (
    (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) %
    7
  );
}

function isoWeekKey(date: Pick<ZonedDate, "year" | "month" | "day">): string {
  const noon = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  const day = noon.getUTCDay() || 7;
  noon.setUTCDate(noon.getUTCDate() + 4 - day);
  const isoYear = noon.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1, 12));
  const week = Math.ceil(
    ((noon.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7,
  );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function reviewPeriodsAt(
  nowMs: number,
  timeZone = PROACTIVE_TIME_ZONE,
): { readonly daily: ReportPeriod; readonly weekly: ReportPeriod } {
  const today = zonedParts(nowMs, timeZone);
  const date = {
    year: today.year,
    month: today.month,
    day: today.day,
  };
  const monday = shiftDate(date, -mondayOffset(date));
  const dailyDue = zonedToUtcMs(date, 8, 0, timeZone);
  const weeklyDue = zonedToUtcMs(monday, 8, 0, timeZone);
  return {
    daily: {
      kind: "daily",
      periodKey: isoDate(date),
      prepareAt: zonedToUtcMs(date, 5, 0, timeZone),
      freezeAt: zonedToUtcMs(date, 7, 55, timeZone),
      dueAt: dailyDue,
      expiresAt: dailyDue + 12 * HOUR_MS,
    },
    weekly: {
      kind: "weekly",
      periodKey: isoWeekKey(monday),
      prepareAt: zonedToUtcMs(monday, 5, 15, timeZone),
      freezeAt: zonedToUtcMs(monday, 7, 55, timeZone),
      dueAt: weeklyDue,
      expiresAt: weeklyDue + 72 * HOUR_MS,
    },
  };
}

export function isPreparationDue(period: ReportPeriod, nowMs: number): boolean {
  return nowMs >= period.prepareAt && nowMs < period.freezeAt;
}

export type DeliveryWindow = "early" | "due" | "late" | "expired";

export function deliveryWindow(
  period: ReportPeriod,
  nowMs: number,
): DeliveryWindow {
  if (nowMs < period.dueAt) return "early";
  if (nowMs === period.dueAt) return "due";
  if (nowMs <= period.expiresAt) return "late";
  return "expired";
}

export function retryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.min(30, Math.trunc(attempt)));
  return Math.min(30 * MINUTE_MS, 2 ** (safeAttempt - 1) * MINUTE_MS);
}

export type AlertAdmission =
  | { readonly action: "send" }
  | { readonly action: "defer" | "cooldown"; readonly until: number };

export function alertAdmission(
  severity: AlertSeverity,
  nowMs: number,
  lastDeliveredAt: number | null,
  timeZone = PROACTIVE_TIME_ZONE,
): AlertAdmission {
  const cooldown = severity === "critical" ? HOUR_MS : 6 * HOUR_MS;
  if (lastDeliveredAt !== null && nowMs < lastDeliveredAt + cooldown) {
    return { action: "cooldown", until: lastDeliveredAt + cooldown };
  }
  const local = zonedParts(nowMs, timeZone);
  const quiet = local.hour >= 22 || local.hour < 8;
  if (severity === "high" && quiet) {
    const today = {
      year: local.year,
      month: local.month,
      day: local.day,
    };
    const wakeDate = local.hour >= 22 ? shiftDate(today, 1) : today;
    return {
      action: "defer",
      until: zonedToUtcMs(wakeDate, 8, 0, timeZone),
    };
  }
  return { action: "send" };
}
