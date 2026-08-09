import { createHash } from "node:crypto";

import { z } from "zod";

export const InboxSourceNameSchema = z.enum(["telegram", "gmail", "calendar"]);
export type InboxSourceName = z.infer<typeof InboxSourceNameSchema>;

export const InboxCategorySchema = z.enum([
  "urgent",
  "needs_reply",
  "informational",
  "ignorable",
]);
export type InboxCategory = z.infer<typeof InboxCategorySchema>;

export const OwnerIdSchema = z.string().regex(/^[1-9]\d*$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const BoundedIdentifierSchema = z.string().min(1).max(1_000);
const BoundedTextSchema = z.string().max(4_000);
const ObservationIdSchema = z
  .string()
  .regex(/^(telegram|gmail|calendar):[a-f0-9]{32}$/u);

export interface ObservationIdentity {
  source: InboxSourceName;
  sourceAccountId: string;
  externalId: string;
}

export interface ObservationRevisionIdentity extends ObservationIdentity {
  revision: string;
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function canonicalObservationId(identity: ObservationIdentity): string {
  const source = InboxSourceNameSchema.parse(identity.source);
  const sourceAccountId = BoundedIdentifierSchema.parse(
    identity.sourceAccountId,
  );
  const externalId = BoundedIdentifierSchema.parse(identity.externalId);
  return `${source}:${hashParts([source, sourceAccountId, externalId]).slice(0, 32)}`;
}

export function observationFingerprint(
  identity: ObservationRevisionIdentity,
): string {
  const source = InboxSourceNameSchema.parse(identity.source);
  const sourceAccountId = BoundedIdentifierSchema.parse(
    identity.sourceAccountId,
  );
  const externalId = BoundedIdentifierSchema.parse(identity.externalId);
  const revision = BoundedIdentifierSchema.parse(identity.revision);
  return hashParts([source, sourceAccountId, externalId, revision]);
}

export function truncateCodePoints(value: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new TypeError("maximum must be a safe positive integer");
  }
  const points = [...value];
  if (points.length <= maximum) return value;
  if (maximum === 1) return "…";
  return `${points.slice(0, maximum - 1).join("")}…`;
}

export const InboxPartySchema = z.strictObject({
  id: BoundedIdentifierSchema,
  label: z.string().min(1).max(500),
  address: z.string().email().max(320).optional(),
});
export type InboxParty = z.infer<typeof InboxPartySchema>;

export const InboxEvidenceSchema = z.strictObject({
  source: InboxSourceNameSchema,
  externalId: BoundedIdentifierSchema,
  timestamp: TimestampSchema,
  locator: z.string().min(1).max(500),
});
export type InboxEvidence = z.infer<typeof InboxEvidenceSchema>;

export const InboxObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: ObservationIdSchema,
    source: InboxSourceNameSchema,
    sourceAccountId: BoundedIdentifierSchema,
    externalId: BoundedIdentifierSchema,
    revision: BoundedIdentifierSchema,
    kind: z.enum(["message", "event"]),
    occurredAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
    title: z.string().min(1).max(500).optional(),
    excerpt: BoundedTextSchema,
    actor: InboxPartySchema.optional(),
    participants: z.array(InboxPartySchema).max(100),
    threadId: BoundedIdentifierSchema.optional(),
    replyToExternalId: BoundedIdentifierSchema.optional(),
    startsAt: TimestampSchema.optional(),
    endsAt: TimestampSchema.optional(),
    location: z.string().min(1).max(500).optional(),
    evidence: InboxEvidenceSchema,
  })
  .superRefine((observation, context) => {
    const expectedId = canonicalObservationId(observation);
    if (observation.id !== expectedId) {
      context.addIssue({
        code: "custom",
        message: "observation id does not match its source identity",
        path: ["id"],
      });
    }
    if (
      observation.evidence.source !== observation.source ||
      observation.evidence.externalId !== observation.externalId ||
      observation.evidence.timestamp !== observation.occurredAt
    ) {
      context.addIssue({
        code: "custom",
        message: "evidence does not match the observation source",
        path: ["evidence"],
      });
    }
    if (observation.source === "calendar") {
      if (
        observation.kind !== "event" ||
        observation.startsAt === undefined ||
        observation.endsAt === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Calendar events require startsAt and endsAt",
          path: ["startsAt"],
        });
      } else if (
        Date.parse(observation.endsAt) < Date.parse(observation.startsAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "Calendar event endsAt must not precede startsAt",
          path: ["endsAt"],
        });
      }
    } else if (
      observation.kind !== "message" ||
      observation.startsAt !== undefined ||
      observation.endsAt !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "message observations cannot contain event bounds",
        path: ["kind"],
      });
    }
  });
