/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalysisBatchSchema,
  ClarificationQuestionSchema,
  ObservationPredicateSchema,
  ObservationSchema,
  TelegramDialogSchema,
  TelegramMessageSchema,
  canonicalChatId,
  canonicalMessageId,
  canonicalUserId,
} from "./types.ts";

const evidence = [
  {
    chatId: -1001,
    messageId: 9,
    timestamp: "2026-08-07T00:00:00Z",
  },
];

test("canonical Telegram IDs preserve numeric identity", () => {
  assert.equal(canonicalUserId(44), "telegram:user:44");
  assert.equal(canonicalChatId(-1001), "telegram:chat:-1001");
  assert.equal(canonicalMessageId(-1001, 9), "telegram:message:-1001:9");

  assert.throws(() => canonicalUserId(Number.NaN), /safe non-zero integer/u);
  assert.throws(() => canonicalChatId(0), /safe non-zero integer/u);
  assert.throws(() => canonicalMessageId(-1001, -1), /safe positive integer/u);
});

test("Telegram transport schemas are strict and bounded", () => {
  assert.equal(
    TelegramDialogSchema.safeParse({
      id: -1001,
      kind: "group",
      title: "Team",
      username: null,
    }).success,
    true,
  );
  assert.equal(
    TelegramMessageSchema.safeParse({
      id: 9,
      senderId: 44,
      timestamp: "2026-08-07T00:00:00Z",
      text: "hello",
      replyToMessageId: null,
      mentionedUserIds: [7],
      mentionedUsernames: ["owner"],
      mediaKind: null,
      unexpected: true,
    }).success,
    false,
  );
});

test("observation predicates are an exact allowlist", () => {
  assert.deepEqual(ObservationPredicateSchema.options, [
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
    "city",
    "timezone",
    "phone",
    "email",
    "education",
    "employer",
    "interest",
    "important_date",
    "gift_idea",
    "interesting_fact",
  ]);
  assert.equal(
    ObservationPredicateSchema.safeParse("diagnosis").success,
    false,
  );
});

test("relationship observations carry only predicate-specific metadata", () => {
  const base = {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    kind: "commitment",
    predicate: "commitment",
    value: "Send the report",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence,
  };
  assert.equal(
    ObservationSchema.safeParse({
      ...base,
      relationship: {
        direction: "owner_to_contact",
        dueAt: "2026-08-10T12:00:00Z",
      },
    }).success,
    true,
  );
  assert.equal(
    ObservationSchema.safeParse({
      ...base,
      predicate: "role",
      relationship: { direction: "unknown", dueAt: null },
    }).success,
    false,
  );
  assert.equal(
    ObservationSchema.safeParse({
      ...base,
      kind: "fact",
      predicate: "birthday",
      value: "--05-17",
      relationship: undefined,
    }).success,
    true,
  );
  for (const invalid of [
    { value: "--02-31", confidence: "EXTRACTED" },
    { value: "2025-02-29", confidence: "EXTRACTED" },
  ]) {
    assert.equal(
      ObservationSchema.safeParse({
        ...base,
        kind: "fact",
        predicate: "birthday",
        relationship: undefined,
        ...invalid,
      }).success,
      false,
    );
  }
  assert.equal(
    ObservationSchema.safeParse({
      ...base,
      kind: "fact",
      predicate: "birthday",
      value: "--05-17",
      confidence: "AMBIGUOUS",
      relationship: undefined,
    }).success,
    true,
  );
});

test("material observations require bounded value or object and evidence", () => {
  const valid = {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    kind: "fact",
    predicate: "role",
    value: "backend developer",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence,
  };

  assert.equal(ObservationSchema.safeParse(valid).success, true);
  assert.equal(
    ObservationSchema.safeParse({ ...valid, predicate: "diagnosis" }).success,
    false,
  );
  assert.equal(
    ObservationSchema.safeParse({ ...valid, evidence: [] }).success,
    false,
  );
  assert.equal(
    ObservationSchema.safeParse({ ...valid, value: "x".repeat(501) }).success,
    false,
  );
  assert.equal(
    ObservationSchema.safeParse({
      ...valid,
      predicate: "member_of",
      value: undefined,
      objectId: "telegram:chat:-1001",
    }).success,
    true,
  );
  assert.equal(
    ObservationSchema.safeParse({
      ...valid,
      objectId: "telegram:chat:-1001",
    }).success,
    false,
  );
});

test("structured background profile values are predicate-validated", () => {
  const base = {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    kind: "fact",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence,
  };
  for (const [predicate, value] of [
    ["birthday", "зимой"],
    ["timezone", "Mars/Olympus"],
    ["email", "not-an-email"],
    ["phone", "позвони маме"],
  ] as const) {
    assert.equal(
      ObservationSchema.safeParse({ ...base, predicate, value }).success,
      false,
    );
  }
  assert.equal(
    ObservationSchema.safeParse({
      ...base,
      predicate: "birthday",
      value: "2004-03-18",
    }).success,
    true,
  );
  assert.equal(
    ObservationSchema.safeParse({
      ...base,
      predicate: "birthday",
      objectId: "telegram:user:55",
    }).success,
    false,
  );
});

test("external owner claims identify the speaker", () => {
  const claim = {
    schemaVersion: 1,
    subjectId: "telegram:user:7",
    kind: "claim",
    predicate: "external_owner_claim",
    value: "prefers written updates",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence,
  };

  assert.equal(ObservationSchema.safeParse(claim).success, false);
  assert.equal(
    ObservationSchema.safeParse({
      ...claim,
      assertedById: "telegram:user:44",
    }).success,
    true,
  );
});

test("clarification questions are bounded and evidence-bound", () => {
  const question = {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    question: "What role does this person have in the Iva project?",
    reason: "The messages mention work but do not state a role.",
    contextChatId: -1001,
    evidence,
  };

  assert.equal(ClarificationQuestionSchema.safeParse(question).success, true);
  assert.equal(
    ClarificationQuestionSchema.safeParse({ ...question, evidence: [] })
      .success,
    false,
  );
  assert.equal(
    ClarificationQuestionSchema.safeParse({
      ...question,
      question: "x".repeat(501),
    }).success,
    false,
  );
});

test("analysis batches cap observations and rolling summaries", () => {
  const observation = {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    kind: "fact",
    predicate: "role",
    value: "developer",
    confidence: "EXTRACTED",
    contextChatId: -1001,
    evidence,
  };

  assert.equal(
    AnalysisBatchSchema.safeParse({
      schemaVersion: 1,
      chatId: -1001,
      rollingSummary: "Prior context",
      observations: [observation],
      questions: [],
    }).success,
    true,
  );
  assert.equal(
    AnalysisBatchSchema.safeParse({
      schemaVersion: 1,
      chatId: -1001,
      rollingSummary: "x".repeat(4001),
      observations: [],
      questions: [],
    }).success,
    false,
  );
  assert.equal(
    AnalysisBatchSchema.safeParse({
      schemaVersion: 1,
      chatId: -1001,
      rollingSummary: "",
      observations: Array.from({ length: 33 }, () => observation),
      questions: [],
    }).success,
    false,
  );
  assert.equal(
    AnalysisBatchSchema.safeParse({
      schemaVersion: 1,
      chatId: -1001,
      rollingSummary: "",
      observations: [],
      questions: Array.from({ length: 17 }, () => ({
        schemaVersion: 1,
        subjectId: "telegram:user:44",
        question: "What is this person's role?",
        reason: "The available messages are ambiguous.",
        contextChatId: -1001,
        evidence,
      })),
    }).success,
    false,
  );
});
