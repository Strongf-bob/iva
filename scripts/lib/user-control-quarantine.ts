import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  clearQueueFileKey,
  loadQueueFile,
  type TelegramQueueDocument,
} from "./telegram-queue.ts";
import type { TelegramUserId } from "./user-registry.ts";

async function moveIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function encodedChatFile(directory: string, chatKey: string): string {
  return join(directory, `${Buffer.from(chatKey).toString("base64url")}.json`);
}

export async function quarantineUserControlState(
  dataDir: string,
  controlDir: string,
  userId: TelegramUserId,
  quarantineRoot: string,
): Promise<void> {
  const chatKey = `${userId}:`;
  const destination = join(quarantineRoot, "gateway-state");
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const queueFile = join(dataDir, "telegram-queue.json");
  const loaded = await loadQueueFile(queueFile, { strict: true });
  const items = loaded.document.queues[chatKey] ?? [];
  if (items.length) {
    const snapshot: TelegramQueueDocument = {
      version: loaded.document.version,
      queues: { [chatKey]: items },
    };
    await writeFile(
      join(destination, "telegram-queue.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  await clearQueueFileKey(queueFile, chatKey);

  await moveIfPresent(
    join(controlDir, "quota", `${userId}.json`),
    join(destination, "quota.json"),
  );
  await moveIfPresent(
    encodedChatFile(join(dataDir, "run-status.d"), chatKey),
    join(destination, "run-status.json"),
  );
  await moveIfPresent(
    encodedChatFile(join(dataDir, "telegram-reset-intents"), chatKey),
    join(destination, "telegram-reset-intent.json"),
  );
}
