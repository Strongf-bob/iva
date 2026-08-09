import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { streamObject, type LanguageModel } from "ai";
import { ZodError } from "zod";

import { createTextModel } from "../../agent/provider.ts";
import {
  InboxAnalysisSchema,
  type InboxAnalysis,
  type InboxClassifier,
  type InboxClassifierInput,
  type InboxObservation,
  type MeetingContext,
} from "./types.ts";

interface StreamObjectInput {
  model: LanguageModel;
  schema: typeof InboxAnalysisSchema;
  system: string;
  prompt: string;
}

interface StreamObjectResultLike {
  object: PromiseLike<unknown>;
}

type StreamObjectImpl = (input: StreamObjectInput) => StreamObjectResultLike;

export interface StructuredClassifierInput extends InboxClassifierInput {
  skillText: string;
}

export interface StructuredClassifierDependencies {
  model?: LanguageModel;
  streamObjectImpl?: StreamObjectImpl;
}

const runStreamObject: StreamObjectImpl = (input) => streamObject(input);

export function unifiedInboxSkillPath(): string {
  return fileURLToPath(
    new URL("../../agent/skills/unified-inbox/SKILL.md", import.meta.url),
  );
}

export async function analyzeInboxStructured(
  input: StructuredClassifierInput,
  dependencies: StructuredClassifierDependencies = {},
): Promise<InboxAnalysis> {
  const observations = input.observations.map((observation) =>
    structuredClone(observation),
  );
  const meetings = input.meetings.map((meeting) => structuredClone(meeting));
  const result = (dependencies.streamObjectImpl ?? runStreamObject)({
    model: dependencies.model ?? createTextModel(),
    schema: InboxAnalysisSchema,
    system: input.skillText,
    prompt: JSON.stringify({ observations, meetings }),
  });
  return InboxAnalysisSchema.parse(await result.object);
}

function assertKnownEvidence(
  evidenceIds: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  for (const evidenceId of evidenceIds) {
    if (!allowed.has(evidenceId)) {
      throw new Error("unified_inbox_analysis_unknown_evidence");
    }
  }
}

function exactSet(
  values: readonly string[],
  expected: ReadonlySet<string>,
): boolean {
  return (
    values.length === expected.size &&
    values.every((value) => expected.has(value))
  );
}

export function validateInboxAnalysis(
  rawAnalysis: unknown,
  observations: readonly InboxObservation[],
  meetings: readonly MeetingContext[],
): InboxAnalysis {
  const analysis = InboxAnalysisSchema.parse(rawAnalysis);
  const observationsById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  const allowedEvidence = new Set(observationsById.keys());
  const expectedDecisionIds = new Set(observationsById.keys());
  const decisionIds = analysis.decisions.map(
    (decision) => decision.observationId,
  );
  if (!exactSet(decisionIds, expectedDecisionIds)) {
    throw new Error("unified_inbox_analysis_incomplete");
  }

  const decisionsById = new Map(
    analysis.decisions.map((decision) => [decision.observationId, decision]),
  );
  for (const decision of analysis.decisions) {
    assertKnownEvidence(decision.evidenceIds, allowedEvidence);
    if (!decision.evidenceIds.includes(decision.observationId)) {
      throw new Error("unified_inbox_analysis_missing_primary_evidence");
    }
  }

  const meetingsByEventId = new Map(
    meetings.map((meeting) => [meeting.eventObservationId, meeting]),
  );
  const expectedMeetingIds = new Set(meetingsByEventId.keys());
  if (
    !exactSet(
      analysis.meetingBriefs.map((brief) => brief.eventObservationId),
      expectedMeetingIds,
    )
  ) {
    throw new Error("unified_inbox_analysis_incomplete");
  }
  for (const brief of analysis.meetingBriefs) {
    const meeting = meetingsByEventId.get(brief.eventObservationId);
    if (!meeting) throw new Error("unified_inbox_analysis_unknown_meeting");
    const meetingEvidence = new Set([
      meeting.eventObservationId,
      ...meeting.relatedObservationIds,
      ...meeting.relationshipContext.flatMap(
        (context) => context.evidenceObservationIds,
      ),
    ]);
    assertKnownEvidence(brief.evidenceIds, allowedEvidence);
    assertKnownEvidence(brief.evidenceIds, meetingEvidence);
    if (!brief.evidenceIds.includes(brief.eventObservationId)) {
      throw new Error("unified_inbox_analysis_missing_primary_evidence");
    }
  }

  for (const draft of analysis.draftProposals) {
    const observation = observationsById.get(draft.messageObservationId);
    const decision = decisionsById.get(draft.messageObservationId);
    const actionable =
      decision?.category === "urgent" || decision?.category === "needs_reply";
    if (
      observation?.source !== "gmail" ||
      observation.kind !== "message" ||
      observation.actor?.address === undefined ||
      observation.actor.address.toLowerCase() !== draft.to.toLowerCase() ||
      !actionable
    ) {
      throw new Error("unified_inbox_analysis_invalid_draft");
    }
    assertKnownEvidence(draft.evidenceIds, allowedEvidence);
    if (!draft.evidenceIds.includes(draft.messageObservationId)) {
      throw new Error("unified_inbox_analysis_invalid_draft");
    }
  }
  return analysis;
}

function malformedStructuredOutput(error: unknown): boolean {
  return (
    error instanceof ZodError ||
    (error instanceof Error && error.name === "AI_NoObjectGeneratedError")
  );
}

export interface ModelInboxClassifierOptions {
  readSkillText?: (path: string) => Promise<string>;
  analyzeStructuredImpl?: (
    input: StructuredClassifierInput,
  ) => Promise<InboxAnalysis>;
}

export function createModelInboxClassifier({
  readSkillText = (path) => readFile(path, "utf8"),
  analyzeStructuredImpl = analyzeInboxStructured,
}: ModelInboxClassifierOptions = {}): InboxClassifier {
  return {
    async analyze(input) {
      const skillText = await readSkillText(unifiedInboxSkillPath());
      let raw: InboxAnalysis;
      try {
        raw = await analyzeStructuredImpl({ ...input, skillText });
      } catch (error) {
        if (!malformedStructuredOutput(error)) throw error;
        raw = await analyzeStructuredImpl({ ...input, skillText });
      }
      return validateInboxAnalysis(raw, input.observations, input.meetings);
    },
  };
}
