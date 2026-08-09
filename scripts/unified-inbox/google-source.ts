import { execFile } from "node:child_process";

import { z } from "zod";

import { childEnv, gwsBin } from "../lib/menu/gws-auth.ts";
import {
  CollectSourceInputSchema,
  InboxObservationSchema,
  ObservationPageSchema,
  canonicalObservationId,
  truncateCodePoints,
  type InboxObservation,
  type InboxParty,
  type InboxSource,
} from "./types.ts";

const MAX_GWS_OUTPUT = 2 * 1024 * 1024;
const GMAIL_OVERLAP_MS = 60_000;
const GMAIL_FIRST_RUN_MS = 7 * 24 * 60 * 60 * 1_000;
const CALENDAR_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const CALENDAR_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1_000;

export interface GwsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GwsRunner = (args: readonly string[]) => Promise<GwsResult>;

interface GwsExecOptions {
  bin?: string;
  personalRoot?: string;
}

const ALLOWED_GWS_PREFIXES = [
  ["gmail", "users", "messages", "list", "--params"],
  ["gmail", "users", "messages", "get", "--params"],
  ["calendar", "events", "list", "--params"],
] as const;

export function validateReadOnlyGwsArgs(args: readonly string[]): string[] {
  const allowed = ALLOWED_GWS_PREFIXES.some(
    (prefix) =>
      args.length === prefix.length + 1 &&
      prefix.every((value, index) => args[index] === value),
  );
  if (!allowed) throw new Error("gws command is not allowed");
  let params: unknown;
  try {
    params = JSON.parse(args.at(-1) ?? "");
  } catch {
    throw new Error("gws command is not allowed");
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("gws command is not allowed");
  }
  return [...args];
}

export function execGws(
  rawArgs: readonly string[],
  { bin = gwsBin(), personalRoot }: GwsExecOptions = {},
): Promise<GwsResult> {
  const args = validateReadOnlyGwsArgs(rawArgs);
  return new Promise((resolvePromise) => {
    execFile(
      bin,
      args,
      {
        env: childEnv(personalRoot),
        timeout: 120_000,
        maxBuffer: MAX_GWS_OUTPUT,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolvePromise({
          stdout,
          stderr,
          exitCode: typeof code === "number" ? code : error ? 1 : 0,
        });
      },
    );
  });
}

const PageTokenSchema = z.string().min(1).max(1_000);
const GmailMessageReferenceSchema = z.strictObject({
  id: z.string().min(1).max(1_000),
  threadId: z.string().min(1).max(1_000).optional(),
});
const GmailListSchema = z.strictObject({
  messages: z.array(GmailMessageReferenceSchema).max(100).optional(),
  nextPageToken: PageTokenSchema.optional(),
  resultSizeEstimate: z.int().nonnegative().optional(),
});
const GmailHeaderSchema = z.strictObject({
  name: z.string().min(1).max(200),
  value: z.string().max(20_000),
});
const GmailBodySchema = z.strictObject({
  attachmentId: z.string().min(1).max(1_000).optional(),
  size: z.int().nonnegative().optional(),
  data: z.string().max(MAX_GWS_OUTPUT).optional(),
});
interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: z.infer<typeof GmailHeaderSchema>[];
  body?: z.infer<typeof GmailBodySchema>;
  parts?: GmailPart[];
}
const GmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.strictObject({
    partId: z.string().max(200).optional(),
    mimeType: z.string().max(200).optional(),
    filename: z.string().max(1_000).optional(),
    headers: z.array(GmailHeaderSchema).max(200).optional(),
    body: GmailBodySchema.optional(),
    parts: z.array(GmailPartSchema).max(200).optional(),
  }),
);
const GmailMessageSchema = z.strictObject({
  id: z.string().min(1).max(1_000),
  threadId: z.string().min(1).max(1_000),
  labelIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  snippet: z.string().max(20_000).optional(),
  historyId: z.string().regex(/^\d+$/u).optional(),
  internalDate: z.string().regex(/^\d+$/u),
  sizeEstimate: z.int().nonnegative().optional(),
  raw: z.string().max(MAX_GWS_OUTPUT).optional(),
  payload: GmailPartSchema,
});

