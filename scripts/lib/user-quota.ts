import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import type { TelegramUserId, UserLimits } from "./user-registry.ts";
import type {
  TelegramQueueMessage,
  TelegramQueueUpdate,
} from "./telegram-queue.ts";

const SCHEMA = "iva-user-quota/v1" as const;
const MAX_INGRESS_IDS = 512;
const TURN_LEASE_MS = 30 * 60 * 1000;

const QuotaStateSchema = z.strictObject({
  schema: z.literal(SCHEMA),
  hour: z.string(),
  day: z.string(),
  requestsHour: z.number().int().nonnegative(),
  requestsDay: z.number().int().nonnegative(),
  tokensDay: z.number().int().nonnegative(),
  audioSecondsDay: z.number().nonnegative(),
  chargedIngress: z.array(z.string()),
  activeTurns: z.array(
    z.strictObject({
      token: z.string().uuid(),
      createdAt: z.number().int().nonnegative(),
    }),
  ),
});

export type UserQuotaState = z.infer<typeof QuotaStateSchema>;
export type QuotaDenialReason =
  | "requests-hour"
  | "requests-day"
  | "tokens-day"
  | "audio-day"
  | "attachment"
  | "storage"
  | "concurrent-turns";
export type QuotaDecision =
  { allowed: true } | { allowed: false; reason: QuotaDenialReason };
export type TurnReservation =
  | { allowed: true; token: string }
  | { allowed: false; reason: "concurrent-turns" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function messageMediaUsage(message: TelegramQueueMessage): {
  attachmentBytes: number;
  audioSeconds: number;
} {
  let attachmentBytes = 0;
  let audioSeconds = 0;
  for (const key of [
    "document",
    "audio",
    "video",
    "voice",
    "animation",
    "video_note",
    "sticker",
  ]) {
    const media = record(message[key]);
    if (!media) continue;
    attachmentBytes += nonNegativeNumber(media.file_size);
    if (key === "audio" || key === "voice")
      audioSeconds += nonNegativeNumber(media.duration);
  }
  if (Array.isArray(message.photo)) {
    attachmentBytes += Math.max(
      0,
      ...message.photo.map((item) =>
        nonNegativeNumber(record(item)?.file_size),
      ),
    );
  }
  return { attachmentBytes, audioSeconds };
}

export function inspectTelegramIngress(update: TelegramQueueUpdate): {
  attachmentBytes: number;
  audioSeconds: number;
} {
  if (!update.message) return { attachmentBytes: 0, audioSeconds: 0 };
  const messages = Array.isArray(update.message.iva_parts)
    ? update.message.iva_parts
    : [update.message];
  const total = { attachmentBytes: 0, audioSeconds: 0 };
  for (const message of messages) {
    const usage = messageMediaUsage(message);
    total.attachmentBytes += usage.attachmentBytes;
    total.audioSeconds += usage.audioSeconds;
  }
  return total;
}

export async function measureDirectoryBytes(path: string): Promise<number> {
  let total = 0;
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const stats = await lstat(child);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) total += await measureDirectoryBytes(child);
    else if (stats.isFile()) total += stats.size;
  }
  return total;
}

function keys(now: number): { hour: string; day: string } {
  const iso = new Date(now).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(0, 13) };
}

function emptyState(now: number): UserQuotaState {
  const current = keys(now);
  return {
    schema: SCHEMA,
    ...current,
    requestsHour: 0,
    requestsDay: 0,
    tokensDay: 0,
    audioSecondsDay: 0,
    chargedIngress: [],
    activeTurns: [],
  };
}

function quotaDir(controlDir: string): string {
  return join(controlDir, "quota");
}

function quotaFile(controlDir: string, userId: TelegramUserId): string {
  return join(quotaDir(controlDir), `${userId}.json`);
}

function refresh(state: UserQuotaState, now: number): void {
  const current = keys(now);
  if (state.day !== current.day) {
    state.day = current.day;
    state.requestsDay = 0;
    state.tokensDay = 0;
    state.audioSecondsDay = 0;
    state.chargedIngress = [];
  }
  if (state.hour !== current.hour) {
    state.hour = current.hour;
    state.requestsHour = 0;
  }
  state.activeTurns = state.activeTurns.filter(
    (turn) => now - turn.createdAt < TURN_LEASE_MS,
  );
}

