import { createHash } from "node:crypto";

import { z } from "zod";

export const RELATIONSHIP_REGISTRY_SCHEMA =
  "iva-relationship-commitments/v1" as const;

const CanonicalUserIdSchema = z.string().regex(/^telegram:user:-?[1-9]\d*$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });

export const RelationshipEvidenceSchema = z.strictObject({
  source: z.enum(["telegram", "memory", "calendar", "document", "owner"]),
  sourceId: z.string().min(1).max(500),
  observedAt: IsoDateSchema,
  excerpt: z.string().min(1).max(500).optional(),
});
export type RelationshipEvidence = z.infer<typeof RelationshipEvidenceSchema>;

export const CommitmentStatusSchema = z.enum([
  "pending_suggestion",
  "confirmed_task",
  "completed",
  "dismissed",
]);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

const GoogleTaskReceiptSchema = z.strictObject({
  taskListId: z.string().min(1).max(500),
  taskId: z.string().min(1).max(500),
  createdAt: IsoDateSchema,
});

const ConfirmationSchema = z.strictObject({
  phraseHash: z.string().regex(/^[a-f0-9]{64}$/u),
  preparedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});

export const CommitmentSchema = z.strictObject({
  id: z.string().regex(/^RI-[a-f0-9]{16}$/u),
  text: z.string().min(1).max(1000),
  direction: z.enum([
    "owner_to_contact",
    "contact_to_owner",
    "mutual",
    "unknown",
  ]),
  contactIds: z.array(CanonicalUserIdSchema).max(32),
  dueAt: IsoDateSchema.nullable(),
  status: CommitmentStatusSchema,
  evidence: z.array(RelationshipEvidenceSchema).min(1).max(64),
  firstSeenAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  googleTask: GoogleTaskReceiptSchema.nullable(),
  confirmation: ConfirmationSchema.nullable(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const ContactActivitySchema = z.strictObject({
  birthday: z
    .strictObject({
      value: z.string().regex(/^(?:\d{4}-|--)\d{2}-\d{2}$/u),
      evidence: RelationshipEvidenceSchema,
    })
    .nullable(),
  lastMeaningfulContactAt: IsoDateSchema.nullable(),
  meaningfulContactEvidence: RelationshipEvidenceSchema.nullable(),
  followUps: z.array(z.string().regex(/^RI-[a-f0-9]{16}$/u)).max(256),
});
export type ContactActivity = z.infer<typeof ContactActivitySchema>;

export const RelationshipRegistrySchema = z.strictObject({
  schema: z.literal(RELATIONSHIP_REGISTRY_SCHEMA),
  revision: z.int().nonnegative(),
  commitments: z.array(CommitmentSchema),
  contacts: z.record(CanonicalUserIdSchema, ContactActivitySchema),
});
export type RelationshipRegistry = z.infer<typeof RelationshipRegistrySchema>;

export function emptyRelationshipRegistry(): RelationshipRegistry {
  return {
    schema: RELATIONSHIP_REGISTRY_SCHEMA,
    revision: 0,
    commitments: [],
    contacts: {},
  };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function nextBirthdayOccurrence(value: string, now: string): string {
  const match = /^(?:\d{4}-|--)(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("invalid birthday");
  const current = new Date(IsoDateSchema.parse(now));
  const month = Number(match[1]);
  const day = Number(match[2]);
  const today = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );
  for (let offset = 0; offset <= 8; offset += 1) {
    const year = current.getUTCFullYear() + offset;
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day &&
      candidate.getTime() >= today
    )
      return candidate.toISOString().slice(0, 10);
  }
  throw new Error("birthday has no future occurrence");
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

export function commitmentId(
  input: Pick<Commitment, "text" | "evidence">,
): string {
  const evidence = input.evidence
    .map((item) => RelationshipEvidenceSchema.parse(item))
    .sort((left, right) =>
      `${left.source}:${left.sourceId}:${left.observedAt}`.localeCompare(
        `${right.source}:${right.sourceId}:${right.observedAt}`,
      ),
    );
  return `RI-${createHash("sha256")
    .update(canonicalJson({ text: normalizeText(input.text), evidence }))
    .digest("hex")
    .slice(0, 16)}`;
}

export function transitionCommitment(
  item: Commitment,
  status: CommitmentStatus,
  now: string,
): Commitment {
  const parsed = CommitmentSchema.parse(item);
  CommitmentStatusSchema.parse(status);
  IsoDateSchema.parse(now);
  if (["completed", "dismissed"].includes(parsed.status)) {
    throw new Error(
      `terminal commitment cannot transition from ${parsed.status}`,
    );
  }
  if (parsed.status === "confirmed_task" && status === "pending_suggestion") {
    throw new Error("confirmed commitment cannot return to pending");
  }
  return CommitmentSchema.parse({ ...parsed, status, updatedAt: now });
}

export function classifyCommitment(
  item: Commitment,
  now: string,
  lastMeaningfulContactAt: string | null,
): { overdue: boolean; forgotten: boolean } {
  const parsed = CommitmentSchema.parse(item);
  const nowMs = Date.parse(IsoDateSchema.parse(now));
  const open = !["completed", "dismissed"].includes(parsed.status);
  const overdue =
    open && parsed.dueAt !== null && Date.parse(parsed.dueAt) < nowMs;
  const forgotten =
    open &&
    parsed.dueAt === null &&
    parsed.direction === "owner_to_contact" &&
    lastMeaningfulContactAt !== null &&
    nowMs - Date.parse(IsoDateSchema.parse(lastMeaningfulContactAt)) >=
      30 * 24 * 60 * 60 * 1000;
  return { overdue, forgotten };
}
