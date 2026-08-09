import {
  InboxAnalysisSchema,
  InboxObservationSchema,
  InboxReportSchema,
  MeetingContextSchema,
  PrivateInboxReportEnvelopeSchema,
  SourceRunHealthSchema,
  truncateCodePoints,
  type InboxAnalysis,
  type InboxObservation,
  type InboxReport,
  type InboxReportItem,
  type InboxReportMeeting,
  type MeetingContext,
  type PrivateInboxReportEnvelope,
  type SourceRunHealth,
} from "./types.ts";

const MAX_REPORT_CODE_POINTS = 12_000;
const MAX_RENDERED_ITEMS = 10;
const MAX_RENDERED_INFORMATIONAL = 5;

function reportItem(
  observation: InboxObservation,
  rationale: string,
  evidenceIds: string[],
): InboxReportItem {
  return {
    observationId: observation.id,
    title:
      observation.title ??
      observation.actor?.label ??
      observation.evidence.locator,
    summary: rationale,
    locator: observation.evidence.locator,
    evidenceIds,
  };
}

export function buildInboxReport(
  rawObservations: readonly InboxObservation[],
  rawMeetings: readonly MeetingContext[],
  rawAnalysis: InboxAnalysis,
  rawSourceHealth: readonly SourceRunHealth[],
  generatedAt = new Date(),
): InboxReport {
  const observations = rawObservations.map((observation) =>
    InboxObservationSchema.parse(observation),
  );
  const observationsById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  const meetings = rawMeetings.map((meeting) =>
    MeetingContextSchema.parse(meeting),
  );
  const meetingsById = new Map(
    meetings.map((meeting) => [meeting.eventObservationId, meeting]),
  );
  const analysis = InboxAnalysisSchema.parse(rawAnalysis);
  const sourceHealth = rawSourceHealth.map((health) =>
    SourceRunHealthSchema.parse(health),
  );

  const urgent: InboxReportItem[] = [];
  const needsReply: InboxReportItem[] = [];
  const informational: InboxReportItem[] = [];
  let informationalCount = 0;
  let ignorableCount = 0;
  for (const decision of analysis.decisions) {
    const observation = observationsById.get(decision.observationId);
    if (!observation)
      throw new Error("unified_inbox_report_unknown_observation");
    const item = reportItem(
      observation,
      decision.rationale,
      decision.evidenceIds,
    );
    if (decision.category === "urgent") urgent.push(item);
    else if (decision.category === "needs_reply") needsReply.push(item);
    else if (decision.category === "informational") {
      informationalCount += 1;
      informational.push(item);
    } else {
      ignorableCount += 1;
    }
  }

  const reportMeetings: InboxReportMeeting[] = analysis.meetingBriefs.map(
    (brief) => {
      const meeting = meetingsById.get(brief.eventObservationId);
      const event = observationsById.get(brief.eventObservationId);
      if (!meeting || event?.source !== "calendar") {
        throw new Error("unified_inbox_report_unknown_meeting");
      }
      const locators = brief.evidenceIds.map((evidenceId) => {
        const evidence = observationsById.get(evidenceId);
        if (!evidence) throw new Error("unified_inbox_report_unknown_evidence");
        return evidence.evidence.locator;
      });
      return {
        ...brief,
        title: event.title ?? event.evidence.locator,
        locators,
      };
    },
  );

  return InboxReportSchema.parse({
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    categories: {
      urgent: urgent.slice(0, 100),
      needsReply: needsReply.slice(0, 100),
      informational: informational.slice(0, 100),
    },
    meetings: reportMeetings.slice(0, 100),
    draftProposals: analysis.draftProposals.slice(0, 100),
    informationalCount,
    ignorableCount,
    sourceHealth,
    partial: sourceHealth.some((health) => health.status === "failed"),
  });
}

function itemLine(item: InboxReportItem): string {
  return `• ${item.title} — ${item.summary} [${item.locator}]`;
}

function renderedSection(
  heading: string,
  items: readonly InboxReportItem[],
  limit = MAX_RENDERED_ITEMS,
): string[] {
  const visible = items.slice(0, limit).map(itemLine);
  if (items.length > visible.length) {
    visible.push(`• Ещё: ${items.length - visible.length}`);
  }
  return [heading, ...(visible.length > 0 ? visible : ["• Нет"]), ""];
}

export function renderInboxReport(rawReport: InboxReport): string {
  const report = InboxReportSchema.parse(rawReport);
  const lines = ["📥 Входящие", ""];
  lines.push(...renderedSection("🚨 Срочно", report.categories.urgent));
  lines.push(
    ...renderedSection("✉️ Нужен ответ", report.categories.needsReply),
  );
  for (const draft of report.draftProposals.slice(0, MAX_RENDERED_ITEMS)) {
    lines.push(
      `  Предложение ответа для ${draft.to}: ${truncateCodePoints(draft.body, 500)}`,
    );
  }
  if (report.draftProposals.length > 0) lines.push("");

  lines.push("📅 Встречи");
  if (report.meetings.length === 0) lines.push("• Нет");
  for (const meeting of report.meetings.slice(0, MAX_RENDERED_ITEMS)) {
    lines.push(
      `• ${meeting.title} — ${meeting.summary} [${meeting.locators.join("; ")}]`,
    );
    for (const point of meeting.preparationPoints.slice(0, 3)) {
      lines.push(`  Подготовить: ${point}`);
    }
    for (const question of meeting.openQuestions.slice(0, 3)) {
      lines.push(`  Вопрос: ${question}`);
    }
  }
  lines.push("");

  lines.push(
    ...renderedSection(
      "ℹ️ Информация",
      report.categories.informational,
      MAX_RENDERED_INFORMATIONAL,
    ),
  );
  lines.push(`Игнорируемых: ${report.ignorableCount}`);
  const failures = report.sourceHealth.filter(
    (health) => health.status === "failed",
  );
  if (failures.length > 0) {
    lines.push("", "⚠️ Источники");
    for (const failure of failures) {
      lines.push(
        `• ${failure.source}: ${failure.errorCode ?? "unified_inbox_source_failed"}`,
      );
    }
  }
  return truncateCodePoints(lines.join("\n").trim(), MAX_REPORT_CODE_POINTS);
}

export function createPrivateInboxEnvelope(
  rawReport: InboxReport,
  ownerChatId: string,
  targetChatId: string,
): PrivateInboxReportEnvelope {
  if (ownerChatId !== targetChatId) {
    throw new Error("unified_inbox_report_owner_mismatch");
  }
  const report = InboxReportSchema.parse(rawReport);
  return PrivateInboxReportEnvelopeSchema.parse({
    schemaVersion: 1,
    ownerChatId,
    targetChatId,
    chatKind: "private",
    generatedAt: report.generatedAt,
    text: renderInboxReport(report),
    report,
  });
}