async function loadState(
  controlDir: string,
  userId: TelegramUserId,
  now: number,
): Promise<UserQuotaState> {
  const parsed = QuotaStateSchema.safeParse(
    await loadJsonStrict<unknown>(
      quotaFile(controlDir, userId),
      emptyState(now),
    ),
  );
  if (!parsed.success) {
    throw new Error(
      `invalid quota state for user ${userId}: ${z.prettifyError(parsed.error)}`,
    );
  }
  refresh(parsed.data, now);
  return parsed.data;
}

async function mutateState<T>(
  controlDir: string,
  userId: TelegramUserId,
  now: number,
  mutation: (state: UserQuotaState) => T,
): Promise<T> {
  const directory = quotaDir(controlDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lock = `${quotaFile(controlDir, userId)}.lock`;
  const token = await acquireLock(lock);
  try {
    const state = await loadState(controlDir, userId, now);
    const result = mutation(state);
    await saveJsonAtomic(quotaFile(controlDir, userId), state);
    chmodSync(quotaFile(controlDir, userId), 0o600);
    return result;
  } finally {
    releaseLock(lock, token);
  }
}

export async function readUserQuota(
  controlDir: string,
  userId: TelegramUserId,
  now = Date.now(),
): Promise<UserQuotaState> {
  return loadState(controlDir, userId, now);
}

export async function chargeUserIngress(
  controlDir: string,
  userId: TelegramUserId,
  limits: UserLimits,
  input: {
    ingressId: string;
    attachmentBytes?: number;
    audioSeconds?: number;
    storageBytes?: number;
    now?: number;
  },
): Promise<QuotaDecision> {
  const now = input.now ?? Date.now();
  return mutateState(controlDir, userId, now, (state): QuotaDecision => {
    if (state.chargedIngress.includes(input.ingressId))
      return { allowed: true };
    if ((input.attachmentBytes ?? 0) > limits.attachmentBytes)
      return { allowed: false, reason: "attachment" };
    if ((input.storageBytes ?? 0) > limits.storageBytes)
      return { allowed: false, reason: "storage" };
    if (state.tokensDay >= limits.llmTokensPerDay)
      return { allowed: false, reason: "tokens-day" };
    if (state.requestsHour + 1 > limits.requestsPerHour)
      return { allowed: false, reason: "requests-hour" };
    if (state.requestsDay + 1 > limits.requestsPerDay)
      return { allowed: false, reason: "requests-day" };
    if (
      state.audioSecondsDay + (input.audioSeconds ?? 0) >
      limits.audioSecondsPerDay
    )
      return { allowed: false, reason: "audio-day" };

    state.requestsHour += 1;
    state.requestsDay += 1;
    state.audioSecondsDay += input.audioSeconds ?? 0;
    state.chargedIngress.push(input.ingressId);
    state.chargedIngress = state.chargedIngress.slice(-MAX_INGRESS_IDS);
    return { allowed: true };
  });
}

export async function recordUserTokens(
  controlDir: string,
  userId: TelegramUserId,
  tokens: number,
  now = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new Error("token usage must be a non-negative safe integer");
  await mutateState(controlDir, userId, now, (state) => {
    state.tokensDay += tokens;
  });
}

export async function reserveUserTurn(
  controlDir: string,
  userId: TelegramUserId,
  limits: UserLimits,
  now = Date.now(),
): Promise<TurnReservation> {
  return mutateState(controlDir, userId, now, (state): TurnReservation => {
    if (state.activeTurns.length >= limits.concurrentTurns)
      return { allowed: false, reason: "concurrent-turns" };
    const token = randomUUID();
    state.activeTurns.push({ token, createdAt: now });
    return { allowed: true, token };
  });
}

export async function releaseUserTurn(
  controlDir: string,
  userId: TelegramUserId,
  token?: string,
  now = Date.now(),
): Promise<boolean> {
  return mutateState(controlDir, userId, now, (state) => {
    const index = token
      ? state.activeTurns.findIndex((turn) => turn.token === token)
      : 0;
    if (index < 0 || state.activeTurns.length === 0) return false;
    state.activeTurns.splice(index, 1);
    return true;
  });
}
