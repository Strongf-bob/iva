import { z } from "zod";

const TelegramIntegerSchema = z.int().refine((value) => value !== 0, {
  message: "Telegram ID must be non-zero",
});
const MessageIdSchema = z.int().positive();
const CanonicalUserIdSchema = z.string().regex(/^telegram:user:-?[1-9]\d*$/u);
const CanonicalChatIdSchema = z.string().regex(/^telegram:chat:-?[1-9]\d*$/u);
const CanonicalSubjectIdSchema = z.union([
  CanonicalUserIdSchema,
  CanonicalChatIdSchema,
]);

export const ChatKindSchema = z.enum(["private", "group", "channel", "bot"]);
export type ChatKind = z.infer<typeof ChatKindSchema>;

export const TelegramDialogSchema = z.strictObject({
  id: TelegramIntegerSchema,
  kind: ChatKindSchema,
  title: z.string().min(1).max(500),
  username: z.string().min(1).max(64).nullable(),
});
export type TelegramDialog = z.infer<typeof TelegramDialogSchema>;

export const TelegramMessageSchema = z.strictObject({
  id: MessageIdSchema,
  senderId: TelegramIntegerSchema.nullable(),
  timestamp: z.iso.datetime({ offset: true }),
  text: z.string(),
  replyToMessageId: MessageIdSchema.nullable(),
  mentionedUserIds: z.array(TelegramIntegerSchema).max(100),
  mentionedUsernames: z.array(z.string().min(1).max(64)).max(100),
  mediaKind: z.enum(["voice", "video_note", "photo", "document"]).nullable(),
});
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

export const ObservationPredicateSchema = z.enum([
  "display_name",
  "username",
  "relationship",
  "role",
  "member_of",
  "works_on",
  "communication_style",
  "commitment",
  "birthday",
  "meaningful_contact",
  "follow_up",
  "preference",
  "owner_mention",
  "external_owner_claim",
]);
export type ObservationPredicate = z.infer<typeof ObservationPredicateSchema>;

export const EvidenceSchema = z.strictObject({
  chatId: TelegramIntegerSchema,
  messageId: MessageIdSchema,
  timestamp: z.iso.datetime({ offset: true }),
});

function validBirthday(value: string): boolean {
  const match = /^(?:(\d{4})-|--)(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1] ?? "2000");
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const ObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    subjectId: CanonicalSubjectIdSchema,
    kind: z.enum(["fact", "claim", "relationship", "behavior", "commitment"]),
    predicate: ObservationPredicateSchema,
    value: z.string().min(1).max(500).optional(),
    objectId: CanonicalSubjectIdSchema.optional(),
    confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]),
    assertedById: CanonicalUserIdSchema.optional(),
    contextChatId: TelegramIntegerSchema,
    evidence: z.array(EvidenceSchema).min(1).max(32),
    validFrom: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).optional(),
    relationship: z
      .strictObject({
        direction: z.enum([
          "owner_to_contact",
          "contact_to_owner",
          "mutual",
          "unknown",
        ]),
        dueAt: z.iso.datetime({ offset: true }).nullable(),
      })
      .optional(),
  })
  .superRefine((observation, context) => {
    if (
      (observation.value === undefined) ===
      (observation.objectId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "exactly one of value or objectId is required",
        path: ["value"],
      });
    }
    if (
      observation.predicate === "external_owner_claim" &&
      observation.assertedById === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "external_owner_claim requires assertedById",
        path: ["assertedById"],
      });
    }
    if (
      (observation.predicate === "commitment") !==
      (observation.relationship !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "relationship metadata is required only for commitments",
        path: ["relationship"],
      });
    }
    if (
      observation.predicate === "birthday" &&
      (observation.value === undefined ||
        observation.confidence !== "EXTRACTED" ||
        !validBirthday(observation.value))
    ) {
      context.addIssue({
        code: "custom",
        message: "birthday must be an explicit ISO or yearless date",
        path: ["value"],
      });
    }
  });
export type Observation = z.infer<typeof ObservationSchema>;

export const ClarificationQuestionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subjectId: CanonicalSubjectIdSchema,
  question: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
  contextChatId: TelegramIntegerSchema,
  evidence: z.array(EvidenceSchema).min(1).max(8),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

export const AnalysisBatchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  chatId: TelegramIntegerSchema,
  rollingSummary: z.string().max(4000),
  observations: z.array(ObservationSchema).max(32),
  questions: z.array(ClarificationQuestionSchema).max(16).optional(),
});
export type AnalysisBatch = z.infer<typeof AnalysisBatchSchema>;

// A Telegram page can exceed one model context chunk. Each individual model call remains
// capped by AnalysisBatchSchema (32), while this validated aggregate preserves every chunk.
export const AnalysisPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  chatId: TelegramIntegerSchema,
  rollingSummary: z.string().max(4000),
  observations: z.array(ObservationSchema).max(200 * 32),
  questions: z.array(ClarificationQuestionSchema).max(16).optional(),
});
export type AnalysisPage = z.infer<typeof AnalysisPageSchema>;

function requireSafeNonZeroInteger(id: number, name: string): number {
  if (!Number.isSafeInteger(id) || id === 0) {
    throw new TypeError(`${name} must be a safe non-zero integer`);
  }
  return id;
}

function requireSafePositiveInteger(id: number, name: string): number {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`${name} must be a safe positive integer`);
  }
  return id;
}

export function canonicalUserId(id: number): string {
  return `telegram:user:${requireSafeNonZeroInteger(id, "user ID")}`;
}

export function canonicalChatId(id: number): string {
  return `telegram:chat:${requireSafeNonZeroInteger(id, "chat ID")}`;
}

export function canonicalMessageId(chatId: number, messageId: number): string {
  return `telegram:message:${requireSafeNonZeroInteger(chatId, "chat ID")}:${requireSafePositiveInteger(messageId, "message ID")}`;
}
