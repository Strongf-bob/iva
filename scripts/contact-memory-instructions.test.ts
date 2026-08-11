/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("person extraction documents birthday safeguards and the meeting boundary", async () => {
  const skill = await read("agent/skills/telegram-person-profile/SKILL.md");
  assert.match(skill, /birthday/u);
  assert.match(skill, /с прошедшим/u);
  assert.match(skill, /must not create a meeting|не создавай встреч/u);
  assert.match(skill, /city|город/u);
  assert.match(skill, /phone|телефон/u);
});

test("memory map routes person retrieval and meetings through contact_memory", async () => {
  const instructions = await read("agent/instructions/10-map.md");
  assert.match(instructions, /contact_memory/u);
  assert.match(instructions, /record_meeting/u);
  assert.match(instructions, /текущ(?:ий|его) возраст/u);
});

test("normal replies explicitly suppress every internal storage artifact", async () => {
  const instructions = await read("agent/instructions/10-map.md");
  for (const forbidden of [
    "HTML-комментар",
    "Telegram ID",
    "YAML frontmatter",
    "EXTRACTED",
    "AMBIGUOUS",
    "внутренние ID",
  ]) {
    assert.match(instructions, new RegExp(forbidden, "u"));
  }
});

test("daily rollup reconciles only unambiguous person-task completions", async () => {
  const rollup = await read("scripts/memory/rollup.ts");
  assert.match(rollup, /contact_memory/u);
  assert.match(rollup, /unambiguous|однознач/u);
  assert.match(rollup, /leave.*open|остав.*открыт/iu);
  assert.match(rollup, /reconcilePersonTasks/u);
});
