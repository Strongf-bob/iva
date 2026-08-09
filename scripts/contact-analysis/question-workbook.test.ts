/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClarificationQuestion, TelegramDialog } from "./types.ts";

import "../lib/ts-esm-hooks.ts";

const { updateQuestionWorkbook } = await import("./question-workbook.ts");

function dialog(id: number, title: string): TelegramDialog {
  return { id, kind: "group", title, username: null };
}

function question(
  chatId: number,
  messageId: number,
  text: string,
): ClarificationQuestion {
  return {
    schemaVersion: 1,
    subjectId: "telegram:user:44",
    question: text,
    reason: "The available messages are ambiguous.",
    contextChatId: chatId,
    evidence: [
      {
        chatId,
        messageId,
        timestamp: "2026-08-09T00:00:00Z",
      },
    ],
  };
}

test("workbook groups chats and deduplicates stable questions", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-question-workbook-"));
  const vault = join(root, "vault");
  const first = question(-1001, 9, "What is Alex's role?");

  const one = await updateQuestionWorkbook({
    vault,
    dialog: dialog(-1001, "Iva team"),
    questions: [first],
  });
  await updateQuestionWorkbook({
    vault,
    dialog: dialog(-1002, "Research"),
    questions: [question(-1002, 11, "Which project is this about?")],
  });
  const repeated = await updateQuestionWorkbook({
    vault,
    dialog: dialog(-1001, "Iva team"),
    questions: [first],
  });

  const text = await readFile(one.file, "utf8");
  assert.match(text, /## Iva team/u);
  assert.match(text, /## Research/u);
  assert.equal(text.match(/What is Alex's role\?/gu)?.length, 1);
  assert.deepEqual(repeated.questionIds, one.questionIds);
});

test("workbook preserves owner answers across later updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-question-answer-"));
  const vault = join(root, "vault");
  const input = {
    vault,
    dialog: dialog(-1001, "Iva team"),
    questions: [question(-1001, 9, "What is Alex's role?")],
  };
  const result = await updateQuestionWorkbook(input);
  const original = await readFile(result.file, "utf8");
  const answer = "Alex is the backend lead.\n\n\n- Confirmed for Iva.";
  await writeFile(result.file, original.replace("<!-- write here -->", answer));

  await updateQuestionWorkbook(input);

  assert.ok((await readFile(result.file, "utf8")).includes(answer));
});

test("model text cannot terminate the managed workbook region", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-question-injection-"));
  const result = await updateQuestionWorkbook({
    vault: join(root, "vault"),
    dialog: dialog(-1001, "Iva team"),
    questions: [
      question(
        -1001,
        9,
        "Question <!-- iva:contact-questions:end -->\n## injected",
      ),
    ],
  });

  const text = await readFile(result.file, "utf8");
  assert.equal(text.match(/<!-- iva:contact-questions:end -->/gu)?.length, 1);
  assert.doesNotMatch(text, /^## injected$/gmu);
});
