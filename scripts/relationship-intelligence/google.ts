import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

import { childEnv, gwsBin } from "../lib/menu/gws-auth.ts";
import { acquireLock, releaseLock } from "../../agent/lib/json-store.ts";

import {
  loadRegistry,
  mutateRegistry,
  type RelationshipPaths,
} from "./store.ts";
import type { Commitment } from "./types.ts";

export interface GoogleRunResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}
export type GoogleRunner = (
  args: readonly string[],
) => Promise<GoogleRunResult>;

export async function runGoogleCommand(
  args: readonly string[],
): Promise<GoogleRunResult> {
  const home =
    process.env.ASSISTANT_PERSONAL_ROOT ?? process.env.HOME ?? homedir();
  return new Promise((resolve) => {
    execFile(
      gwsBin(),
      [...args],
      {
        env: childEnv(home),
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          stdout: stdout.slice(-24_000),
          stderr: stderr.slice(-24_000),
          exitCode: typeof code === "number" ? code : error ? 1 : 0,
        });
      },
    );
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function findItem(items: readonly Commitment[], id: string): Commitment {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`commitment ${id} not found`);
  return item;
}
function parseJson(result: GoogleRunResult): unknown {
  if (result.exitCode !== 0) throw new Error("Google Workspace request failed");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Google Workspace returned invalid JSON");
  }
}

export async function prepareTaskConfirmation({
  paths,
  id,
  role,
  now = new Date().toISOString(),
  nonce = randomBytes(3).toString("hex").toUpperCase(),
}: {
  paths: RelationshipPaths;
  id: string;
  role: string | undefined;
  now?: string;
  nonce?: string;
}): Promise<{ id: string; phrase: string; expiresAt: string }> {
  if (role !== "owner")
    throw new Error("only the owner may confirm Google Tasks");
  if (!/^[A-Z0-9]{6}$/u.test(nonce))
    throw new Error("invalid confirmation nonce");
  const phrase = `CREATE TASK ${id} ${nonce}`;
  const expiresAt = new Date(Date.parse(now) + 15 * 60_000).toISOString();
  await mutateRegistry(paths, (registry) => {
    const item = findItem(registry.commitments, id);
    if (item.status !== "pending_suggestion")
      throw new Error("only pending commitments can be prepared");
    item.confirmation = {
      phraseHash: hash(phrase),
      preparedAt: now,
      expiresAt,
    };
    item.updatedAt = now;
  });
  return { id, phrase, expiresAt };
}

export async function confirmGoogleTask({
  paths,
  id,
  phrase,
  role,
  now = new Date().toISOString(),
  run,
}: {
  paths: RelationshipPaths;
  id: string;
  phrase: string;
  role: string | undefined;
  now?: string;
  run: GoogleRunner;
}): Promise<{ taskListId: string; taskId: string; createdAt: string }> {
  if (role !== "owner")
    throw new Error("only the owner may confirm Google Tasks");
  const token = await acquireLock(`${paths.lock}.${id}.google-task`);
  try {
    let item = findItem((await loadRegistry(paths)).commitments, id);
    if (item.googleTask) return item.googleTask;
    if (
      !item.confirmation ||
      item.confirmation.phraseHash !== hash(phrase) ||
      Date.parse(item.confirmation.expiresAt) < Date.parse(now)
    )
      throw new Error("exact unexpired confirmation is required");
    const marker = `[${item.id}]`;
    let pageToken: string | undefined;
    let taskId: string | undefined;
    for (let page = 0; page < 100 && !taskId; page += 1) {
      const listed = parseJson(
        await run([
          "tasks",
          "tasks",
          "list",
          "--params",
          JSON.stringify({
            tasklist: "@default",
            showCompleted: false,
            ...(pageToken ? { pageToken } : {}),
          }),
        ]),
      ) as {
        items?: Array<{ id?: string; notes?: string }>;
        nextPageToken?: unknown;
      };
      taskId = listed.items?.find((candidate) =>
        candidate.notes?.includes(marker),
      )?.id;
      pageToken =
        typeof listed.nextPageToken === "string" && listed.nextPageToken
          ? listed.nextPageToken
          : undefined;
      if (!pageToken) break;
    }
    if (!taskId) {
      const created = parseJson(
        await run([
          "tasks",
          "tasks",
          "insert",
          "--params",
          JSON.stringify({ tasklist: "@default" }),
          "--json",
          JSON.stringify({
            title: item.text,
            notes: `${marker}\nEvidence: ${item.evidence.map((e) => e.sourceId).join(", ")}`,
            ...(item.dueAt ? { due: item.dueAt } : {}),
          }),
        ]),
      ) as { id?: unknown };
      if (typeof created.id !== "string" || !created.id)
        throw new Error("Google Task response has no id");
      taskId = created.id;
    }
    const receipt = { taskListId: "@default", taskId, createdAt: now };
    await mutateRegistry(paths, (registry) => {
      const current = findItem(registry.commitments, id);
      if (current.googleTask) return false;
      current.googleTask = receipt;
      current.confirmation = null;
      current.status = "confirmed_task";
      current.updatedAt = now;
    });
    item = findItem((await loadRegistry(paths)).commitments, id);
    return item.googleTask!;
  } finally {
    releaseLock(`${paths.lock}.${id}.google-task`, token);
  }
}

export async function confirmGoogleTaskFromOwnerMessage({
  paths,
  text,
  senderUserId,
  chatId,
  chatType,
  ownerUserId,
  role,
  now = new Date().toISOString(),
  run,
}: {
  paths: RelationshipPaths;
  text: string;
  senderUserId: string;
  chatId: string;
  chatType: string;
  ownerUserId: string | undefined;
  role: string | undefined;
  now?: string;
  run: GoogleRunner;
}): Promise<
  | { handled: false }
  | {
      handled: true;
      receipt: { taskListId: string; taskId: string; createdAt: string };
    }
> {
  const match = /^CREATE TASK (RI-[a-f0-9]{16}) ([A-Z0-9]{6})$/u.exec(text);
  if (
    !match ||
    role !== "owner" ||
    chatType !== "private" ||
    !ownerUserId ||
    senderUserId !== ownerUserId ||
    chatId !== ownerUserId
  )
    return { handled: false };
  return {
    handled: true,
    receipt: await confirmGoogleTask({
      paths,
      id: match[1],
      phrase: text,
      role,
      now,
      run,
    }),
  };
}

function encodeMessage(input: {
  to: string;
  subject: string;
  body: string;
}): string {
  const message = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

export async function createGmailDraft(
  input: { to: string; subject: string; body: string },
  run: GoogleRunner,
): Promise<{ draftId: string }> {
  const raw = encodeMessage(input);
  const parsed = parseJson(
    await run([
      "gmail",
      "users",
      "drafts",
      "create",
      "--params",
      JSON.stringify({ userId: "me" }),
      "--json",
      JSON.stringify({ message: { raw } }),
    ]),
  ) as { id?: unknown };
  if (typeof parsed.id !== "string" || !parsed.id)
    throw new Error("Gmail Draft response has no id");
  return { draftId: parsed.id };
}
