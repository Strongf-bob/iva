import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import { quarantinePath } from "../lib/wf-store.ts";
import {
  InboxCategorySchema,
  InboxObservationSchema,
  InboxSourceNameSchema,
  ObservationPageSchema,
  OwnerIdSchema,
  SourceCursorSchema,
  observationFingerprint,
  type InboxCategory,
  type InboxObservation,
  type InboxReport,
  type InboxSourceName,
  type ObservationPage,
  type SourceCursor,
} from "./types.ts";

const MAX_FINGERPRINTS = 10_000;
const DEFAULT_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const SourceHealthStateSchema = z.strictObject({
  status: z.enum(["ok", "failed"]),
  collected: z.int().nonnegative(),
  checkedAt: z.iso.datetime({ offset: true }),
  errorCode: z
    .string()
    .regex(/^[a-z0-9_]+$/u)
    .nullable(),
});
export type SourceHealthState = z.infer<typeof SourceHealthStateSchema>;

const LastReportMetadataSchema = z.strictObject({
  generatedAt: z.iso.datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  urgent: z.int().nonnegative(),
  needsReply: z.int().nonnegative(),
  meetings: z.int().nonnegative(),
  partial: z.boolean(),
});
export type LastReportMetadata = z.infer<typeof LastReportMetadataSchema>;

export const InboxStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ownerId: OwnerIdSchema,
    cursors: z.record(z.string(), SourceCursorSchema),
    observations: z.record(z.string(), InboxObservationSchema),
    processedFingerprints: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(MAX_FINGERPRINTS),
    classifications: z.record(z.string(), InboxCategorySchema),
    sourceHealth: z.record(z.string(), SourceHealthStateSchema),
    lastReport: LastReportMetadataSchema.nullable(),
  })
  .superRefine((state, context) => {
    for (const [key, cursor] of Object.entries(state.cursors)) {
      if (key !== cursor.key) {
        context.addIssue({
          code: "custom",
          message: "cursor record key mismatch",
          path: ["cursors", key],
        });
      }
    }
    for (const [key, observation] of Object.entries(state.observations)) {
      if (key !== observation.id) {
        context.addIssue({
          code: "custom",
          message: "observation record key mismatch",
          path: ["observations", key],
        });
      }
    }
    if (
      new Set(state.processedFingerprints).size !==
      state.processedFingerprints.length
    ) {
      context.addIssue({
        code: "custom",
        message: "processed fingerprints must be unique",
        path: ["processedFingerprints"],
      });
    }
  });
export type InboxState = z.infer<typeof InboxStateSchema>;

export interface InboxStatePaths {
  ownerId: string;
  dataRoot: string;
  baseDir: string;
  ownerDir: string;
  stateFile: string;
  lockFile: string;
}

export function inboxStatePaths(
  root: string,
  dataDir: string,
  ownerId: string,
): InboxStatePaths {
  const parsedOwnerId = OwnerIdSchema.parse(ownerId);
  const resolvedRoot = resolve(root);
  const dataRoot = isAbsolute(dataDir)
    ? resolve(dataDir)
    : resolve(resolvedRoot, dataDir);
  const baseDir = join(dataRoot, "unified-inbox");
  const ownerDir = join(baseDir, `owner-${parsedOwnerId}`);
  return {
    ownerId: parsedOwnerId,
    dataRoot,
    baseDir,
    ownerDir,
    stateFile: join(ownerDir, "state.json"),
    lockFile: join(ownerDir, "pipeline.lock"),
  };
}

