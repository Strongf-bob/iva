/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInboxReport,
  createPrivateInboxEnvelope,
  renderInboxReport,
} from "./report.ts";
import {
  InboxAnalysisSchema,
  InboxObservationSchema,
  canonicalObservationId,
  type InboxObservation,
  type MeetingContext,
  type SourceRunHealth,
} from "./types.ts";

const generatedAt = "2026-08-09T08:00:00.000Z";

function message(
  externalId: string,
  title: string,
  excerpt: string,
): InboxObservation {
  const identity = {
    source: "gmail" as const,
    sourceAccountId: "me",
    externalId,
  };
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: "1",
    kind: "message",
    occurredAt: generatedAt,
    updatedAt: generatedAt,
    title,
    excerpt,
    actor: {
      id: "alice@example.com",
      label: "Alice",
      address: "alice@example.com",
    },
    participants: [],
    evidence: {
      source: "gmail",
      externalId,
      timestamp: generatedAt,
      locator: `Gmail message ${externalId}`,
    },
  });
}

function calendarEvent(): InboxObservation {
  const identity = {
    source: "calendar" as const,
    sourceAccountId: "primary",
    externalId: "event-1",
  };
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: "1",
    kind: "event",
    occurredAt: "2026-08-09T10:00:00.000Z",
    updatedAt: generatedAt,
    title: "Project review",
    excerpt: "Discuss decisions",
    participants: [],
    startsAt: "2026-08-09T10:00:00.000Z",
    endsAt: "2026-08-09T11:00:00.000Z",
    evidence: {
      source: "calendar",
      externalId: "event-1",
      timestamp: "2026-08-09T10:00:00.000Z",
      locator: "Calendar event event-1",
    },
  });
}

const urgent = message("urgent", "Production issue", "Please respond now");
const needsReply = message("reply", "Project review", "Can you review this?");
const informational = message("info", "FYI", "Status update");
const ignorable = message("ignore", "Promotion", "IGNORABLE SECRET BODY");
const event = calendarEvent();
const observations = [urgent, needsReply, informational, ignorable, event];
const meetings: MeetingContext[] = [
  {
    eventObservationId: event.id,
    participantKeys: [],
    relatedObservationIds: [needsReply.id],
    relationshipContext: [],
  },
];
const analysis = InboxAnalysisSchema.parse({
  schemaVersion: 1,
  decisions: [
    {
      observationId: urgent.id,
      category: "urgent",
      rationale: "Immediate response requested.",
      evidenceIds: [urgent.id],
    },
    {
      observationId: needsReply.id,
      category: "needs_reply",
      rationale: "Direct question.",
      evidenceIds: [needsReply.id],
    },
    {
      observationId: informational.id,
      category: "informational",
      rationale: "Useful update.",
      evidenceIds: [informational.id],
    },
    {
      observationId: ignorable.id,
      category: "ignorable",
      rationale: "Promotion.",
      evidenceIds: [ignorable.id],
    },
    {
      observationId: event.id,
      category: "informational",
      rationale: "Upcoming meeting.",
      evidenceIds: [event.id],
    },
  ],
  meetingBriefs: [
    {
      eventObservationId: event.id,
      summary: "Review the latest decision before the meeting.",
      preparationPoints: ["Read the project plan"],
      openQuestions: ["Which option is approved?"],
      evidenceIds: [event.id, needsReply.id],
    },
  ],
  draftProposals: [
    {
      messageObservationId: needsReply.id,
      to: "alice@example.com",
      subject: "Re: Project review",
      body: "Thanks, I will review it today.",
      evidenceIds: [needsReply.id],
    },
  ],
});
const health: SourceRunHealth[] = [
  { source: "telegram", status: "ok", collected: 1, errorCode: null },
  { source: "gmail", status: "ok", collected: 4, errorCode: null },
  {
    source: "calendar",
    status: "failed",
    collected: 0,
    errorCode: "unified_inbox_source_failed",
  },
];