export type InboxObservation = z.infer<typeof InboxObservationSchema>;

export const SourceCursorSchema = z.strictObject({
  key: z.string().regex(/^(telegram:-?[1-9]\d*|gmail|calendar)$/u),
  value: z.string().min(1).max(500),
  order: z.int().nonnegative(),
});
export type SourceCursor = z.infer<typeof SourceCursorSchema>;

function cursorMatchesSource(source: InboxSourceName, key: string): boolean {
  if (source === "telegram") return key.startsWith("telegram:");
  return key === source;
}

export const ObservationPageSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: InboxSourceNameSchema,
    sourceAccountId: BoundedIdentifierSchema,
    cursor: SourceCursorSchema,
    observations: z.array(InboxObservationSchema).max(500),
  })
  .superRefine((page, context) => {
    if (!cursorMatchesSource(page.source, page.cursor.key)) {
      context.addIssue({
        code: "custom",
        message: "cursor key does not match page source",
        path: ["cursor", "key"],
      });
    }
    for (const [index, observation] of page.observations.entries()) {
      if (
        observation.source !== page.source ||
        observation.sourceAccountId !== page.sourceAccountId
      ) {
        context.addIssue({
          code: "custom",
          message: "observation does not match page source account",
          path: ["observations", index],
        });
      }
    }
  });
export type ObservationPage = z.infer<typeof ObservationPageSchema>;

export const CollectSourceInputSchema = z.strictObject({
  cursors: z.record(z.string(), SourceCursorSchema),
  now: TimestampSchema,
});
export type CollectSourceInput = z.infer<typeof CollectSourceInputSchema>;

export interface InboxSource {
  readonly source: InboxSourceName;
  collect(input: CollectSourceInput): AsyncIterable<ObservationPage>;
}

export const RelationshipLookupSchema = z.strictObject({
  eventObservationId: ObservationIdSchema,
  participantKeys: z.array(BoundedIdentifierSchema).max(100),
});
export type RelationshipLookup = z.infer<typeof RelationshipLookupSchema>;

export const RelationshipContextSchema = z.strictObject({
  subjectId: BoundedIdentifierSchema,
  label: z.string().min(1).max(500),
  summary: BoundedTextSchema,
  evidenceObservationIds: z.array(ObservationIdSchema).max(100),
});
export type RelationshipContext = z.infer<typeof RelationshipContextSchema>;

export interface RelationshipContextProvider {
  lookup(input: RelationshipLookup): Promise<RelationshipContext[]>;
}

export const MeetingContextSchema = z.strictObject({
  eventObservationId: ObservationIdSchema,
  participantKeys: z.array(BoundedIdentifierSchema).max(100),
  relatedObservationIds: z.array(ObservationIdSchema).max(200),
  relationshipContext: z.array(RelationshipContextSchema).max(100),
});
export type MeetingContext = z.infer<typeof MeetingContextSchema>;

const EvidenceIdArraySchema = z
  .array(ObservationIdSchema)
  .min(1)
  .max(100)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "evidence IDs must be unique",
      });
    }
  });

export const InboxDecisionSchema = z.strictObject({
  observationId: ObservationIdSchema,
  category: InboxCategorySchema,
  rationale: z.string().min(1).max(1_000),
  evidenceIds: EvidenceIdArraySchema,
});
export type InboxDecision = z.infer<typeof InboxDecisionSchema>;