function emptyState(ownerId: string): InboxState {
  return {
    schemaVersion: 1,
    ownerId,
    cursors: {},
    observations: {},
    processedFingerprints: [],
    classifications: {},
    sourceHealth: {},
    lastReport: null,
  };
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function rejectExistingSymlinks(paths: InboxStatePaths): Promise<void> {
  for (const path of [
    paths.dataRoot,
    paths.baseDir,
    paths.ownerDir,
    paths.stateFile,
    paths.lockFile,
  ]) {
    const info = await pathInfo(path);
    if (info?.isSymbolicLink()) {
      throw new Error(
        `unified inbox path must not be a symbolic link: ${path}`,
      );
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const before = await pathInfo(path);
  if (before?.isSymbolicLink()) {
    throw new Error(
      `unified inbox directory must not be a symbolic link: ${path}`,
    );
  }
  if (before && !before.isDirectory()) {
    throw new Error(`unified inbox private path is not a directory: ${path}`);
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error(`unified inbox private path is not a directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function ensurePrivatePaths(paths: InboxStatePaths): Promise<void> {
  await rejectExistingSymlinks(paths);
  await ensurePrivateDirectory(paths.dataRoot);
  await ensurePrivateDirectory(paths.baseDir);
  await ensurePrivateDirectory(paths.ownerDir);
  await rejectExistingSymlinks(paths);
}

export async function loadInboxState(
  paths: InboxStatePaths,
): Promise<InboxState> {
  await rejectExistingSymlinks(paths);
  let raw: unknown;
  try {
    raw = await loadJsonStrict<unknown>(
      paths.stateFile,
      emptyState(paths.ownerId),
    );
  } catch {
    throw new Error("unified_inbox_state_invalid");
  }
  const parsed = InboxStateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.ownerId !== paths.ownerId) {
    quarantinePath(
      paths.stateFile,
      `schema-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    );
    throw new Error("unified_inbox_state_invalid");
  }
  return parsed.data;
}

export async function saveInboxState(
  paths: InboxStatePaths,
  state: InboxState,
): Promise<void> {
  const parsed = InboxStateSchema.parse(state);
  if (parsed.ownerId !== paths.ownerId) {
    throw new Error("unified_inbox_owner_mismatch");
  }
  await ensurePrivatePaths(paths);
  await saveJsonAtomic(paths.stateFile, parsed);
  await chmod(paths.stateFile, 0o600);
}

function updateCursor(
  cursors: Record<string, SourceCursor>,
  next: SourceCursor,
): void {
  const prior = cursors[next.key];
  if (
    prior &&
    (next.order < prior.order ||
      (next.order === prior.order && next.value !== prior.value))
  ) {
    throw new Error("unified_inbox_cursor_regression");
  }
  cursors[next.key] = next;
}

export function reduceObservationPage(
  current: InboxState,
  rawPage: ObservationPage,
  checkedAt = new Date(),
): InboxState {
  const state = structuredClone(InboxStateSchema.parse(current));
  const page = ObservationPageSchema.parse(rawPage);
  updateCursor(state.cursors, page.cursor);

  const processed = new Set(state.processedFingerprints);
  let collected = 0;
  for (const observation of page.observations) {
    const fingerprint = observationFingerprint(observation);
    if (processed.has(fingerprint)) continue;
    state.observations[observation.id] = observation;
    processed.add(fingerprint);
    collected += 1;
  }
  state.processedFingerprints = [...processed].slice(-MAX_FINGERPRINTS);
  state.sourceHealth[page.source] = {
    status: "ok",
    collected,
    checkedAt: checkedAt.toISOString(),
    errorCode: null,
  };
  return InboxStateSchema.parse(state);
}

function sanitizedSourceError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^unified_inbox_[a-z0-9_]+$/u.test(message)
    ? message
    : "unified_inbox_source_failed";
}

export function recordSourceFailure(
  current: InboxState,
  source: InboxSourceName,
  error: unknown,
  checkedAt = new Date(),
): InboxState {
  const state = structuredClone(InboxStateSchema.parse(current));
  const parsedSource = InboxSourceNameSchema.parse(source);
  state.sourceHealth[parsedSource] = {
    status: "failed",
    collected: 0,
    checkedAt: checkedAt.toISOString(),
    errorCode: sanitizedSourceError(error),
  };
  return InboxStateSchema.parse(state);
}

export function selectReportingObservations(
  current: InboxState,
  now = new Date(),
  windowMs = DEFAULT_REPORT_WINDOW_MS,
): InboxObservation[] {
  const state = InboxStateSchema.parse(current);
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new TypeError("report window must be a safe positive integer");
  }
  const cutoff = now.getTime() - windowMs;
  return Object.values(state.observations)
    .filter((observation) => Date.parse(observation.occurredAt) >= cutoff)
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
}

export function recordClassifications(
  current: InboxState,
  classifications: Readonly<Record<string, InboxCategory>>,
): InboxState {
  const state = structuredClone(InboxStateSchema.parse(current));
  for (const [observationId, category] of Object.entries(classifications)) {
    if (state.observations[observationId] === undefined) {
      throw new Error("unified_inbox_unknown_classification");
    }
    state.classifications[observationId] = InboxCategorySchema.parse(category);
  }
  return InboxStateSchema.parse(state);
}

export function recordSuccessfulReport(
  current: InboxState,
  report: InboxReport,
  digest: string,
): InboxState {
  const state = structuredClone(InboxStateSchema.parse(current));
  state.lastReport = LastReportMetadataSchema.parse({
    generatedAt: report.generatedAt,
    digest,
    urgent: report.categories.urgent.length,
    needsReply: report.categories.needsReply.length,
    meetings: report.meetings.length,
    partial: report.partial,
  });
  return InboxStateSchema.parse(state);
}

export async function withInboxLock<T>(
  paths: InboxStatePaths,
  operation: () => Promise<T> | T,
): Promise<T> {
  await ensurePrivatePaths(paths);
  const token = await acquireLock(paths.lockFile);
  try {
    return await operation();
  } finally {
    releaseLock(paths.lockFile, token);
  }
}
