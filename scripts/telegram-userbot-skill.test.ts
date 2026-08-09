import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillUrl = new URL(
  "../agent/skills/telegram-userbot/SKILL.md",
  import.meta.url,
);

void test("exhaustive Telegram activity scans paginate every dialog including archive", async () => {
  const skill = await readFile(skillUrl, "utf8");

  assert.match(skill, /get_chats/u);
  assert.match(skill, /page_size/u);
  assert.match(skill, /Page out of range/u);
  assert.match(skill, /архив/iu);
  assert.match(skill, /не (?:говори|пиши).{0,80}[«"]?все чат/isu);
});

void test("Telegram day boundaries use the user's timezone instead of UTC dates", async () => {
  const skill = await readFile(skillUrl, "utf8");

  assert.match(skill, /часов(?:ом|ой) пояс/iu);
  assert.match(skill, /ISO 8601/iu);
  assert.match(skill, /UTC/iu);
  assert.match(skill, /локальн/iu);
  assert.match(skill, /from_date/u);
  assert.match(skill, /to_date/u);
});
