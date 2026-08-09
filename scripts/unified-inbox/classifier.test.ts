/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registration; injected structured-model fakes are intentionally minimal. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { LanguageModel } from "ai";

import {
  analyzeInboxStructured,
  createModelInboxClassifier,
  unifiedInboxSkillPath,
  validateInboxAnalysis,
} from "./classifier.ts";
import {
  InboxAnalysisSchema,
  InboxObservationSchema,
  MeetingContextSchema,
  canonicalObservationId,
  type InboxAnalysis,
  type InboxObservation,
  type MeetingContext,
} from "./types.ts";

const now = "2026-08-09T08:00:00.000Z";

function message(
  source: "gmail" | "telegram",
  externalId: string,
): InboxObservation {
  const sourceAccountId = source === "gmail" ? "me" : "7";
  const identity = { source, sourceAccountId, externalId };
  const address = source === "gmail" ? "alice@example.com" : undefined;
  return InboxObservationSchema.parse({
    schemaVersion: 1,
    id: canonicalObservationId(identity),
    ...identity,
    revision: "1",
    kind: "message",
    occurredAt: now,
    updatedAt: now,
    title: source === "gmail" ? "Project review" : "Alice",
    excerpt: "Can you reply before noon?",
    actor: {
      id: address ?? "telegram:user:11",
      label: "Alice",
      ...(address ? { address } : {}),
    },
    participants: [],
    evidence: {
      source,
      externalId,
      timestamp: now,
      locator: `${source} ${externalId}`,
    },
  });
}