const GooglePersonSchema = z.strictObject({
  id: z.string().max(1_000).optional(),
  email: z.string().email().max(320).optional(),
  displayName: z.string().max(500).optional(),
  self: z.boolean().optional(),
});
const CalendarAttendeeSchema = GooglePersonSchema.extend({
  organizer: z.boolean().optional(),
  resource: z.boolean().optional(),
  optional: z.boolean().optional(),
  responseStatus: z.string().max(100).optional(),
  comment: z.string().max(2_000).optional(),
  additionalGuests: z.int().nonnegative().optional(),
});
const CalendarDateTimeSchema = z
  .strictObject({
    date: z.iso.date().optional(),
    dateTime: z.iso.datetime({ offset: true }).optional(),
    timeZone: z.string().max(200).optional(),
  })
  .refine(
    (value) => (value.date === undefined) !== (value.dateTime === undefined),
  );
const CalendarEventSchema = z.strictObject({
  kind: z.string().max(200).optional(),
  etag: z.string().min(1).max(1_000).optional(),
  id: z.string().min(1).max(1_000),
  status: z.string().max(100).optional(),
  htmlLink: z.string().url().max(2_000).optional(),
  created: z.iso.datetime({ offset: true }).optional(),
  updated: z.iso.datetime({ offset: true }),
  summary: z.string().max(2_000).optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(2_000).optional(),
  colorId: z.string().max(100).optional(),
  creator: GooglePersonSchema.optional(),
  organizer: GooglePersonSchema.optional(),
  start: CalendarDateTimeSchema,
  end: CalendarDateTimeSchema,
  endTimeUnspecified: z.boolean().optional(),
  recurrence: z.array(z.string().max(2_000)).max(100).optional(),
  recurringEventId: z.string().max(1_000).optional(),
  originalStartTime: CalendarDateTimeSchema.optional(),
  transparency: z.string().max(100).optional(),
  visibility: z.string().max(100).optional(),
  iCalUID: z.string().max(1_000).optional(),
  sequence: z.int().nonnegative().optional(),
  attendees: z.array(CalendarAttendeeSchema).max(500).optional(),
  attendeesOmitted: z.boolean().optional(),
  extendedProperties: z.unknown().optional(),
  hangoutLink: z.string().url().max(2_000).optional(),
  conferenceData: z.unknown().optional(),
  gadget: z.unknown().optional(),
  anyoneCanAddSelf: z.boolean().optional(),
  guestsCanInviteOthers: z.boolean().optional(),
  guestsCanModify: z.boolean().optional(),
  guestsCanSeeOtherGuests: z.boolean().optional(),
  privateCopy: z.boolean().optional(),
  locked: z.boolean().optional(),
  reminders: z.unknown().optional(),
  source: z.unknown().optional(),
  workingLocationProperties: z.unknown().optional(),
  outOfOfficeProperties: z.unknown().optional(),
  focusTimeProperties: z.unknown().optional(),
  birthdayProperties: z.unknown().optional(),
  eventType: z.string().max(100).optional(),
});
const CalendarListSchema = z.strictObject({
  kind: z.string().max(200).optional(),
  etag: z.string().max(1_000).optional(),
  summary: z.string().max(2_000).optional(),
  description: z.string().max(20_000).optional(),
  updated: z.iso.datetime({ offset: true }).optional(),
  timeZone: z.string().max(200).optional(),
  accessRole: z.string().max(100).optional(),
  defaultReminders: z.unknown().optional(),
  nextPageToken: PageTokenSchema.optional(),
  nextSyncToken: z.string().max(1_000).optional(),
  items: z.array(CalendarEventSchema).max(2_500).optional(),
});

