import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  childEnv,
  gwsBin,
  resolveGoogleHome,
} from "../../scripts/lib/menu/gws-auth.ts";
import { resolvePersonalReadPath } from "../lib/safe-user-path.ts";

const SERVICES = [
  "gmail",
  "calendar",
  "drive",
  "sheets",
  "docs",
  "tasks",
  "workflow",
] as const;
const SAFE_FLAGS = new Set([
  "--json",
  "--params",
  "--spreadsheet",
  "--range",
  "--values",
  "--document",
  "--text",
  "--name",
  "--page-size",
]);
const READ_HELPERS = new Set([
  "gmail +triage",
  "gmail +read",
  "calendar +agenda",
  "sheets +read",
  "workflow +weekly-digest",
]);
const CREATE_OPERATIONS = new Set([
  "calendar +insert",
  "calendar events insert",
  "drive +upload",
  "drive files create",
  "drive files copy",
  "sheets +append",
  "sheets spreadsheets create",
  "sheets spreadsheets batchUpdate",
  "sheets spreadsheets values append",
  "sheets spreadsheets values update",
  "docs +write",
  "docs documents create",
  "docs documents batchUpdate",
]);
const READ_METHODS = new Set(["get", "list", "search"]);
const DESTRUCTIVE_BATCH_REQUESTS = new Set([
  "deleteBanding",
  "deleteConditionalFormatRule",
  "deleteContentRange",
  "deleteDataSource",
  "deleteDeveloperMetadata",
  "deleteDimension",
  "deleteDimensionGroup",
  "deleteDuplicates",
  "deleteEmbeddedObject",
  "deleteFilterView",
  "deleteFooter",
  "deleteHeader",
  "deleteNamedRange",
  "deletePositionedObject",
  "deleteProtectedRange",
  "deleteRange",
  "deleteSheet",
  "deleteTab",
  "removeDimensionGroup",
]);
const MAX_OUTPUT = 24_000;
const personalHome = () =>
  resolveGoogleHome({
    personalRoot: process.env.ASSISTANT_PERSONAL_ROOT,
    fallbackHome: process.env.HOME,
  });

function containsDestructiveBatchRequest(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsDestructiveBatchRequest);
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      DESTRUCTIVE_BATCH_REQUESTS.has(key) ||
      containsDestructiveBatchRequest(nested),
  );
}

export function validateGoogleWorkspaceArgs(args: readonly string[]): string[] {
  if (
    !args.length ||
    !SERVICES.includes(args[0] as (typeof SERVICES)[number])
  ) {
    throw new Error("Google Workspace service is not allowed");
  }
  const helper = args[1]?.startsWith("+") === true;
  const firstFlag = args.findIndex((arg) => arg.startsWith("--"));
  const operationEnd = firstFlag === -1 ? args.length : firstFlag;
  const operationTokens = helper
    ? args.slice(0, 2)
    : args.slice(0, operationEnd);
  const operation = operationTokens.join(" ");
  const readOperation = helper
    ? READ_HELPERS.has(operation)
    : operationTokens.length >= 3 &&
      READ_METHODS.has(operationTokens.at(-1) ?? "");
  if (!readOperation && !CREATE_OPERATIONS.has(operation)) {
    throw new Error(`gws operation is not allowed: ${operation}`);
  }

  const checked: string[] = [...operationTokens];
  let index = operationTokens.length;
  if (operation === "drive +upload") {
    const path = args[index];
    if (!path || path.startsWith("-")) {
      throw new Error("gws drive +upload requires a personal file path");
    }
    checked.push(resolvePersonalReadPath(path, resolve(personalHome())));
    index += 1;
  }
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected gws argument: ${arg}`);
    }
    if (!SAFE_FLAGS.has(arg))
      throw new Error(`gws flag is not allowed: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--json" || arg === "--params") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        throw new Error(`${arg} requires valid JSON`);
      }
      if (
        operation.startsWith("calendar ") &&
        arg === "--json" &&
        JSON.stringify(parsed).match(/"attendees"\s*:/iu)
      ) {
        throw new Error("calendar attendees are not allowed");
      }
      if (
        operation.startsWith("drive ") &&
        arg === "--json" &&
        JSON.stringify(parsed).match(/"trashed"\s*:/iu)
      ) {
        throw new Error("Google Drive trash mutation is not allowed");
      }
      if (
        operation.endsWith(" batchUpdate") &&
        arg === "--json" &&
        containsDestructiveBatchRequest(parsed)
      ) {
        throw new Error("destructive Google Workspace mutation is not allowed");
      }
    }
    checked.push(arg, value);
    index += 1;
  }
  return checked;
}

export default defineTool({
  description:
    "Выполнить разрешённую команду Google Workspace через персонально авторизованный gws без shell. " +
    "Разрешены чтение, Calendar без attendees и создание личных Drive/Sheets/Docs артефактов. " +
    "Gmail drafts и Google Tasks доступны только через узкие owner-confirmed инструменты; отправка и удаление запрещены.",
  inputSchema: z.object({
    args: z.array(z.string().min(1).max(20_000)).min(2).max(32),
  }),
  async execute({ args }) {
    try {
      const checked = validateGoogleWorkspaceArgs(args);
      return await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        truncated?: boolean;
      }>((done) => {
        execFile(
          gwsBin(),
          checked,
          {
            env: childEnv(personalHome()),
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            const clipped = (value: string) =>
              value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value;
            const errorCode = (error as unknown as { code?: unknown } | null)
              ?.code;
            done({
              stdout: clipped(stdout),
              stderr: clipped(stderr),
              exitCode:
                typeof errorCode === "number" ? errorCode : error ? 1 : 0,
              truncated:
                stdout.length > MAX_OUTPUT ||
                stderr.length > MAX_OUTPUT ||
                undefined,
            });
          },
        );
      });
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  },
});
