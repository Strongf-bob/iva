import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultUserLimits, parseTelegramUserId } from "./user-registry.ts";
import {
  chargeUserIngress,
  inspectTelegramIngress,
  readUserQuota,
  recordUserTokens,
  releaseUserTurn,
  reserveUserTurn,
} from "./user-quota.ts";

const userId = parseTelegramUserId("424242")!;

async function controlDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "iva-user-quota-"));
}

void test("ingress counters are atomic, idempotent and reset on UTC boundaries", async () => {
  const dir = await controlDir();
  const limits = { ...defaultUserLimits(), requestsPerHour: 2 };
  const first = Date.UTC(2026, 7, 7, 10, 30);

  assert.equal(
    (await chargeUserIngress(dir, userId, limits, { ingressId: "10", now: first }))
      .allowed,
    true,
  );
  assert.equal(
    (await chargeUserIngress(dir, userId, limits, { ingressId: "10", now: first }))
      .allowed,
    true,
  );
  assert.equal(
    (await chargeUserIngress(dir, userId, limits, { ingressId: "11", now: first }))
      .allowed,
    true,
  );
  assert.deepEqual(
    await chargeUserIngress(dir, userId, limits, {
      ingressId: "12",
      now: first,
    }),
    { allowed: false, reason: "requests-hour" },
  );
  assert.equal(
    (
      await chargeUserIngress(dir, userId, limits, {
        ingressId: "13",
        now: first + 60 * 60 * 1000,
      })
    ).allowed,
    true,
  );
});

void test("attachment, audio, storage and actual token limits fail closed", async () => {
  const dir = await controlDir();
  const limits = {
    ...defaultUserLimits(),
    attachmentBytes: 10,
    audioSecondsPerDay: 15,
    storageBytes: 100,
    llmTokensPerDay: 20,
  };
  const now = Date.UTC(2026, 7, 7, 10);

  assert.deepEqual(
    await chargeUserIngress(dir, userId, limits, {
      ingressId: "large",
      attachmentBytes: 11,
      now,
    }),
    { allowed: false, reason: "attachment" },
  );
  assert.deepEqual(
    await chargeUserIngress(dir, userId, limits, {
      ingressId: "storage",
      storageBytes: 101,
      now,
    }),
    { allowed: false, reason: "storage" },
  );
  assert.equal(
    (
      await chargeUserIngress(dir, userId, limits, {
        ingressId: "audio-1",
        audioSeconds: 10,
        now,
      })
    ).allowed,
    true,
  );
  assert.deepEqual(
    await chargeUserIngress(dir, userId, limits, {
      ingressId: "audio-2",
      audioSeconds: 6,
      now,
    }),
    { allowed: false, reason: "audio-day" },
  );
  await recordUserTokens(dir, userId, 21, now);
  assert.deepEqual(
    await chargeUserIngress(dir, userId, limits, {
      ingressId: "tokens",
      now,
    }),
    { allowed: false, reason: "tokens-day" },
  );
});

void test("turn reservations enforce concurrency and terminal release", async () => {
  const dir = await controlDir();
  const limits = { ...defaultUserLimits(), concurrentTurns: 1 };
  const now = Date.UTC(2026, 7, 7, 10);

  const first = await reserveUserTurn(dir, userId, limits, now);
  assert.equal(first.allowed, true);
  assert.deepEqual(await reserveUserTurn(dir, userId, limits, now), {
    allowed: false,
    reason: "concurrent-turns",
  });
  assert.equal(await releaseUserTurn(dir, userId, undefined, now), true);
  assert.equal((await reserveUserTurn(dir, userId, limits, now)).allowed, true);
  assert.equal((await readUserQuota(dir, userId, now)).activeTurns.length, 1);
});

void test("Telegram media accounting sums files and audio duration across collected parts", () => {
  assert.deepEqual(
    inspectTelegramIngress({
      update_id: 9,
      message: {
        chat: { id: 424242, type: "private" },
        voice: { file_id: "voice", file_size: 7, duration: 12 },
        iva_parts: [
          {
            voice: { file_id: "voice", file_size: 7, duration: 12 },
          },
          {
            document: { file_id: "doc", file_size: 11 },
            photo: [
              { file_id: "small", file_size: 2 },
              { file_id: "large", file_size: 5 },
            ],
          },
        ],
      },
    }),
    { attachmentBytes: 23, audioSeconds: 12 },
  );
});