test("report is priority ordered, evidence-located, and omits ignorable bodies", () => {
  const report = buildInboxReport(
    observations,
    meetings,
    analysis,
    health,
    new Date(generatedAt),
  );
  const text = renderInboxReport(report);

  const urgentAt = text.indexOf("Срочно");
  const replyAt = text.indexOf("Нужен ответ");
  const meetingsAt = text.indexOf("Встречи");
  const infoAt = text.indexOf("Информация");
  assert.ok(
    urgentAt >= 0 &&
      urgentAt < replyAt &&
      replyAt < meetingsAt &&
      meetingsAt < infoAt,
  );
  assert.match(text, /Gmail message urgent/u);
  assert.match(text, /Предложение ответа/u);
  assert.doesNotMatch(text, /IGNORABLE SECRET BODY/u);
  assert.match(text, /Игнорируемых: 1/u);
  assert.equal(report.partial, true);
  assert.equal(report.informationalCount, 2);
});

test("private envelope accepts only the authenticated owner target", () => {
  const report = buildInboxReport(
    observations,
    meetings,
    analysis,
    health,
    new Date(generatedAt),
  );
  const envelope = createPrivateInboxEnvelope(report, "7", "7");
  assert.equal(envelope.chatKind, "private");
  assert.equal(envelope.targetChatId, "7");
  assert.equal(envelope.generatedAt, generatedAt);
  assert.throws(
    () => createPrivateInboxEnvelope(report, "7", "8"),
    /unified_inbox_report_owner_mismatch/u,
  );
});

test("renderer remains within the private-bot envelope bound", () => {
  const many = Array.from({ length: 150 }, (_, index) =>
    message(
      `m-${index}-${"e".repeat(450)}`,
      `Message ${index} ${"t".repeat(480)}`,
      "x".repeat(4_000),
    ),
  );
  const manyAnalysis = InboxAnalysisSchema.parse({
    schemaVersion: 1,
    decisions: many.map((item) => ({
      observationId: item.id,
      category: "urgent",
      rationale: "r".repeat(1_000),
      evidenceIds: [item.id],
    })),
    meetingBriefs: [],
    draftProposals: [],
  });
  const report = buildInboxReport(
    many,
    [],
    manyAnalysis,
    [
      {
        source: "gmail",
        status: "failed",
        collected: 0,
        errorCode: "unified_inbox_source_failed",
      },
    ],
    new Date(generatedAt),
  );
  const text = renderInboxReport(report);
  assert.ok([...text].length <= 12_000);
  assert.match(text, /⚠️ Источники/u);
  assert.match(text, /unified_inbox_source_failed/u);
  for (const line of text
    .split("\n")
    .filter((value) => value.startsWith("• Message"))) {
    assert.match(line, /\]$/u);
  }
  const renderedUrgent = text
    .split("\n")
    .filter((value) => value.startsWith("• Message")).length;
  const omitted = Number(/Ещё элементов: (\d+)/u.exec(text)?.[1]);
  assert.equal(report.urgentCount, 150);
  assert.equal(report.categories.urgent.length, 100);
  assert.equal(renderedUrgent + omitted, report.urgentCount);
  assert.doesNotThrow(() => createPrivateInboxEnvelope(report, "7", "7"));
});

test("maximum bounded meeting always renders its identity and locator", () => {
  const longEvent = InboxObservationSchema.parse({
    ...event,
    title: "M".repeat(500),
    evidence: { ...event.evidence, locator: `Calendar ${"c".repeat(491)}` },
  });
  const related = InboxObservationSchema.parse({
    ...needsReply,
    evidence: {
      ...needsReply.evidence,
      locator: `Gmail ${"g".repeat(494)}`,
    },
  });
  const longAnalysis = InboxAnalysisSchema.parse({
    schemaVersion: 1,
    decisions: [],
    meetingBriefs: [
      {
        eventObservationId: longEvent.id,
        summary: "s".repeat(2_000),
        preparationPoints: Array.from({ length: 10 }, () => "p".repeat(500)),
        openQuestions: Array.from({ length: 10 }, () => "q".repeat(500)),
        evidenceIds: [longEvent.id, related.id],
      },
    ],
    draftProposals: [],
  });
  const report = buildInboxReport(
    [longEvent, related],
    [
      {
        eventObservationId: longEvent.id,
        participantKeys: [],
        relatedObservationIds: [related.id],
        relationshipContext: [],
      },
    ],
    longAnalysis,
    [],
    new Date(generatedAt),
  );
  const text = renderInboxReport(report);

  assert.match(text, /• M{20,}/u);
  assert.match(text, /\[Calendar c+; Gmail g+\]/u);
  assert.ok([...text].length <= 12_000);
});
