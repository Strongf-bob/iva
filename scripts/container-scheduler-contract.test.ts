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
