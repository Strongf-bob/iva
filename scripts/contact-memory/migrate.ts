import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { parseFrontmatter } from "../../agent/lib/frontmatter.ts";
import { contactCardPath, reduceBatch } from "../contact-analysis/reducer.ts";
import type { TelegramDialog } from "../contact-analysis/types.ts";

export interface MigrationReport {
  candidates: string[];
  migrated: string[];
  backups: string[];
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name));
}

function legacyCandidates(vault: string): string[] {
  return [
    ...markdownFiles(join(vault, "cards", "contacts")),
    ...markdownFiles(join(vault, "cards", "notes")),
  ]
    .filter((file) =>
      readFileSync(file, "utf8").includes("<!-- iva:telegram-graph:state:"),
    )
    .sort();
}

function titleOf(content: string, fallback: string): string {
  return (
    /^#\s+(.+)$/mu.exec(parseFrontmatter(content).body)?.[1]?.trim() ?? fallback
  );
}

function dialogFor(file: string, content: string): TelegramDialog {
  const person = /telegram-user-([1-9]\d*)\.md$/u.exec(file);
  if (person) {
    const id = Number(person[1]);
    return {
      id,
      kind: "private",
      title: titleOf(content, `Telegram user ${id}`),
      username: null,
    };
  }
  const chat = /telegram-(group|channel)-(\d+)\.md$/u.exec(file);
  if (!chat) throw new Error(`unsupported legacy contact-memory path ${file}`);
  const parsed = parseFrontmatter(content);
  const raw = parsed.fields?.telegram_chat_id;
  const id =
    typeof raw === "string" && /^-?[1-9]\d*$/u.test(raw)
      ? Number(raw)
      : -Number(chat[2]);
  return {
    id,
    kind: chat[1] as "group" | "channel",
    title: titleOf(content, `Telegram ${chat[1]} ${chat[2]}`),
    username: null,
  };
}

export async function migrateContactMemory(input: {
  vault: string;
  backupDir: string;
  dryRun: boolean;
}): Promise<MigrationReport> {
  const candidates = legacyCandidates(input.vault);
  const report: MigrationReport = { candidates, migrated: [], backups: [] };
  if (input.dryRun) return report;
  const vaultLexical = resolve(input.vault);
  const backupLexical = resolve(input.backupDir);
  const trackedRoot = resolve(process.cwd());
  if (
    backupLexical === vaultLexical ||
    backupLexical.startsWith(`${vaultLexical}${sep}`)
  ) {
    throw new Error("backup directory must be outside the vault");
  }
  if (
    backupLexical === trackedRoot ||
    backupLexical.startsWith(`${trackedRoot}${sep}`)
  ) {
    throw new Error(
      "backup directory must be outside tracked repository paths",
    );
  }
  mkdirSync(input.backupDir, { recursive: true });
  const vaultActual = realpathSync(input.vault);
  const backupActual = realpathSync(input.backupDir);
  const trackedActual = realpathSync(process.cwd());
  if (
    backupActual === vaultActual ||
    backupActual.startsWith(`${vaultActual}${sep}`)
  ) {
    throw new Error("backup directory must be outside the vault");
  }
  if (
    backupActual === trackedActual ||
    backupActual.startsWith(`${trackedActual}${sep}`)
  ) {
    throw new Error(
      "backup directory must be outside tracked repository paths",
    );
  }
  for (const file of candidates) {
    const content = readFileSync(file, "utf8");
    const backup = join(
      input.backupDir,
      `${basename(dirname(file))}-${basename(file)}.legacy`,
    );
    copyFileSync(file, backup);
    report.backups.push(backup);
    const dialog = dialogFor(file, content);
    await reduceBatch({
      vault: input.vault,
      ownerUserId: 1,
      dialog,
      batch: {
        schemaVersion: 1,
        chatId: dialog.id,
        rollingSummary: "",
        observations: [],
      },
    });
    const expected =
      dialog.kind === "private"
        ? contactCardPath(input.vault, dialog.id)
        : file;
    if (expected !== file)
      throw new Error("migration identity resolved to another file");
    report.migrated.push(file);
  }
  return report;
}
