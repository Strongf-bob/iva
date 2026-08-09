import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { childEnv, gwsBin } from "../../scripts/lib/menu/gws-auth.ts";
import { resolvePersonalReadPath } from "../lib/safe-user-path.ts";

const SERVICES = [
  "gmail",
  "calendar",
  "drive",
  "sheets",
  "docs",
  "tasks",
] as const;
const SAFE_FLAGS = new Set([
  "--to",
  "--subject",
  "--body",
  "--message-id",
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
const MAX_OUTPUT = 24_000;
const personalHome = () =>
  process.env.ASSISTANT_PERSONAL_ROOT || process.env.HOME || homedir();

export function validateGoogleWorkspaceArgs(args: readonly string[]): string[] {
  if (
    !args.length ||
    !SERVICES.includes(args[0] as (typeof SERVICES)[number])
  ) {
    throw new Error("Google Workspace service is not allowed");
  }
  const service = args[0];
  const firstFlag = args.findIndex(
    (arg, index) => index > 0 && arg.startsWith("--"),
  );
  const command = args.slice(1, firstFlag < 0 ? args.length : firstFlag);
  const signature = command.join(" ");
  const method = command.at(-1) ?? "";
  const readMethods = new Set(["get", "list"]);
  const allowed = (() => {
    if (service === "gmail")
      return signature === "+triage" || readMethods.has(method);
    if (service === "calendar")
      return (
        signature === "+agenda" ||
        signature === "+insert" ||
        readMethods.has(method) ||
        (command.at(-2) === "events" && method === "insert")
      );
    if (service === "tasks") return readMethods.has(method);
    if (service === "drive")
      return (
        command[0] === "+upload" ||
        readMethods.has(method) ||
        (command.at(-2) === "files" &&
          new Set(["create", "copy", "update"]).has(method))
      );
    if (service === "docs")
      return (
        command[0] === "+write" ||
        readMethods.has(method) ||
        (command.at(-2) === "documents" &&
          new Set(["create", "batchUpdate"]).has(method))
      );
    if (service === "sheets")
      return (
        new Set(["+read", "+append"]).has(command[0]) ||
        readMethods.has(method) ||
        new Set(["create", "batchUpdate", "append", "update"]).has(method)
      );
    return false;
  })();
  if (!allowed) throw new Error(`${service} operation is not allowed`);
  if (service === "drive" && command.includes("permissions")) {
    if (!readMethods.has(method))
      throw new Error("Google Drive permission mutation is not allowed");
  }
  const jsonIndex = args.indexOf("--json");
  let payload: unknown;
  if (jsonIndex >= 0) {
    try {
      payload = JSON.parse(args[jsonIndex + 1] ?? "");
    } catch {
      throw new Error(`${service} --json must be valid JSON`);
    }
  }
  if (service === "calendar" && jsonIndex >= 0) {
    if (
      typeof payload === "object" &&
      payload !== null &&
      Object.prototype.hasOwnProperty.call(payload, "attendees")
    ) {
      throw new Error("Calendar attendees are not allowed");
    }
  }
  if (
    service === "drive" &&
    jsonIndex >= 0 &&
    typeof payload === "object" &&
    payload !== null &&
    Object.prototype.hasOwnProperty.call(payload, "trashed")
  ) {
    throw new Error("Google Drive trash mutation is not allowed");
  }
  const checked: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("-")) {
      if (!SAFE_FLAGS.has(arg))
        throw new Error(`gws flag is not allowed: ${arg}`);
      if (index + 1 >= args.length) throw new Error(`${arg} requires a value`);
    }
    if (arg === "+upload") {
      const path = args[index + 1];
      if (!path || path.startsWith("-"))
        throw new Error("gws drive +upload requires a personal file path");
      checked.push(arg, resolvePersonalReadPath(path, resolve(personalHome())));
      index += 1;
      continue;
    }
    checked.push(arg);
  }
  return checked;
}

export default defineTool({
  description:
    "Выполнить одну команду Google Workspace через персонально авторизованный gws без shell. " +
    "Передай argv без слова gws. Поддерживаются Gmail, Calendar, Drive, Sheets, Docs и Tasks.",
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