function parseResult<T>(result: GwsResult, schema: z.ZodType<T>): T {
  if (result.exitCode !== 0) {
    throw new Error("unified_inbox_google_command_failed");
  }
  if (result.stdout.length > MAX_GWS_OUTPUT) {
    throw new Error("unified_inbox_google_response_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("unified_inbox_google_response_invalid");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("unified_inbox_google_response_invalid");
  }
  return parsed.data;
}

function header(part: GmailPart, name: string): string | undefined {
  return part.headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

function emailParty(value: string): InboxParty | undefined {
  const match = /<([^<>\s]+@[^<>\s]+)>/u.exec(value);
  const bare = match?.[1] ?? /[^\s,<]+@[^\s,>]+/u.exec(value)?.[0];
  if (!bare) return undefined;
  const address = bare.toLowerCase();
  const prefix = match
    ? value.slice(0, match.index).trim().replace(/^"|"$/gu, "")
    : "";
  return {
    id: address,
    label: truncateCodePoints(prefix || address, 500),
    address,
  };
}

function recipientParties(value: string | undefined): InboxParty[] {
  if (!value) return [];
  const parties = value
    .split(",")
    .map(emailParty)
    .filter((party): party is InboxParty => party !== undefined);
  return [...new Map(parties.map((party) => [party.id, party])).values()].slice(
    0,
    100,
  );
}

function decodeBody(part: GmailPart): string | undefined {
  if (part.mimeType === "text/plain" && part.body?.data) {
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(part.body.data)) return undefined;
    try {
      return Buffer.from(part.body.data, "base64url").toString("utf8");
    } catch {
      return undefined;
    }
  }
  for (const child of part.parts ?? []) {
    const text = decodeBody(child);
    if (text !== undefined) return text;
  }
  return undefined;
}

function normalizeGmailMessage(
  sourceAccountId: string,
  message: z.infer<typeof GmailMessageSchema>,
): InboxObservation {
  const timestampMs = Number(message.internalDate);
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error("unified_inbox_google_response_invalid");
  }
  const occurredAt = new Date(timestampMs).toISOString();
  const identity = {
    source: "gmail" as const,
    sourceAccountId,
    externalId: message.id,
  };
  const from = header(message.payload, "from");
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: message.historyId ?? message.internalDate,
    kind: "message",
    occurredAt,
    updatedAt: occurredAt,
    title: truncateCodePoints(
      header(message.payload, "subject") || "(no subject)",
      500,
    ),
    excerpt: truncateCodePoints(
      decodeBody(message.payload) || message.snippet || "",
      4_000,
    ),
    actor: from ? emailParty(from) : undefined,
    participants: recipientParties(header(message.payload, "to")),
    threadId: message.threadId,
    evidence: {
      source: "gmail",
      externalId: message.id,
      timestamp: occurredAt,
      locator: `Gmail message ${message.id}`,
    },
  });
}

function sourceAccount(value: string): string {
  return z.string().min(1).max(1_000).parse(value);
}

export interface GmailInboxSourceOptions {
  runner?: GwsRunner;
  sourceAccountId?: string;
}

export function createGmailInboxSource({
  runner = (args) => execGws(args),
  sourceAccountId: rawSourceAccountId = "me",
}: GmailInboxSourceOptions = {}): InboxSource {
  const sourceAccountId = sourceAccount(rawSourceAccountId);
  return {
    source: "gmail",
    async *collect(rawInput) {
      const input = CollectSourceInputSchema.parse(rawInput);
      const prior = input.cursors.gmail;
      const nowMs = Date.parse(input.now);
      const queryAfterMs = prior
        ? Math.max(0, prior.order - GMAIL_OVERLAP_MS)
        : Math.max(0, nowMs - GMAIL_FIRST_RUN_MS);
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const params = {
          userId: sourceAccountId,
          q: `in:inbox after:${Math.floor(queryAfterMs / 1_000)}`,
          maxResults: 100,
          ...(pageToken ? { pageToken } : {}),
        };
        const list = parseResult(
          await runner([
            "gmail",
            "users",
            "messages",
            "list",
            "--params",
            JSON.stringify(params),
          ]),
          GmailListSchema,
        );
        const observations: InboxObservation[] = [];
        let highWatermark = prior?.order ?? 0;
        for (const reference of list.messages ?? []) {
          const message = parseResult(
            await runner([
              "gmail",
              "users",
              "messages",
              "get",
              "--params",
              JSON.stringify({
                userId: sourceAccountId,
                id: reference.id,
                format: "full",
              }),
            ]),
            GmailMessageSchema,
          );
          if (message.id !== reference.id) {
            throw new Error("unified_inbox_google_response_invalid");
          }
          const normalized = normalizeGmailMessage(sourceAccountId, message);
          observations.push(normalized);
          highWatermark = Math.max(highWatermark, Number(message.internalDate));
        }
        if (observations.length > 0) {
          yield ObservationPageSchema.parse({
            schemaVersion: 1,
            source: "gmail",
            sourceAccountId,
            cursor: {
              key: "gmail",
              value: String(highWatermark),
              order: highWatermark,
            },
            observations,
          });
        }
        pageToken = list.nextPageToken;
        if (pageToken) {
          if (seenTokens.has(pageToken)) {
            throw new Error("unified_inbox_google_response_invalid");
          }
          seenTokens.add(pageToken);
        }
      } while (pageToken);
    },
  };
}

