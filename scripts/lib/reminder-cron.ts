import { validateTimeZone } from "./timezone.ts";

export type ParsedCronExpression = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  dayWildcard: boolean;
  weekdayWildcard: boolean;
};

type Field = {
  name: string;
  min: number;
  max: number;
  normalize?: (value: number) => number;
};

const FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 7, normalize: (value) => value % 7 },
];

function integer(value: string, field: Field): number {
  if (!/^\d+$/u.test(value)) throw new Error(`invalid ${field.name} value`);
  const parsed = Number(value);
  if (parsed < field.min || parsed > field.max) {
    throw new Error(`${field.name} must be ${field.min}-${field.max}`);
  }
  return parsed;
}

function parseField(source: string, field: Field): ReadonlySet<number> {
  const values = new Set<number>();
  for (const rawPart of source.split(",")) {
    const [base, rawStep, ...extra] = rawPart.split("/");
    if (!base || extra.length) throw new Error(`invalid ${field.name} field`);
    if (rawStep !== undefined && !/^\d+$/u.test(rawStep)) {
      throw new Error(`${field.name} step must be a positive integer`);
    }
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (step <= 0) throw new Error(`${field.name} step must be positive`);
    let start: number;
    let end: number;
    if (base === "*") {
      start = field.min;
      end = field.max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error(`invalid ${field.name} range`);
      start = integer(range[0], field);
      end = integer(range[1], field);
      if (start > end) throw new Error(`invalid ${field.name} range`);
    } else {
      start = integer(base, field);
      end = rawStep === undefined ? start : field.max;
    }
    for (let value = start; value <= end; value += step) {
      values.add(field.normalize ? field.normalize(value) : value);
    }
  }
  return new Set([...values].sort((a, b) => a - b));
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5)
    throw new Error("cron expression must have five fields");
  const parsed = fields.map((field, index) => parseField(field, FIELDS[index]));
  return {
    minutes: parsed[0],
    hours: parsed[1],
    days: parsed[2],
    months: parsed[3],
    weekdays: parsed[4],
    dayWildcard: fields[2] === "*",
    weekdayWildcard: fields[4] === "*",
  };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function matches(
  parsed: ParsedCronExpression,
  parts: Record<string, string>,
): boolean {
  const dayMatches = parsed.days.has(Number(parts.day));
  const weekdayMatches = parsed.weekdays.has(WEEKDAYS[parts.weekday]);
  const calendarDayMatches =
    parsed.dayWildcard || parsed.weekdayWildcard
      ? dayMatches && weekdayMatches
      : dayMatches || weekdayMatches;
  return (
    parsed.minutes.has(Number(parts.minute)) &&
    parsed.hours.has(Number(parts.hour)) &&
    parsed.months.has(Number(parts.month)) &&
    calendarDayMatches
  );
}

export function nextCronOccurrence(
  expression: string,
  timezone: string,
  afterMs: number,
): number {
  if (!Number.isFinite(afterMs))
    throw new Error("cron reference time is invalid");
  const zone = validateTimeZone(timezone);
  if (!zone) throw new Error("reminder timezone is invalid");
  const parsed = parseCronExpression(expression);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const firstMinute = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const horizon = firstMinute + 2 * 366 * 24 * 60 * 60_000;
  for (let candidate = firstMinute; candidate <= horizon; candidate += 60_000) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    if (matches(parsed, parts)) return candidate;
  }
  throw new Error("cron expression has no occurrence within two years");
}
