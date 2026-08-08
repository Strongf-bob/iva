import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

void test("Telegram userbot connection uses the configured MCP URL with localhost fallback", async () => {
  const path = fileURLToPath(
    new URL("../../agent/connections/telegram-userbot.ts", import.meta.url),
  );
  const source = await readFile(path, "utf8");

  assert.match(
    source,
    /process\.env\.TELEGRAM_MCP_URL\s*\?\?\s*`http:\/\/127\.0\.0\.1:\$\{port\}\/mcp`/u,
  );
  assert.match(
    source,
    /url:\s*ownerWorker\s*\?\s*url\s*:\s*"http:\/\/127\.0\.0\.1:1\/disabled-userbot"/u,
  );
  assert.match(source, /if \(!ownerWorker\) return "";/u);
});
