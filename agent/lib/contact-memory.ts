import { createHash } from "node:crypto";

import { z } from "zod";

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidMonthDay(value: string): boolean {
  const match = /^--(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const BirthdaySchema = z
  .string()
  .refine(
    (value) => isValidIsoDate(value) || isValidMonthDay(value),
    "birthday must be YYYY-MM-DD or --MM-DD",
  );

export const ProfileFieldSchema = z.enum([
  "full_name",
  "preferred_name",
  "nickname",
  "pronunciation",
  "formality",
  "birthday",
  "city",
  "timezone",
  "language",
  "family_context",
  "phone",
  "email",
  "telegram_username",
  "other_contact",
  "preferred_channel",
  "preferred_contact_time",
  "relationship",
  "education",
  "work",
  "project",
  "interest",
  "preference",
  "important_date",
  "gift_given",
  "gift_wish",
  "gift_idea",
  "interesting_fact",
  "conversation_followup",
]);

export const ProfileFactSchema = z
  .strictObject({
    field: ProfileFieldSchema,
    value: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(100).optional(),
    confidence: z.enum(["direct", "corroborated", "inferred", "ambiguous"]),
    source: z.string().trim().min(1).max(500).optional(),
    observedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((fact, context) => {
    if (
      fact.field === "birthday" &&
      !BirthdaySchema.safeParse(fact.value).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "birthday fact must use YYYY-MM-DD or --MM-DD",
      });
    }
    if (fact.field === "timezone") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: fact.value }).format();
      } catch {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "timezone fact must be a valid IANA timezone",
        });
      }
    }
    if (fact.field === "email" && !z.email().safeParse(fact.value).success) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "email fact must be a valid address",
      });
    }
  });
export type ProfileFact = z.infer<typeof ProfileFactSchema>;

export const DurableProfileFactSchema = ProfileFactSchema.refine(
  (fact) => fact.confidence === "direct" || fact.confidence === "corroborated",
  "durable profile facts require direct or corroborated evidence",
);

export const MeetingSchema = z.strictObject({
  ownerReported: z.literal(true),
  date: z.string().refine(isValidIsoDate, "meeting date must be YYYY-MM-DD"),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1500),
  updates: z.array(DurableProfileFactSchema).max(32).optional(),
  followups: z.array(z.string().trim().min(1).max(300)).max(16).optional(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const PersonTaskDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  direction: z.enum(["owner_to_person", "person_to_owner", "follow_up"]),
  due: z
    .string()
    .refine(isValidIsoDate, "due must be YYYY-MM-DD")
    .nullable()
    .optional(),
  context: z.string().trim().min(1).max(500).optional(),
  originMeetingId: z.string().min(1).max(100).optional(),
});
export type PersonTaskDraft = z.infer<typeof PersonTaskDraftSchema>;

/** Collapse untrusted prose to one safe, readable Markdown line. */
export function safeHumanInline(value: string): string {
  return (
    value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/<!--/gu, "&lt;!--")
      .replace(/-->/gu, "--&gt;")
      .replaceAll("[", "")
      .replaceAll("]", "")
      .replaceAll("|", " ")
      .replace(/\s+/gu, " ")
      .trim() || "Без названия"
  );
}

/** Last-mile cleanup for accidental model echoes of vault implementation details. */
export function stripInternalMemoryArtifacts(value: string): string {
  return value
    .replace(/^---\n[\s\S]*?\n---\n?/u, "")
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/\[\[[^|\]\n]+\|([^\]\n]+)\]\]/gu, "$1")
    .replace(/\[\[([^\]\n]+)\]\]/gu, "$1")
    .replace(/\b(?:EXTRACTED|INFERRED|AMBIGUOUS)\b/gu, "")
    .replace(/\btelegram:(?:user|chat|message):-?\d+(?::-?\d+)?\b/gu, "")
    .replace(/\b(?:fact|task|meeting)-[a-f0-9]{8,}\b/giu, "")
    .replace(/\btelegram-(?:user|group|channel)-\d+\b/gu, "")
    .replace(/\bcards\/(?:contacts|notes)\/telegram-[\w-]+\b/gu, "")
    .replace(/[ \t]+(?=\n)/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableRecordId(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(`${prefix}\0${canonicalJson(value)}`)
    .digest("hex")
    .slice(0, 20);
  return `${prefix}-${digest}`;
}

export function calculateAge(
  birthday: string,
  at: string | Date = new Date(),
  timezone = process.env.ASSISTANT_TIMEZONE ?? "UTC",
): number | null {
  const parsed = BirthdaySchema.parse(birthday);
  if (parsed.startsWith("--")) return null;
  const instant = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) throw new TypeError("at must be a date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const local = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const [birthYear, birthMonth, birthDay] = parsed.split("-").map(Number);
  const year = Number(local.year);
  const month = Number(local.month);
  const day = Number(local.day);
  return (
    year -
    birthYear -
    (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0)
  );
}

export interface InternalRecord {
  v: 1;
  id: string;
  kind: string;
  [key: string]: unknown;
}

export function serializeInternalRecord(record: InternalRecord): string {
  const normalized = canonicalJson(record)
    .replaceAll("<", "\\u003c")
    .replaceAll("--", "\\u002d\\u002d");
  return `<!-- iva:record:${normalized} -->`;
}

export function parseInternalRecord(comment: string): InternalRecord {
  const match = /^<!-- iva:record:(\{.*\}) -->$/u.exec(comment.trim());
  if (!match) throw new Error("invalid contact-memory record marker");
  const parsed = JSON.parse(match[1]) as unknown;
  return z
    .object({ v: z.literal(1), id: z.string().min(1), kind: z.string().min(1) })
    .passthrough()
    .parse(parsed);
}
