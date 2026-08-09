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
const SECTION_BUDGETS = {
  urgent: 2_800,
  reply: 3_000,
  meetings: 3_000,
  informational: 1_600,
} as const;

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
  deferredObservationCount = 0,
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
      const orderedEvidenceIds = [
        brief.eventObservationId,
        ...brief.evidenceIds.filter(
          (evidenceId) => evidenceId !== brief.eventObservationId,
        ),
      ];
      const locators = orderedEvidenceIds.map((evidenceId) => {
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
    urgentCount: urgent.length,
    needsReplyCount: needsReply.length,
    informationalCount,
    ignorableCount,
    deferredObservationCount,
    sourceHealth,
    partial: sourceHealth.some((health) => health.status === "failed"),
  });
}

function itemLine(item: InboxReportItem): string {
  return `• ${truncateCodePoints(item.title, 160)} — ${truncateCodePoints(item.summary, 420)} [${item.locator}]`;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function renderedSection(
  heading: string,
  groups: readonly string[][],
  budget: number,
  totalCount = groups.length,
): string[] {
  if (totalCount === 0) return [heading, "• Нет", ""];
  const lines = [heading];
  let used = codePointLength(heading) + 1;
  let included = 0;
  for (const group of groups) {
    if (group.length === 0) continue;
    const omittedAfter = Math.max(totalCount - included - 1, 0);
    const markerCost =
      omittedAfter > 0
        ? codePointLength(`• Ещё элементов: ${omittedAfter}`) + 1
        : 0;
    const primaryCost = codePointLength(group[0] ?? "") + 1;
    if (used + primaryCost + markerCost > budget) break;
    lines.push(group[0] ?? "");
    used += primaryCost;
    included += 1;
    for (const optionalLine of group.slice(1)) {
      const optionalCost = codePointLength(optionalLine) + 1;
      if (used + optionalCost + markerCost > budget) break;
      lines.push(optionalLine);
      used += optionalCost;
    }
  }
  if (included < totalCount) {
    lines.push(`• Ещё элементов: ${totalCount - included}`);
  }
  return [...lines, ""];
}

export function renderInboxReport(rawReport: InboxReport): string {
  const report = InboxReportSchema.parse(rawReport);
  const lines = ["📥 Входящие", ""];
  const failures = report.sourceHealth.filter(
    (health) => health.status === "failed",
  );
  if (failures.length > 0) {
    lines.push("⚠️ Источники");
    for (const failure of failures) {
      lines.push(
        `• ${failure.source}: ${failure.errorCode ?? "unified_inbox_source_failed"}`,
      );
    }
    lines.push("");
  }
  if (report.deferredObservationCount > 0) {
    lines.push(
      `Отложено до следующего отчёта: ${report.deferredObservationCount}`,
      "",
    );
  }

  lines.push(
    ...renderedSection(
      "🚨 Срочно",
      report.categories.urgent.map((item) => [itemLine(item)]),
      SECTION_BUDGETS.urgent,
      report.urgentCount,
    ),
  );
  const replyGroups = report.categories.needsReply.map((item) => [
    itemLine(item),
  ]);
  for (const draft of report.draftProposals) {
    replyGroups.push([
      `  Предложение ответа для ${draft.to}: ${truncateCodePoints(draft.body, 500)}`,
    ]);
  }
  lines.push(
    ...renderedSection(
      "✉️ Нужен ответ",
      replyGroups,
      SECTION_BUDGETS.reply,
      report.needsReplyCount + report.draftProposals.length,
    ),
  );

  const meetingGroups = report.meetings.map((meeting) => {
    const group = [
      `• ${truncateCodePoints(meeting.title, 160)} — ${truncateCodePoints(meeting.summary, 500)} [${meeting.locators.slice(0, 2).join("; ")}]`,
    ];
    for (const point of meeting.preparationPoints.slice(0, 3)) {
      group.push(`  Подготовить: ${truncateCodePoints(point, 250)}`);
    }
    for (const question of meeting.openQuestions.slice(0, 3)) {
      group.push(`  Вопрос: ${truncateCodePoints(question, 250)}`);
    }
    return group;
  });
  lines.push(
    ...renderedSection("📅 Встречи", meetingGroups, SECTION_BUDGETS.meetings),
  );

  lines.push(
    ...renderedSection(
      "ℹ️ Информация",
      report.categories.informational.map((item) => [itemLine(item)]),
      SECTION_BUDGETS.informational,
      report.informationalCount,
    ),
  );
  lines.push(`Игнорируемых: ${report.ignorableCount}`);
  const text = lines.join("\n").trim();
  if (codePointLength(text) > MAX_REPORT_CODE_POINTS) {
    throw new Error("unified_inbox_report_render_overflow");
  }
  return text;
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
