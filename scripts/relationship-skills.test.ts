/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = (name: string) =>
  readFile(
    new URL(`../agent/skills/${name}/SKILL.md`, import.meta.url),
    "utf8",
  );

test("meeting dossier is bounded, cited, and treats sources as untrusted", async () => {
  const text = await skill("relationship-meeting-dossier");
  assert.match(text, /numeric Telegram|unambiguous/u);
  assert.match(text, /at most three|top three/u);
  assert.match(text, /untrusted data/u);
  assert.match(text, /citation|source ID/u);
});

test("reply drafting permits only Telegram suggestions or Gmail drafts", async () => {
  const text = await skill("relationship-reply-draft");
  assert.match(text, /Telegram suggestion/u);
  assert.match(text, /gmail_draft/u);
  assert.doesNotMatch(text, /userbot.*send|send.*Telegram|gmail.*send/u);
});
