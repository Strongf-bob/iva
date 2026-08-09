import { createHash } from "node:crypto";

import {
  composedReportSchema,
  providerSnapshotSchema,
  ProviderFailure,
  type ProactiveProviders,
  type ProviderFailureKind,
  type ProviderSnapshot,
  type ReportPeriod,
} from "./contracts.ts";
import {
  alertAdmission,
  deliveryWindow,
  isPreparationDue,
  retryDelayMs,
  reviewPeriodsAt,
} from "./policy.ts";
import { ProactiveStore, type StoredReportVersion } from "./store.ts";

const DAY_MS = 24 * 60 * 60_000;
const MAX_TASKS_PER_TICK = 20;

export interface ReconcileInput {
  readonly nowMs: number;
  readonly ownerId: string;
  readonly store: ProactiveStore;
  readonly providers: ProactiveProviders;
  readonly settings: { readonly tokenSecret: string };
}

export interface ReconcileResult {
  readonly prepared: number;
  readonly delivered: number;
  readonly alertsDelivered: number;
  readonly tasksCreated: number;
  readonly expired: number;
}

type MutableResult = {
  -readonly [Key in keyof ReconcileResult]: ReconcileResult[Key];
};

function fingerprint(snapshot: ProviderSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function failure(
  error: unknown,
  fallback: ProviderFailureKind,
): { readonly kind: ProviderFailureKind; readonly code: string } {
  return error instanceof ProviderFailure
    ? { kind: error.kind, code: error.code.slice(0, 120) }
    : { kind: fallback, code: "unexpected-provider-error" };
}

function providerWindow(period: ReportPeriod, nowMs: number) {
  return {
    kind: period.kind,
    periodKey: period.periodKey,
    from: period.dueAt - (period.kind === "daily" ? DAY_MS : 7 * DAY_MS),
    to: Math.min(period.dueAt, nowMs),
  } as const;
}

async function preparePeriod(
  input: ReconcileInput,
  period: ReportPeriod,
  recoveryBaselineAt: number,
  result: MutableResult,
): Promise<void> {
  if (input.store.latestReadyVersion(period.kind, period.periodKey)) return;
  if (period.dueAt < recoveryBaselineAt) {
    input.store.expirePreparation(period.kind, period.periodKey);
    return;
  }
  const window = deliveryWindow(period, input.nowMs);
  if (window === "expired") {
    input.store.expirePreparation(period.kind, period.periodKey);
    result.expired += 1;
    return;
  }
  const recovery = window === "due" || window === "late";
  if (!isPreparationDue(period, input.nowMs) && !recovery) return;
  const claim = input.store.claimPreparation(
    period.kind,
    period.periodKey,
    input.nowMs,
  );
  if (!claim) return;
  try {
    const windowInput = providerWindow(period, input.nowMs);
    const [inbox, crm, calendar, tasks] = await Promise.all([
      input.providers.inbox.listInbox(windowInput),
      input.providers.crm.listRelationshipUpdates(windowInput),
      input.providers.calendar.listCalendarItems(windowInput),
      input.providers.tasks.listTasks(windowInput),
    ]);
    const snapshot = providerSnapshotSchema.parse({
      inbox,
      crm,
      calendar,
      tasks,
      collectedAt: input.nowMs,
    });
    const composed = composedReportSchema.parse(
      await input.providers.composer.compose({ period, snapshot }),
    );
    const version = input.store.saveReportVersion({
      kind: period.kind,
      periodKey: period.periodKey,
      sourceFingerprint: fingerprint(snapshot),
      body: composed.body,
      suggestions: composed.suggestions,
      alerts: composed.alerts,
      preparedAt: input.nowMs,
    });
    for (const alert of version.alerts) {
      input.store.upsertAlert(alert, input.nowMs);
    }
    result.prepared += 1;
  } catch (error) {
    const classified = failure(error, "retryable");
    input.store.recordPreparationFailure({
      kind: period.kind,
      periodKey: period.periodKey,
      code: classified.code,
      nextAttemptAt: Math.min(
        period.expiresAt,
        input.nowMs + retryDelayMs(claim.attempt),
      ),
    });
  }
}

interface DeliveryCandidate {
  readonly key: string;
  readonly versions: readonly StoredReportVersion[];
  readonly dueAt: number;
  readonly expiresAt: number;
}

function individualCandidate(
  ownerId: string,
  version: StoredReportVersion,
  period: ReportPeriod,
): DeliveryCandidate {
  return {
    key: `${ownerId}:${period.kind}:${period.periodKey}`,
    versions: [version],
    dueAt: period.dueAt,
    expiresAt: period.expiresAt,
  };
}

function deliveryCandidates(
  ownerId: string,
  daily: ReportPeriod,
  weekly: ReportPeriod,
  dailyVersion: StoredReportVersion | null,
  weeklyVersion: StoredReportVersion | null,
): readonly DeliveryCandidate[] {
  if (dailyVersion && weeklyVersion && daily.dueAt === weekly.dueAt) {
    return [
      {
        key: `${ownerId}:bundle:${daily.periodKey}:${weekly.periodKey}`,
        versions: [dailyVersion, weeklyVersion],
        dueAt: daily.dueAt,
        expiresAt: daily.expiresAt,
      },
    ];
  }
  const candidates: DeliveryCandidate[] = [];
  if (dailyVersion) {
    candidates.push(individualCandidate(ownerId, dailyVersion, daily));
  }
  if (weeklyVersion) {
    candidates.push(individualCandidate(ownerId, weeklyVersion, weekly));
  }
  return candidates;
}

function deliveryBody(versions: readonly StoredReportVersion[]): string {
  if (versions.length === 1) return versions[0]!.body;
  return versions
    .map((version) =>
      version.kind === "daily"
        ? `☀️ Daily briefing\n\n${version.body}`
        : `📅 Weekly review\n\n${version.body}`,
    )
    .join("\n\n");
}

async function deliverReports(
  input: ReconcileInput,
  daily: ReportPeriod,
  weekly: ReportPeriod,
  result: MutableResult,
): Promise<void> {
  const dailyVersion = input.store.latestReadyVersion("daily", daily.periodKey);
  const weeklyVersion = input.store.latestReadyVersion(
    "weekly",
    weekly.periodKey,
  );
  for (const candidate of deliveryCandidates(
    input.ownerId,
    daily,
    weekly,
    dailyVersion,
    weeklyVersion,
  )) {
    if (input.nowMs < candidate.dueAt) continue;
    const claim = input.store.claimDelivery({
      deliveryKey: candidate.key,
      versionIds: candidate.versions.map((version) => version.id),
      dueAt: candidate.dueAt,
      expiresAt: candidate.expiresAt,
      nowMs: input.nowMs,
    });
    if (!claim) continue;
    const actions = candidate.versions.flatMap((version) =>
      input.store
        .createCommitmentActions({
          ownerId: input.ownerId,
          reportVersionId: version.id,
          suggestions: version.suggestions,
          tokenSecret: input.settings.tokenSecret,
          nowMs: input.nowMs,
        })
        .flatMap((action) => [
          {
            text: "Create Google Task",
            callbackData: `iva_commitment:c:${action.token}`,
          },
          {
            text: "Dismiss",
            callbackData: `iva_commitment:d:${action.token}`,
          },
        ]),
    );
    try {
      const delivered = await input.providers.bot.deliver({
        deliveryKey: candidate.key,
        body: deliveryBody(candidate.versions),
        actions,
        late: input.nowMs > candidate.dueAt,
      });
      input.store.completeDelivery(
        candidate.key,
        delivered.receipt,
        input.nowMs,
      );
      result.delivered += 1;
    } catch (error) {
      const classified = failure(error, "ambiguous");
      input.store.recordDeliveryFailure({
        deliveryKey: candidate.key,
        kind: classified.kind,
        code: classified.code,
        nextAttemptAt:
          classified.kind === "retryable"
            ? input.nowMs + retryDelayMs(claim.attempt)
            : null,
        nowMs: input.nowMs,
      });
    }
  }
}

async function deliverAlerts(
  input: ReconcileInput,
  result: MutableResult,
): Promise<void> {
  for (const pending of input.store.pendingAlerts()) {
    const admission = alertAdmission(
      pending.alert.severity,
      input.nowMs,
      pending.lastDeliveredAt,
    );
    if (admission.action !== "send") {
      input.store.deferAlert(pending.alert.fingerprint, admission.until);
      continue;
    }
    const claim = input.store.claimAlertDelivery(
      pending.alert.fingerprint,
      input.nowMs,
    );
    if (!claim) continue;
    try {
      const delivered = await input.providers.bot.deliverAlert({
        alert: pending.alert,
        deliveryKey: `${input.ownerId}:alert:${pending.alert.fingerprint}`,
      });
      input.store.completeAlert(
        pending.alert.fingerprint,
        delivered.receipt,
        input.nowMs,
      );
      result.alertsDelivered += 1;
    } catch (error) {
      const classified = failure(error, "ambiguous");
      input.store.recordAlertFailure({
        fingerprint: pending.alert.fingerprint,
        kind: classified.kind,
        code: classified.code,
        nextAttemptAt:
          classified.kind === "retryable"
            ? input.nowMs + retryDelayMs(claim.attempt)
            : null,
      });
    }
  }
}

async function createConfirmedTasks(
  input: ReconcileInput,
  result: MutableResult,
): Promise<void> {
  for (let count = 0; count < MAX_TASKS_PER_TICK; count += 1) {
    const work = input.store.claimConfirmedCommitment(input.nowMs);
    if (!work) return;
    try {
      const created = await input.providers.tasks.createConfirmedCommitment({
        suggestion: work.suggestion,
        idempotencyKey: work.idempotencyKey,
      });
      input.store.completeCommitmentTask(
        work.actionHash,
        created.receipt,
        input.nowMs,
      );
      result.tasksCreated += 1;
    } catch (error) {
      const classified = failure(error, "ambiguous");
      input.store.recordCommitmentTaskFailure({
        actionHash: work.actionHash,
        kind: classified.kind,
        code: classified.code,
        nextAttemptAt:
          classified.kind === "retryable"
            ? input.nowMs + retryDelayMs(work.attempt)
            : null,
      });
    }
  }
}

export async function reconcileProactiveReviews(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  if (!/^\d+$/u.test(input.ownerId)) {
    throw new Error("proactive reviews require a numeric owner id");
  }
  if (input.settings.tokenSecret.length < 32) {
    throw new Error("proactive reviews require a private action secret");
  }
  const result: MutableResult = {
    prepared: 0,
    delivered: 0,
    alertsDelivered: 0,
    tasksCreated: 0,
    expired: 0,
  };
  const periods = reviewPeriodsAt(input.nowMs);
  const recoveryBaselineAt = input.store.recoveryBaseline(input.nowMs);
  await preparePeriod(input, periods.daily, recoveryBaselineAt, result);
  await preparePeriod(input, periods.weekly, recoveryBaselineAt, result);
  await deliverReports(input, periods.daily, periods.weekly, result);
  await deliverAlerts(input, result);
  await createConfirmedTasks(input, result);
  return result;
}
