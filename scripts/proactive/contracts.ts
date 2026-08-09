import { z } from "zod";

export const MAX_PROVIDER_ITEMS = 500;
export const MAX_REPORT_BODY = 32_000;

const boundedText = z.string().trim().min(1).max(4_000);
const evidenceRef = z.string().trim().min(1).max(1_024);

export const normalizedItemSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(500),
    summary: boundedText.optional(),
    occurredAt: z.number().int().nonnegative().optional(),
    dueAt: z.number().int().nonnegative().optional(),
    evidence: z.array(evidenceRef).min(1).max(8),
  })
  .strict();

export const commitmentSuggestionSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(500),
    notes: boundedText.optional(),
    dueAt: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(evidenceRef).min(1).max(8),
  })
  .strict();

export const urgentAlertSchema = z
  .object({
    fingerprint: z.string().trim().min(16).max(256),
    severity: z.enum(["high", "critical"]),
    title: z.string().trim().min(1).max(500),
    body: boundedText,
    evidence: z.array(evidenceRef).min(1).max(8),
  })
  .strict();

export const providerSnapshotSchema = z
  .object({
    inbox: z.array(normalizedItemSchema).max(MAX_PROVIDER_ITEMS),
    crm: z.array(normalizedItemSchema).max(MAX_PROVIDER_ITEMS),
    calendar: z.array(normalizedItemSchema).max(MAX_PROVIDER_ITEMS),
    tasks: z.array(normalizedItemSchema).max(MAX_PROVIDER_ITEMS),
    collectedAt: z.number().int().nonnegative(),
  })
  .strict();

export type ReportKind = "daily" | "weekly";
export type AlertSeverity = "high" | "critical";
export type NormalizedItem = z.infer<typeof normalizedItemSchema>;
export type ProviderSnapshot = z.infer<typeof providerSnapshotSchema>;
export type CommitmentSuggestion = z.infer<
  typeof commitmentSuggestionSchema
>;
export type UrgentAlert = z.infer<typeof urgentAlertSchema>;

export interface ReportPeriod {
  readonly kind: ReportKind;
  readonly periodKey: string;
  readonly prepareAt: number;
  readonly freezeAt: number;
  readonly dueAt: number;
  readonly expiresAt: number;
}

export interface ProviderWindow {
  readonly kind: ReportKind;
  readonly periodKey: string;
  readonly from: number;
  readonly to: number;
}

export interface UnifiedInboxProvider {
  listInbox(window: ProviderWindow): Promise<readonly NormalizedItem[]>;
}

export interface CrmProvider {
  listRelationshipUpdates(
    window: ProviderWindow,
  ): Promise<readonly NormalizedItem[]>;
}

export interface CalendarProvider {
  listCalendarItems(window: ProviderWindow): Promise<readonly NormalizedItem[]>;
}

export interface TasksProvider {
  listTasks(window: ProviderWindow): Promise<readonly NormalizedItem[]>;
  createConfirmedCommitment(input: {
    readonly suggestion: CommitmentSuggestion;
    readonly idempotencyKey: string;
  }): Promise<{ readonly receipt: string }>;
}

export interface ComposedReport {
  readonly body: string;
  readonly sourceFingerprint: string;
  readonly suggestions: readonly CommitmentSuggestion[];
  readonly alerts: readonly UrgentAlert[];
}

export interface ReportComposer {
  compose(input: {
    readonly period: ReportPeriod;
    readonly snapshot: ProviderSnapshot;
  }): Promise<ComposedReport>;
}

export type ProviderFailureKind = "retryable" | "ambiguous" | "terminal";

export interface BotDelivery {
  readonly deliveryKey: string;
  readonly body: string;
  readonly actions: readonly {
    readonly text: string;
    readonly callbackData: string;
  }[];
  readonly late: boolean;
}

export interface BotDeliveryProvider {
  deliver(input: BotDelivery): Promise<{ readonly receipt: string }>;
  deliverAlert(input: {
    readonly alert: UrgentAlert;
    readonly deliveryKey: string;
  }): Promise<{ readonly receipt: string }>;
}

export interface ProactiveProviders {
  readonly inbox: UnifiedInboxProvider;
  readonly crm: CrmProvider;
  readonly calendar: CalendarProvider;
  readonly tasks: TasksProvider;
  readonly composer: ReportComposer;
  readonly bot: BotDeliveryProvider;
}

export class ProviderFailure extends Error {
  declare readonly kind: ProviderFailureKind;
  declare readonly code: string;

  constructor(kind: ProviderFailureKind, code: string) {
    super(`${kind}:${code}`);
    this.name = "ProviderFailure";
    this.kind = kind;
    this.code = code;
  }
}
