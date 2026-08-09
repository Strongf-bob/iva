import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { acquireLock, atomicWrite } from "../../agent/lib/card-store.ts";
import {
  ClarificationQuestionSchema,
  TelegramDialogSchema,
  type ClarificationQuestion,
  type TelegramDialog,
} from "./types.ts";

const START = "<!-- iva:contact-questions:start -->";
const END = "<!-- iva:contact-questions:end -->";
const STATE_PREFIX = "<!-- iva:contact-questions:state:";
const QUESTION_BLOCK =
  /<!-- iva:question:([a-f0-9]{64}):start -->\n([\s\S]*?)\n<!-- iva:question:\1:end -->/gu;

const WorkbookEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  dialog: TelegramDialogSchema,
  question: ClarificationQuestionSchema,
});
const WorkbookStateSchema = z.strictObject({
  entries: z.array(WorkbookEntrySchema),
});
type WorkbookState = z.infer<typeof WorkbookStateSchema>;

export interface UpdateQuestionWorkbookInput {
  vault: string;
  dialog: TelegramDialog;
  questions: readonly ClarificationQuestion[];
}

export interface UpdateQuestionWorkbookResult {
  file: string;
  questionIds: string[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function clarificationQuestionId(
  question: ClarificationQuestion,
): string {
  return createHash("sha256")
    .update(canonicalJson(ClarificationQuestionSchema.parse(question)))
    .digest("hex");
}

function safeInline(value: string): string {
  return (
    value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/<!--/gu, "&lt;!--")
      .replace(/-->/gu, "--&gt;")
      .replace(/\s+/gu, " ")
      .trim() || "Telegram chat"
  );
}

function readState(text: string): WorkbookState {
  const start = text.indexOf(START);
  if (start === -1) return { entries: [] };
  const end = text.indexOf(END, start + START.length);
  if (end === -1) throw new Error("question workbook managed region is open");
  const region = text.slice(start, end + END.length);
  const stateStart = region.indexOf(STATE_PREFIX);
  if (stateStart === -1) throw new Error("question workbook state is missing");
  const payloadStart = stateStart + STATE_PREFIX.length;
  const payloadEnd = region.indexOf(" -->", payloadStart);
  if (payloadEnd === -1)
    throw new Error("question workbook state is malformed");
  try {
    const decoded = Buffer.from(
      region.slice(payloadStart, payloadEnd),
      "base64url",
    ).toString("utf8");
    return WorkbookStateSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("question workbook state is invalid");
  }
}

function readAnswers(text: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const match of text.matchAll(QUESTION_BLOCK)) {
    const id = match[1];
    const body = match[2];
    const marker = "\n**Answer:**\n\n";
    const index = body.indexOf(marker);
    if (!id || index === -1) continue;
    const answer = body.slice(index + marker.length).trim();
    if (answer && answer !== "<!-- write here -->") answers.set(id, answer);
  }
  return answers;
}

function renderEntry(
  entry: z.infer<typeof WorkbookEntrySchema>,
  index: number,
  answer: string | undefined,
): string {
  const question = entry.question;
  const evidence = question.evidence
    .map(
      (item) =>
        `\`telegram:message:${item.chatId}:${item.messageId}\` (${item.timestamp})`,
    )
    .join(", ");
  return [
    `<!-- iva:question:${entry.id}:start -->`,
    `### Question ${index}`,
    "",
    safeInline(question.question),
    "",
    `**Why:** ${safeInline(question.reason)}`,
    "",
    `**Subject:** \`${question.subjectId}\``,
    "",
    `**Evidence:** ${evidence}`,
    "",
    "**Answer:**",
    "",
    answer ?? "<!-- write here -->",
    `<!-- iva:question:${entry.id}:end -->`,
  ].join("\n");
}

function renderManaged(
  state: WorkbookState,
  answers: ReadonlyMap<string, string>,
): string {
  const normalized = WorkbookStateSchema.parse({
    entries: [...state.entries].sort(
      (left, right) =>
        left.dialog.id - right.dialog.id || left.id.localeCompare(right.id),
    ),
  });
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString(
    "base64url",
  );
  const groups = new Map<number, typeof normalized.entries>();
  for (const entry of normalized.entries) {
    const items = groups.get(entry.dialog.id) ?? [];
    items.push(entry);
    groups.set(entry.dialog.id, items);
  }
  const body: string[] = [
    START,
    `${STATE_PREFIX}${encoded} -->`,
    "## Questions",
    "",
  ];
  if (groups.size === 0) body.push("No clarification questions yet.");
  for (const entries of groups.values()) {
    body.push(`## ${safeInline(entries[0].dialog.title)}`, "");
    entries.forEach((entry, index) => {
      body.push(renderEntry(entry, index + 1, answers.get(entry.id)), "");
    });
  }
  body.push(END);
  return body.join("\n");
}

function replaceManaged(text: string, rendered: string): string {
  const start = text.indexOf(START);
  if (start === -1) {
    const header = text.trimEnd() || "# Contact analysis questions";
    return `${header}\n\n${rendered}\n`;
  }
  const end = text.indexOf(END, start + START.length);
  if (end === -1) throw new Error("question workbook managed region is open");
  return `${text.slice(0, start)}${rendered}${text.slice(end + END.length)}`;
}

// eslint-disable-next-line @typescript-eslint/require-await -- synchronous atomic storage implements the async reducer boundary.
export async function updateQuestionWorkbook({
  vault,
  dialog: rawDialog,
  questions: rawQuestions,
}: UpdateQuestionWorkbookInput): Promise<UpdateQuestionWorkbookResult> {
  const dialog = TelegramDialogSchema.parse(rawDialog);
  const questions = rawQuestions.map((question) =>
    ClarificationQuestionSchema.parse(question),
  );
  const file = join(vault, "inbox", "contact-analysis-questions.md");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const release = acquireLock(file);
  try {
    const original = existsSync(file) ? readFileSync(file, "utf8") : "";
    const state = readState(original);
    const answers = readAnswers(original);
    const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
    const questionIds: string[] = [];
    for (const question of questions) {
      const id = clarificationQuestionId(question);
      questionIds.push(id);
      entries.set(id, { id, dialog, question });
    }
    state.entries = [...entries.values()];
    const rendered = replaceManaged(original, renderManaged(state, answers));
    if (rendered !== original) atomicWrite(file, rendered);
    return { file, questionIds };
  } finally {
    release();
  }
}
