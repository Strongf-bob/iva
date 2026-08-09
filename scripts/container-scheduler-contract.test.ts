import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("Compose runs a hardened durable reminder scheduler", async () => {
  const compose = await readFile(
    new URL("../deploy/container/compose.production.yml", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };

  assert.match(compose, /^ {2}reminder-scheduler:/mu);
  assert.match(compose, /command: \["npm", "run", "scheduler"\]/u);
  assert.match(compose, /IVA_RUNTIME: container/u);
  assert.match(compose, /\.\/data:\/app\/data/u);
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.equal(
    packageJson.scripts.scheduler,
    "node --env-file=.env scripts/reminder-scheduler.ts run",
  );
});

void test("agent and operator docs expose the stable container reminder contract", async () => {
  const [instructions, scheduler, deploy, configuration] = await Promise.all([
    readFile(new URL("../agent/instructions.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/scheduler.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/deploy.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/configuration.md", import.meta.url), "utf8"),
  ]);

  assert.match(instructions, /используй инструмент `reminders`/iu);
  assert.match(instructions, /userbot[^\n]+только для чтения/iu);
  assert.doesNotMatch(instructions, /userbot[^\n]+отправлять сообщения/iu);
  assert.doesNotMatch(
    instructions,
    /Разовое напоминание[^\n]+`systemd-run|Регулярное[^\n]+`crontab/iu,
  );
  assert.match(scheduler, /iva-reminders\/v1/u);
  assert.match(scheduler, /at-least-once/iu);
  assert.match(scheduler, /private bot chat/iu);
  assert.doesNotMatch(
    scheduler,
    /chat[_-]?id[^\n]+(?:input|parameter|field)/iu,
  );
  assert.match(deploy, /reminder-scheduler/u);
  assert.match(deploy, /gws --version/u);
  assert.match(configuration, /IVA_RUNTIME/u);
  assert.match(configuration, /ASSISTANT_TIMEZONE/u);
});
