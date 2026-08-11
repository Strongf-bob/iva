/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import "../lib/ts-esm-hooks.ts";

import {
  addPersonTask,
  renderPeopleTaskDocument,
} from "../../agent/lib/people-task-store.ts";
import type { Observation } from "../contact-analysis/types.ts";
const { migrateContactMemory } = await import("./migrate.ts");
const { reconcilePersonTasks } = await import("./reconcile.ts");

function legacyObservation(): Observation {
  return {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    kind: "fact",
    predicate: "city",
    value: "Казань",
    confidence: "EXTRACTED",
    contextChatId: 44,
    evidence: [{ chatId: 44, messageId: 3, timestamp: "2026-08-07T00:00:00Z" }],
  };
}

test("migration dry-run inventories legacy cards without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-migrate-"));
  const vault = join(root, "vault");
  const file = join(vault, "cards/contacts/telegram-user-44.md");
  await mkdir(dirname(file), { recursive: true });
  const encoded = Buffer.from(
    JSON.stringify({ current: [legacyObservation()], history: [], links: [] }),
  ).toString("base64url");
  const original = `---\ntype: contact\ntelegram_user_id: "44"\n---\n# Иван\n\n<!-- iva:telegram-graph:start -->\n<!-- iva:telegram-graph:state:${encoded} -->\n<!-- iva:telegram-graph:end -->\n`;
  await writeFile(file, original);

  const report = await migrateContactMemory({
    vault,
    backupDir: join(root, "backups"),
    dryRun: true,
  });
  assert.deepEqual(report.candidates, [file]);
  assert.equal(report.migrated.length, 0);
  assert.equal(await readFile(file, "utf8"), original);
});

test("migration refuses backup storage inside the live vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-migrate-"));
  const vault = join(root, "vault");
  await mkdir(vault, { recursive: true });
  await assert.rejects(
    migrateContactMemory({
      vault,
      backupDir: join(vault, "backups"),
      dryRun: false,
    }),
    /backup directory must be outside the vault/u,
  );
});

test("migration backs up, converts once, and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-migrate-"));
  const vault = join(root, "vault");
  const backupDir = join(root, "backups");
  const file = join(vault, "cards/contacts/telegram-user-44.md");
  await mkdir(dirname(file), { recursive: true });
  const encoded = Buffer.from(
    JSON.stringify({ current: [legacyObservation()], history: [], links: [] }),
  ).toString("base64url");
  await writeFile(
    file,
    `---\ntype: contact\ntelegram_user_id: "44"\n---\n# Иван\n\n<!-- iva:telegram-graph:start -->\n<!-- iva:telegram-graph:state:${encoded} -->\n<!-- iva:telegram-graph:end -->\n`,
  );

  const first = await migrateContactMemory({ vault, backupDir, dryRun: false });
  const second = await migrateContactMemory({
    vault,
    backupDir,
    dryRun: false,
  });
  assert.deepEqual(first.migrated, [file]);
  assert.deepEqual(second.candidates, []);
  const migrated = await readFile(file, "utf8");
  assert.match(migrated, /Город: Казань/u);
  assert.doesNotMatch(migrated, /telegram-graph:state:/u);
  assert.equal((await readdir(backupDir)).length, 1);
});

test("reconciliation renders and removes reciprocal open-task views idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-reconcile-"));
  const vault = join(root, "vault");
  const personFile = join(vault, "cards/contacts/telegram-user-44.md");
  const tasksFile = join(vault, "tasks/people.md");
  await mkdir(dirname(personFile), { recursive: true });
  await mkdir(dirname(tasksFile), { recursive: true });
  await writeFile(
    personFile,
    "---\ntype: contact\n---\n# Иван\n\nРучная заметка.\n",
  );
  const added = addPersonTask(
    [],
    { title: "Отправить презентацию", direction: "owner_to_person" },
    { path: "cards/contacts/telegram-user-44", name: "Иван" },
    "2026-08-11T12:00:00.000Z",
  );
  await writeFile(
    tasksFile,
    renderPeopleTaskDocument("", added.tasks, "2026-08-11"),
  );

  await reconcilePersonTasks({ vault, today: "2026-08-11" });
  const once = await readFile(personFile, "utf8");
  await reconcilePersonTasks({ vault, today: "2026-08-11" });
  const twice = await readFile(personFile, "utf8");
  assert.equal(twice, once);
  assert.match(
    once,
    /## Открытые дела[\s\S]*\[\[tasks\/people\|Отправить презентацию\]\]/u,
  );
  assert.match(once, /Ручная заметка\./u);
});

test("reconciliation refuses a person-card symlink outside the vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-contact-reconcile-"));
  const vault = join(root, "vault");
  const outside = join(root, "outside.md");
  const personFile = join(vault, "cards/contacts/telegram-user-44.md");
  const tasksFile = join(vault, "tasks/people.md");
  await mkdir(dirname(personFile), { recursive: true });
  await mkdir(dirname(tasksFile), { recursive: true });
  await writeFile(outside, "# Outside\n");
  await symlink(outside, personFile);
  const added = addPersonTask(
    [],
    { title: "Отправить презентацию", direction: "owner_to_person" },
    { path: "cards/contacts/telegram-user-44", name: "Иван" },
    "2026-08-11T12:00:00.000Z",
  );
  await writeFile(
    tasksFile,
    renderPeopleTaskDocument("", added.tasks, "2026-08-11"),
  );
  await assert.rejects(
    reconcilePersonTasks({ vault, today: "2026-08-11" }),
    /outside the vault/u,
  );
  assert.equal(await readFile(outside, "utf8"), "# Outside\n");
});
