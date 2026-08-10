/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Skill = {
  frontmatter: Record<string, string>;
  body: string;
};

function readSkill(name: string): Skill {
  const path = fileURLToPath(
    new URL(`../agent/skills/${name}.md`, import.meta.url),
  );
  const source = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(source);
  assert.ok(match, `${name} must have YAML frontmatter and a body`);
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    frontmatter[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim();
  }
  return { frontmatter, body: match[2] };
}

test("daily attention skill is bounded, evidence-backed and read-only", () => {
  const skill = readSkill("chief-of-staff-today");

  assert.equal(skill.frontmatter.name, "chief-of-staff-today");
  assert.match(skill.frontmatter.description, /^Use when /u);
  assert.match(skill.body, /`tasks`/u);
  assert.match(skill.body, /`memory_search`/u);
  assert.match(skill.body, /`read_file`/u);
  assert.match(skill.body, /cwd="\$VAULT"/u);
  assert.match(skill.body, /EXTRACTED/u);
  assert.match(skill.body, /INFERRED/u);
  assert.match(skill.body, /superseded/u);
  assert.match(skill.body, /vault-relative/u);
  assert.match(skill.body, /(?:seven|7) action bullets/iu);
  assert.match(skill.body, /do not create, modify, or send/iu);
});

test("relationship briefing preserves identity ambiguity and evidence", () => {
  const skill = readSkill("relationship-briefing");

  assert.equal(skill.frontmatter.name, "relationship-briefing");
  assert.match(skill.frontmatter.description, /^Use when /u);
  assert.match(skill.body, /`memory_search`/u);
  assert.match(skill.body, /`read_file`/u);
  assert.match(skill.body, /candidate|candidate|candidates|candidates/iu);
  assert.match(skill.body, /(?:three|3) linked supporting cards/iu);
  assert.match(skill.body, /(?:five|5) talking points/iu);
  assert.match(skill.body, /EXTRACTED/u);
  assert.match(skill.body, /INFERRED/u);
  assert.match(skill.body, /vault-relative/u);
  assert.match(skill.body, /telegram:message/u);
  assert.match(skill.body, /every memory-derived claim/iu);
  assert.match(skill.body, /do not create, modify, or send/iu);
});

test("person memory separates read-only viewing from explicit safe supplements", () => {
  const skill = readSkill("person-memory");

  assert.equal(skill.frontmatter.name, "person-memory");
  assert.match(skill.frontmatter.description, /^Use when /u);
  assert.match(skill.body, /view mode/iu);
  assert.match(skill.body, /supplement mode/iu);
  assert.match(skill.body, /`memory_search`/u);
  assert.match(skill.body, /`read_file`/u);
  assert.match(skill.body, /candidate|candidates/iu);
  assert.match(skill.body, /exactly one|ровно одна/iu);
  assert.match(skill.body, /(?:three|3) linked supporting cards/iu);
  assert.match(skill.body, /EXTRACTED/u);
  assert.match(skill.body, /INFERRED/u);
  assert.match(skill.body, /AMBIGUOUS/u);
  assert.match(skill.body, /vault-relative/u);
  assert.match(skill.body, /telegram:message/u);
  assert.match(skill.body, /`write_card`/u);
  assert.match(skill.body, /UPDATE/u);
  assert.match(skill.body, /SUPERSEDE/u);
  assert.match(skill.body, /history_entry/u);
  assert.match(skill.body, /explicit correction|явн.*исправ/iu);
  assert.match(skill.body, /do not use `write_file`/iu);
  assert.match(skill.body, /do not create a new contact/iu);
  assert.match(skill.body, /do not create.*task|do not send/iu);
});

test("weekly review is honest about coverage and tracks decision arcs", () => {
  const skill = readSkill("weekly-review");

  assert.equal(skill.frontmatter.name, "weekly-review");
  assert.match(skill.frontmatter.description, /^Use when /u);
  assert.match(skill.body, /`tasks`/u);
  assert.match(skill.body, /`glob`/u);
  assert.match(skill.body, /cwd="\$VAULT"/u);
  assert.match(skill.body, /`memory_search`/u);
  assert.match(skill.body, /(?:seven|7) available daily summaries/iu);
  assert.match(skill.body, /(?:one|1)[-–](?:two|2)|1–2/iu);
  assert.match(skill.body, /STABLE/u);
  assert.match(skill.body, /NEW/u);
  assert.match(skill.body, /CONFLICTING/u);
  assert.match(skill.body, /CHANGED/u);
  assert.match(skill.body, /(?:three|3) next-week priorities/iu);
  assert.match(skill.body, /vault-relative/u);
  assert.match(skill.body, /telegram:message/u);
  assert.match(skill.body, /every memory-derived claim/iu);
  assert.match(skill.body, /do not create, modify, or send/iu);
});

test("Telegram routes chief-of-staff commands through the bounded classifier", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../agent/channels/telegram.ts", import.meta.url)),
    "utf8",
  );

  assert.match(source, /chiefOfStaffCommand\(cmdText\)/u);
  assert.match(source, /chief-of-staff-today/u);
  assert.match(source, /relationship-briefing/u);
  assert.match(source, /weekly-review/u);
  assert.match(source, /personMemoryCommand\(cmdText\)/u);
  assert.match(source, /person-memory/u);
});

test("core instructions expose all chief-of-staff workflows", () => {
  for (const relativePath of [
    "agent/instructions.md",
    "agent/instructions/10-map.md",
  ]) {
    const source = readFileSync(
      new URL(`../${relativePath}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /chief-of-staff-today/u, relativePath);
    assert.match(source, /relationship-briefing/u, relativePath);
    assert.match(source, /weekly-review/u, relativePath);
    assert.match(source, /person-memory/u, relativePath);
  }

  const rootInstructions = readFileSync(
    new URL("../agent/instructions.md", import.meta.url),
    "utf8",
  );
  assert.match(
    rootInstructions,
    /обычным ответом через штатный Telegram renderer/u,
  );
  assert.match(rootInstructions, /НЕ вызывай `send_rich\.py`/u);
});
