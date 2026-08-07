import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseEnvText, writeEnvAtomicSync } from "./env-file.ts";

export interface UserbotRuntimePaths {
  readonly directory: string;
  readonly credentials: string;
  readonly token: string;
  readonly enabled: string;
}

export interface UserbotCredentials {
  readonly [key: string]: string | undefined;
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
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "userbot data directory must be a regular directory, not a symlink",
    );
  }
  if (process.geteuid && metadata.uid !== process.geteuid()) {
    throw new Error("userbot data directory must be owned by the runtime user");
  }
  await chmod(path, 0o700);
}

async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("userbot secret must be a regular file");
    if (process.geteuid && metadata.uid !== process.geteuid()) {
      throw new Error("userbot secret must be owned by the runtime user");
    }
    if (metadata.mode & 0o077)
      throw new Error("userbot secret must be private");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function validateCredentials(apiId: string, apiHash: string): void {
  if (!/^\d+$/u.test(apiId)) throw new Error("api_id must be numeric");
  if (!/^\S{8,}$/u.test(apiHash)) throw new Error("api_hash is invalid");
}

export async function readUserbotCredentials(
  root: string,
): Promise<UserbotCredentials> {
  let text = "";
  try {
    text = await readPrivateFile(userbotRuntimePaths(root).credentials);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const env = parseEnvText(text);
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
    const token = (await readPrivateFile(path)).trim();
    if (!/^[A-Za-z0-9_-]{40,}$/u.test(token)) {
      throw new Error("existing userbot token is invalid");
    }
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