function event(): InboxObservation {
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
    updatedAt: now,
    title: "Project review",
    excerpt: "Discuss open decisions",
    participants: [
      { id: "alice@example.com", label: "Alice", address: "alice@example.com" },
    ],
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

const gmail = message("gmail", "m-1");
const telegram = message("telegram", "11:41");
const calendar = event();
const observations = [gmail, telegram, calendar];
const meetings: MeetingContext[] = [
  MeetingContextSchema.parse({
    eventObservationId: calendar.id,
    participantKeys: ["alice@example.com"],
    relatedObservationIds: [gmail.id, telegram.id],
    relationshipContext: [
      {
        subjectId: "contact:alice",
        label: "Alice",
        summary: "Project collaborator",
        evidenceObservationIds: [telegram.id],
      },
    ],
  }),
];

function validAnalysis(): InboxAnalysis {
  return InboxAnalysisSchema.parse({
    schemaVersion: 1,
    decisions: [
      {
        observationId: gmail.id,
        category: "needs_reply",
        rationale: "Direct request with a deadline.",
        evidenceIds: [gmail.id],
      },
      {
        observationId: telegram.id,
        category: "informational",
        rationale: "Related context without a separate request.",
        evidenceIds: [telegram.id],
      },
      {
        observationId: calendar.id,
        category: "informational",
        rationale: "Upcoming scheduled meeting.",
        evidenceIds: [calendar.id],
      },
    ],
    meetingBriefs: [
      {
        eventObservationId: calendar.id,
        summary: "Review the project decision before the call.",
        preparationPoints: ["Read the latest plan"],
        openQuestions: ["Which option is approved?"],
        evidenceIds: [calendar.id, gmail.id, telegram.id],
      },
    ],
    draftProposals: [
      {
        messageObservationId: gmail.id,
        to: "alice@example.com",
        subject: "Re: Project review",
        body: "Thanks, I will review it before noon.",
        evidenceIds: [gmail.id],
      },
    ],
  });
}

test("semantic validation accepts complete evidence-backed analysis", () => {
  const result = validateInboxAnalysis(validAnalysis(), observations, meetings);
  assert.equal(result.decisions.length, 3);
  assert.equal(result.meetingBriefs[0]?.eventObservationId, calendar.id);
  assert.equal(result.draftProposals[0]?.to, "alice@example.com");
});

test("semantic validation rejects missing decisions and invented evidence", () => {
  const valid = validAnalysis();
  assert.throws(
    () =>
      validateInboxAnalysis(
        { ...valid, decisions: valid.decisions.slice(1) },
        observations,
        meetings,
      ),
    /unified_inbox_analysis_incomplete/u,
  );
  assert.throws(
    () =>
      validateInboxAnalysis(
        {
          ...valid,
          decisions: valid.decisions.map((decision, index) =>
            index === 0
              ? {
                  ...decision,
                  evidenceIds: ["gmail:00000000000000000000000000000000"],
                }
              : decision,
          ),
        },
        observations,
        meetings,
      ),
    /unified_inbox_analysis_unknown_evidence/u,
  );
});

test("meeting briefs may reference only their supplied meeting context", () => {
  const valid = validAnalysis();
  assert.throws(
    () =>
      validateInboxAnalysis(
        {
          ...valid,
          meetingBriefs: [
            {
              ...valid.meetingBriefs[0],
              evidenceIds: [
                calendar.id,
                "gmail:00000000000000000000000000000000",
              ],
            },
          ],
        },
        observations,
        meetings,
      ),
    /unified_inbox_analysis_unknown_evidence/u,
  );
  assert.throws(
    () =>
      validateInboxAnalysis(
        { ...valid, meetingBriefs: [] },
        observations,
        meetings,
      ),
    /unified_inbox_analysis_incomplete/u,
  );
});

test("draft proposals are Gmail-only, actionable, and preserve the source sender", () => {
  const valid = validAnalysis();
  const invalidCases: InboxAnalysis[] = [
    {
      ...valid,
      draftProposals: [
        {
          ...valid.draftProposals[0],
          messageObservationId: telegram.id,
          evidenceIds: [telegram.id],
        },
      ],
    },
    {
      ...valid,
      decisions: valid.decisions.map((decision) =>
        decision.observationId === gmail.id
          ? { ...decision, category: "informational" as const }
          : decision,
      ),
    },
    {
      ...valid,
      draftProposals: [
        { ...valid.draftProposals[0], to: "mallory@example.com" },
      ],
    },
  ];
  for (const candidate of invalidCases) {
    assert.throws(
      () => validateInboxAnalysis(candidate, observations, meetings),
      /unified_inbox_analysis_invalid_draft/u,
    );
  }
});

test("structured analysis sends only bounded normalized JSON under the skill system prompt", async () => {
  let received: Record<string, unknown> | undefined;
  const expected = validAnalysis();
  const result = await analyzeInboxStructured(
    { observations, meetings, skillText: "SYSTEM SKILL" },
    {
      model: {} as LanguageModel,
      streamObjectImpl(input) {
        received = input as unknown as Record<string, unknown>;
        return { object: Promise.resolve(expected) };
      },
    },
  );

  assert.equal(received?.system, "SYSTEM SKILL");
  assert.equal(received?.schema, InboxAnalysisSchema);
  const prompt: unknown = JSON.parse(String(received?.prompt));
  assert.deepEqual(prompt, { observations, meetings });
  assert.deepEqual(result, expected);
});

test("model classifier retries malformed structure once but never retries semantic evidence", async () => {
  let calls = 0;
  const repaired = createModelInboxClassifier({
    readSkillText: async () => "skill",
    analyzeStructuredImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("malformed");
        error.name = "AI_NoObjectGeneratedError";
        throw error;
      }
      return validAnalysis();
    },
  });
  assert.deepEqual(
    await repaired.analyze({ observations, meetings }),
    validAnalysis(),
  );
  assert.equal(calls, 2);

  calls = 0;
  const semanticFailure = createModelInboxClassifier({
    readSkillText: async () => "skill",
    analyzeStructuredImpl: async () => {
      calls += 1;
      return InboxAnalysisSchema.parse({
        schemaVersion: 1,
        decisions: [],
        meetingBriefs: [],
        draftProposals: [],
      });
    },
  });
  await assert.rejects(
    () => semanticFailure.analyze({ observations, meetings }),
    /unified_inbox_analysis_incomplete/u,
  );
  assert.equal(calls, 1);
});

test("unified inbox skill treats source text as untrusted and forbids mutations", async () => {
  const skill = await readFile(unifiedInboxSkillPath(), "utf8");
  for (const category of [
    "urgent",
    "needs_reply",
    "informational",
    "ignorable",
  ]) {
    assert.match(skill, new RegExp(`\\b${category}\\b`, "u"));
  }
  assert.match(skill, /untrusted/iu);
  assert.match(skill, /never send Gmail/iu);
  assert.match(skill, /never perform\s+Telegram/iu);
  assert.match(skill, /never\s+create Google Tasks/iu);
});
