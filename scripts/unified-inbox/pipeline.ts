import { createHash } from "node:crypto";

import { validateInboxAnalysis } from "./classifier.ts";
import {
  EmptyRelationshipContextProvider,
  buildMeetingContexts,
} from "./meeting-prep.ts";
import { buildInboxReport, createPrivateInboxEnvelope } from "./report.ts";
import {
  loadInboxState,
  recordClassifications,
  recordSourceFailure,
  recordSourceSuccess,
  recordSuccessfulReport,
  reduceObservationPage,
  saveInboxState,
  selectReportingObservations,
  withInboxLock,
  type InboxStatePaths,
} from "./state.ts";
import {
  OwnerIdSchema,
  observationFingerprint,
  type InboxClassifier,
  type InboxReport,
  type InboxSource,
  type PrivateInboxReportEnvelope,
  type RelationshipContextProvider,
  type SourceRunHealth,
} from "./types.ts";

const FATAL_SOURCE_ERRORS = new Set([
  "telegram_analysis_authorization_lost",
  "unified_inbox_cursor_regression",
  "unified_inbox_owner_identity_mismatch",
  "unified_inbox_owner_mismatch",
  "unified_inbox_owner_only",
  "unified_inbox_state_invalid",
  "unified_inbox_telegram_cursor_invalid",
  "unified_inbox_telegram_requires_read_only",
]);

export function isFatalInboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    FATAL_SOURCE_ERRORS.has(message) ||
    /^unified_inbox_(analysis|relationship|report)_[a-z0-9_]+$/u.test(message)
  );
}

function sanitizedSourceError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^unified_inbox_[a-z0-9_]+$/u.test(message)
    ? message
    : "unified_inbox_source_failed";
}

function reportDigest(report: InboxReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

export interface RunUnifiedInboxOptions {
  paths: InboxStatePaths;
  ownerId: string;
  targetChatId: string;
  now?: Date;
  sources: InboxSource[];
  classifier: InboxClassifier;
  relationships?: RelationshipContextProvider;
}

export interface UnifiedInboxResult {
  report: InboxReport;
  envelope: PrivateInboxReportEnvelope;
  sourceHealth: SourceRunHealth[];
  collected: {
    newObservations: number;
    totalObservations: number;
  };
}

export async function runUnifiedInbox({
  paths,
  ownerId: rawOwnerId,
  targetChatId,
  now = new Date(),
  sources,
  classifier,
  relationships = new EmptyRelationshipContextProvider(),
}: RunUnifiedInboxOptions): Promise<UnifiedInboxResult> {
  const ownerId = OwnerIdSchema.parse(rawOwnerId);
  if (paths.ownerId !== ownerId) {
    throw new Error("unified_inbox_owner_mismatch");
  }
  const sourceNames = sources.map((source) => source.source);
  if (new Set(sourceNames).size !== sourceNames.length) {
    throw new Error("unified_inbox_duplicate_source");
  }

  return withInboxLock(paths, async () => {
    let state = await loadInboxState(paths);
    const sourceHealth: SourceRunHealth[] = [];
    let newObservations = 0;

    for (const source of sources) {
      let sourceCollected = 0;
      try {
        for await (const page of source.collect({
          cursors: state.cursors,
          now: now.toISOString(),
        })) {
          const priorFingerprints = new Set(state.processedFingerprints);
          const newPageFingerprints = new Set(
            page.observations
              .map((observation) => observationFingerprint(observation))
              .filter((fingerprint) => !priorFingerprints.has(fingerprint)),
          );
          state = reduceObservationPage(state, page, now);
          await saveInboxState(paths, state);
          sourceCollected += newPageFingerprints.size;
          newObservations += newPageFingerprints.size;
        }
        state = recordSourceSuccess(state, source.source, sourceCollected, now);
        await saveInboxState(paths, state);
        sourceHealth.push({
          source: source.source,
          status: "ok",
          collected: sourceCollected,
          errorCode: null,
        });
      } catch (error) {
        if (isFatalInboxError(error)) throw error;
        state = recordSourceFailure(state, source.source, error, now);
        await saveInboxState(paths, state);
        sourceHealth.push({
          source: source.source,
          status: "failed",
          collected: sourceCollected,
          errorCode: sanitizedSourceError(error),
        });
      }
    }

    const observations = selectReportingObservations(state, now);
    const meetings = await buildMeetingContexts(
      observations,
      relationships,
      now,
    );
    const analysis = validateInboxAnalysis(
      await classifier.analyze({ observations, meetings }),
      observations,
      meetings,
    );
    const report = buildInboxReport(
      observations,
      meetings,
      analysis,
      sourceHealth,
      now,
    );
    const envelope = createPrivateInboxEnvelope(report, ownerId, targetChatId);
    state = recordClassifications(
      state,
      Object.fromEntries(
        analysis.decisions.map((decision) => [
          decision.observationId,
          decision.category,
        ]),
      ),
    );
    state = recordSuccessfulReport(state, report, reportDigest(report));
    await saveInboxState(paths, state);

    return {
      report,
      envelope,
      sourceHealth,
      collected: {
        newObservations,
        totalObservations: Object.keys(state.observations).length,
      },
    };
  });
}