function calendarTimestamp(
  value: z.infer<typeof CalendarDateTimeSchema>,
): string {
  return value.dateTime ?? `${value.date}T00:00:00.000Z`;
}

function googlePerson(
  value: z.infer<typeof GooglePersonSchema> | undefined,
): InboxParty | undefined {
  if (!value) return undefined;
  const id = value.email?.toLowerCase() || value.id;
  if (!id) return undefined;
  return {
    id,
    label: truncateCodePoints(value.displayName?.trim() || id, 500),
    ...(value.email ? { address: value.email.toLowerCase() } : {}),
  };
}

function normalizeCalendarEvent(
  sourceAccountId: string,
  event: z.infer<typeof CalendarEventSchema>,
): InboxObservation {
  const startsAt = calendarTimestamp(event.start);
  const endsAt = calendarTimestamp(event.end);
  const identity = {
    source: "calendar" as const,
    sourceAccountId,
    externalId: event.id,
  };
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: event.etag ?? event.updated,
    kind: "event",
    occurredAt: startsAt,
    updatedAt: event.updated,
    title: truncateCodePoints(event.summary || "(untitled event)", 500),
    excerpt: truncateCodePoints(event.description || "", 4_000),
    actor: googlePerson(event.organizer),
    participants: (event.attendees ?? [])
      .map(googlePerson)
      .filter((party): party is InboxParty => party !== undefined)
      .slice(0, 100),
    startsAt,
    endsAt,
    location: event.location
      ? truncateCodePoints(event.location, 500)
      : undefined,
    evidence: {
      source: "calendar",
      externalId: event.id,
      timestamp: startsAt,
      locator: `Calendar event ${event.id}`,
    },
  });
}

export interface CalendarInboxSourceOptions {
  runner?: GwsRunner;
  sourceAccountId?: string;
}

export function createCalendarInboxSource({
  runner = (args) => execGws(args),
  sourceAccountId: rawSourceAccountId = "primary",
}: CalendarInboxSourceOptions = {}): InboxSource {
  const sourceAccountId = sourceAccount(rawSourceAccountId);
  return {
    source: "calendar",
    async *collect(rawInput) {
      const input = CollectSourceInputSchema.parse(rawInput);
      const nowMs = Date.parse(input.now);
      const prior = input.cursors.calendar;
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const params = {
          calendarId: sourceAccountId,
          timeMin: new Date(nowMs - CALENDAR_LOOKBACK_MS).toISOString(),
          timeMax: new Date(nowMs + CALENDAR_LOOKAHEAD_MS).toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 2500,
          ...(pageToken ? { pageToken } : {}),
        };
        const list = parseResult(
          await runner([
            "calendar",
            "events",
            "list",
            "--params",
            JSON.stringify(params),
          ]),
          CalendarListSchema,
        );
        const observations = (list.items ?? []).map((event) =>
          normalizeCalendarEvent(sourceAccountId, event),
        );
        if (observations.length > 0) {
          const highWatermark = Math.max(
            prior?.order ?? 0,
            ...(list.items ?? []).map((event) => Date.parse(event.updated)),
          );
          const value =
            prior && prior.order === highWatermark
              ? prior.value
              : new Date(highWatermark).toISOString();
          yield ObservationPageSchema.parse({
            schemaVersion: 1,
            source: "calendar",
            sourceAccountId,
            cursor: { key: "calendar", value, order: highWatermark },
            observations,
          });
        }
        pageToken = list.nextPageToken;
        if (pageToken) {
          if (seenTokens.has(pageToken)) {
            throw new Error("unified_inbox_google_response_invalid");
          }
          seenTokens.add(pageToken);
        }
      } while (pageToken);
    },
  };
}
