import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { readEnvValues, writeEnvAtomicSync } from "./env-file.ts";

export interface UserbotRuntimePaths {
  readonly directory: string;
  readonly credentials: string;
  readonly token: string;
  readonly enabled: string;
}

export interface UserbotCredentials {
  readonly TELEGRAM_API_ID?: string;
  readonly TELEGRAM_API_HASH?: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

export function userbotRuntimePaths(root: string): UserbotRuntimePaths {
  const directory = join(root, "data");
  return {
    directory,
    credentials: join(directory, "telegram-userbot.env"),
    token: join(directory, "telegram-userbot.token"),
    enabled: join(directory, "telegram-userbot.enabled"),
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function validateCredentials(apiId: string, apiHash: string): void {
  if (!/^\d+$/u.test(apiId)) throw new Error("api_id must be numeric");
  if (!/^\S{8,}$/u.test(apiHash)) throw new Error("api_hash is invalid");
}

export async function readUserbotCredentials(
  root: string,
): Promise<UserbotCredentials> {
  const env = await readEnvValues(userbotRuntimePaths(root).credentials);
  const apiId = env.TELEGRAM_API_ID;
  const apiHash = env.TELEGRAM_API_HASH;
  return {
    ...(apiId ? { TELEGRAM_API_ID: apiId } : {}),
    ...(apiHash ? { TELEGRAM_API_HASH: apiHash } : {}),
  };
}

export async function writeUserbotCredentials(
  root: string,
  apiId: string,
  apiHash: string,
): Promise<void> {
  validateCredentials(apiId, apiHash);
  const paths = userbotRuntimePaths(root);
  await ensurePrivateDirectory(paths.directory);
  writeEnvAtomicSync(
    paths.credentials,
    `TELEGRAM_API_ID=${apiId}\nTELEGRAM_API_HASH=${apiHash}\n`,
  );
}

async function readExistingToken(path: string): Promise<string> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{40,}$/u.test(token)) {
      throw new Error("existing userbot token is invalid");
    }
    await chmod(path, 0o600);
    return token;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

export async function enableContainerUserbot(root: string): Promise<void> {
  const credentials = await readUserbotCredentials(root);
  const apiId = credentials.TELEGRAM_API_ID ?? "";
  const apiHash = credentials.TELEGRAM_API_HASH ?? "";
  validateCredentials(apiId, apiHash);

  const paths = userbotRuntimePaths(root);
  await ensurePrivateDirectory(paths.directory);
  const existingToken = await readExistingToken(paths.token);
  if (!existingToken) {
    writeEnvAtomicSync(
      paths.token,
      `${randomBytes(32).toString("base64url")}\n`,
    );
  }
  writeEnvAtomicSync(paths.enabled, "enabled\n");
}

export async function disableContainerUserbot(root: string): Promise<void> {
  await rm(userbotRuntimePaths(root).enabled, { force: true });
}