export const MeetingBriefSchema = z.strictObject({
  eventObservationId: ObservationIdSchema,
  summary: z.string().min(1).max(2_000),
  preparationPoints: z.array(z.string().min(1).max(500)).max(10),
  openQuestions: z.array(z.string().min(1).max(500)).max(10),
  evidenceIds: EvidenceIdArraySchema,
});
export type MeetingBrief = z.infer<typeof MeetingBriefSchema>;

export const GmailDraftProposalSchema = z.strictObject({
  messageObservationId: ObservationIdSchema,
  to: z.string().email().max(320),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(8_000),
  evidenceIds: EvidenceIdArraySchema,
});
export type GmailDraftProposal = z.infer<typeof GmailDraftProposalSchema>;

function requireUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  message: string,
  context: z.RefinementCtx,
  path: PropertyKey,
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message, path: [path] });
  }
}

export const InboxAnalysisSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    decisions: z.array(InboxDecisionSchema).max(500),
    meetingBriefs: z.array(MeetingBriefSchema).max(100),
    draftProposals: z.array(GmailDraftProposalSchema).max(100),
  })
  .superRefine((analysis, context) => {
    requireUniqueBy(
      analysis.decisions,
      (decision) => decision.observationId,
      "decision observation IDs must be unique",
      context,
      "decisions",
    );
    requireUniqueBy(
      analysis.meetingBriefs,
      (brief) => brief.eventObservationId,
      "meeting event IDs must be unique",
      context,
      "meetingBriefs",
    );
    requireUniqueBy(
      analysis.draftProposals,
      (draft) => draft.messageObservationId,
      "draft message IDs must be unique",
      context,
      "draftProposals",
    );
  });
export type InboxAnalysis = z.infer<typeof InboxAnalysisSchema>;

export interface InboxClassifierInput {
  observations: InboxObservation[];
  meetings: MeetingContext[];
}

export interface InboxClassifier {
  analyze(input: InboxClassifierInput): Promise<InboxAnalysis>;
}

export const SourceRunHealthSchema = z.strictObject({
  source: InboxSourceNameSchema,
  status: z.enum(["ok", "failed"]),
  collected: z.int().nonnegative(),
  errorCode: z
    .string()
    .regex(/^[a-z0-9_]+$/u)
    .nullable(),
});
export type SourceRunHealth = z.infer<typeof SourceRunHealthSchema>;

export const InboxReportItemSchema = z.strictObject({
  observationId: ObservationIdSchema,
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(1_000),
  locator: z.string().min(1).max(500),
  evidenceIds: EvidenceIdArraySchema,
});
export type InboxReportItem = z.infer<typeof InboxReportItemSchema>;

export const InboxReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: TimestampSchema,
  categories: z.strictObject({
    urgent: z.array(InboxReportItemSchema).max(100),
    needsReply: z.array(InboxReportItemSchema).max(100),
    informational: z.array(InboxReportItemSchema).max(100),
  }),
  meetings: z.array(MeetingBriefSchema).max(100),
  draftProposals: z.array(GmailDraftProposalSchema).max(100),
  informationalCount: z.int().nonnegative(),
  ignorableCount: z.int().nonnegative(),
  sourceHealth: z.array(SourceRunHealthSchema).max(3),
  partial: z.boolean(),
});
export type InboxReport = z.infer<typeof InboxReportSchema>;

export const PrivateInboxReportEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ownerChatId: OwnerIdSchema,
    targetChatId: OwnerIdSchema,
    chatKind: z.literal("private"),
    generatedAt: TimestampSchema,
    text: z.string().min(1).max(12_000),
    report: InboxReportSchema,
  })
  .superRefine((envelope, context) => {
    if (envelope.ownerChatId !== envelope.targetChatId) {
      context.addIssue({
        code: "custom",
        message: "private inbox target must match the owner",
        path: ["targetChatId"],
      });
    }
  });
export type PrivateInboxReportEnvelope = z.infer<
  typeof PrivateInboxReportEnvelopeSchema
>;

export interface InboxReportSink {
  deliver(envelope: PrivateInboxReportEnvelope): Promise<void>;
}
