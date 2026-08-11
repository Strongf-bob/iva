import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { acquireLock, atomicWrite } from "./card-store.ts";

const JournalSchema = z.strictObject({
  version: z.literal(1),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      content: z.string().nullable(),
    }),
  ),
});

function journalPath(vault: string): string {
  return join(vault, ".contact-memory-transaction.json");
}

export function assertContactMemoryPath(vault: string, file: string): string {
  const root = resolve(vault);
  const target = resolve(file);
  if (!target.startsWith(`${root}${sep}`))
    throw new Error("contact-memory transaction path is outside the vault");
  if (existsSync(file)) {
    const actualRoot = realpathSync(vault);
    const actual = realpathSync(file);
    if (!actual.startsWith(`${actualRoot}${sep}`))
      throw new Error(
        "contact-memory transaction symlink points outside the vault",
      );
  } else {
    let ancestor = dirname(file);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor)
        throw new Error("contact-memory transaction has no safe ancestor");
      ancestor = parent;
    }
    const actualRoot = realpathSync(vault);
    const actualAncestor = realpathSync(ancestor);
    if (
      actualAncestor !== actualRoot &&
      !actualAncestor.startsWith(`${actualRoot}${sep}`)
    ) {
      throw new Error(
        "contact-memory transaction parent symlink points outside the vault",
      );
    }
  }
  return relative(root, target).split(sep).join("/");
}

function recoverJournal(vault: string): void {
  const journal = journalPath(vault);
  if (!existsSync(journal)) return;
  const parsed = JournalSchema.parse(JSON.parse(readFileSync(journal, "utf8")));
  for (const snapshot of parsed.files) {
    const file = join(vault, snapshot.path);
    assertContactMemoryPath(vault, file);
    if (snapshot.content === null) {
      if (existsSync(file)) rmSync(file);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      atomicWrite(file, snapshot.content);
    }
  }
  rmSync(journal);
}

export function withContactMemoryLock<T>(vault: string, action: () => T): T {
  mkdirSync(vault, { recursive: true });
  const release = acquireLock(join(vault, ".contact-memory-global"));
  try {
    recoverJournal(vault);
    return action();
  } finally {
    release();
  }
}

export async function withContactMemoryLockAsync<T>(
  vault: string,
  action: () => Promise<T>,
): Promise<T> {
  mkdirSync(vault, { recursive: true });
  const release = acquireLock(join(vault, ".contact-memory-global"));
  try {
    recoverJournal(vault);
    return await action();
  } finally {
    release();
  }
}

export async function runContactMemoryTransaction<T>(
  vault: string,
  files: string[],
  action: () => Promise<T> | T,
  options: { lockHeld?: boolean } = {},
): Promise<T> {
  mkdirSync(vault, { recursive: true });
  const execute = async (): Promise<T> => {
    recoverJournal(vault);
    const unique = [...new Set(files)].sort();
    const journal = JournalSchema.parse({
      version: 1,
      files: unique.map((file) => ({
        path: assertContactMemoryPath(vault, file),
        content: existsSync(file) ? readFileSync(file, "utf8") : null,
      })),
    });
    atomicWrite(journalPath(vault), `${JSON.stringify(journal)}\n`);
    try {
      const result = await action();
      rmSync(journalPath(vault));
      return result;
    } catch (error) {
      recoverJournal(vault);
      throw error;
    }
  };
  if (options.lockHeld) return execute();
  const release = acquireLock(join(vault, ".contact-memory-global"));
  try {
    return await execute();
  } finally {
    release();
  }
}
