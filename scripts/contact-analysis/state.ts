import { chmod, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import { quarantinePath } from "../lib/wf-store.ts";
import { ChatKindSchema } from "./types.ts";

const JobStateSchema = z.strictObject({
  chatId: z.int().refine((value) => value !== 0),
  kind: ChatKindSchema,
  title: z.string().min(1).max(500),
  committedThrough: z.int().nonnegative(),
  contextSummary: z.string().max(4000),
  skippedMessages: z.int().nonnegative().default(0),
  status: z.enum(["ready", "running", "retry", "complete"]),
  attempts: z.int().nonnegative(),
  lastErrorCode: z.string().min(1).max(100).nullable(),
});
export type ContactAnalysisJob = z.infer<typeof JobStateSchema>;

export const ContactAnalysisStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountUserId: z.int().positive(),
  jobs: z.record(z.string().regex(/^-?[1-9]\d*$/u), JobStateSchema),
});
export type ContactAnalysisState = z.infer<typeof ContactAnalysisStateSchema>;

export interface ContactAnalysisStatePaths {
  accountUserId: number;
  baseDir: string;
  accountDir: string;
  jobsDir: string;
  stateFile: string;
  lockFile: string;
}

export function statePaths(
  root: string,
  dataDir: string,
  accountUserId: number,
): ContactAnalysisStatePaths {
  if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) {
    throw new TypeError("accountUserId must be a safe positive integer");
  }
  const baseDir = resolve(root, dataDir, "contact-analysis");
  const accountDir = join(baseDir, `telegram-user-${accountUserId}`);
  return {
    accountUserId,
    baseDir,
    accountDir,
    jobsDir: join(accountDir, "jobs"),
    stateFile: join(accountDir, "state.json"),
    lockFile: join(accountDir, "pipeline.lock"),
  };
}

function emptyState(accountUserId: number): ContactAnalysisState {
  return { schemaVersion: 1, accountUserId, jobs: {} };
}

function quarantineInvalidState(paths: ContactAnalysisStatePaths): void {
  const stamp = `schema-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  quarantinePath(paths.stateFile, stamp);
}

export async function loadState(
  paths: ContactAnalysisStatePaths,
): Promise<ContactAnalysisState> {
  const fallback = emptyState(paths.accountUserId);
  const raw = await loadJsonStrict<unknown>(paths.stateFile, fallback);
  const parsed = ContactAnalysisStateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.accountUserId !== paths.accountUserId) {
    quarantineInvalidState(paths);
    throw new Error("contact analysis state schema validation failed");
  }
  return parsed.data;
}

async function ensurePrivateDirectories(
  paths: ContactAnalysisStatePaths,
): Promise<void> {
  await mkdir(paths.accountDir, { recursive: true, mode: 0o700 });
  await chmod(paths.accountDir, 0o700);
  await mkdir(paths.jobsDir, { recursive: true, mode: 0o700 });
  await chmod(paths.jobsDir, 0o700);
}

export async function saveState(
  paths: ContactAnalysisStatePaths,
  state: ContactAnalysisState,
): Promise<void> {
  const parsed = ContactAnalysisStateSchema.parse(state);
  if (parsed.accountUserId !== paths.accountUserId) {
    throw new Error("contact analysis state account mismatch");
  }
  await ensurePrivateDirectories(paths);
  await saveJsonAtomic(paths.stateFile, parsed);
  await chmod(paths.stateFile, 0o600);
}

export async function withPipelineLock<T>(
  paths: ContactAnalysisStatePaths,
  operation: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDirectories(paths);
  const token = await acquireLock(paths.lockFile);
  try {
    return await operation();
  } finally {
    releaseLock(paths.lockFile, token);
  }
}
