import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import { createTelegramAnalysisClient } from "./contact-analysis/telegram-client.ts";
import { createModelInboxClassifier } from "./unified-inbox/classifier.ts";
import {
  createCalendarInboxSource,
  createGmailInboxSource,
} from "./unified-inbox/google-source.ts";
import {
  runUnifiedInbox,
  type UnifiedInboxResult,
} from "./unified-inbox/pipeline.ts";
import { inboxStatePaths } from "./unified-inbox/state.ts";
import { createTelegramInboxSource } from "./unified-inbox/telegram-source.ts";
import { OwnerIdSchema } from "./unified-inbox/types.ts";

export interface UnifiedInboxPolicy {
  ownerId: string;
  targetChatId: string;
}

function firstAllowedUser(value: string | undefined): string | undefined {
  return value
    ?.split(/[\s,]+/u)
    .map((candidate) => candidate.trim())
    .find(Boolean);
}

export function validateUnifiedInboxPolicy(
  env: NodeJS.ProcessEnv,
): UnifiedInboxPolicy {
  if (env.TELEGRAM_EXPOSED_TOOLS !== "read-only") {
    throw new Error("unified_inbox_telegram_requires_read_only");
  }
  if (env.ASSISTANT_MULTI_USER === "1" && env.ASSISTANT_ROLE !== "owner") {
    throw new Error("unified_inbox_owner_only");
  }
  const ownerId = OwnerIdSchema.parse(
    env.ASSISTANT_USER_ID ??
      env.TELEGRAM_DIGEST_CHAT_ID ??
      firstAllowedUser(env.TELEGRAM_ALLOWED_USER_IDS),
  );
  const targetChatId = OwnerIdSchema.parse(
    env.TELEGRAM_DIGEST_CHAT_ID ?? ownerId,
  );
  if (targetChatId !== ownerId) {
    throw new Error("unified_inbox_report_owner_mismatch");
  }
  return { ownerId, targetChatId };
}

interface RunRealUnifiedInboxOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
}

async function runRealUnifiedInbox(
  policy: UnifiedInboxPolicy,
  { env = process.env, root = process.cwd() }: RunRealUnifiedInboxOptions = {},
): Promise<UnifiedInboxResult> {
  const dataDir = env.ASSISTANT_DATA_DIR ?? "data";
  const resolvedDataDir = isAbsolute(dataDir) ? dataDir : join(root, dataDir);
  const tokenPath =
    env.ASSISTANT_MULTI_USER === "1"
      ? join(env.ASSISTANT_APP_DIR ?? root, "data", "telegram-userbot.token")
      : undefined;
  const telegramClient = createTelegramAnalysisClient({
    root,
    dataDir: resolvedDataDir,
    ...(tokenPath ? { tokenPath } : {}),
  });
  return runUnifiedInbox({
    paths: inboxStatePaths(root, resolvedDataDir, policy.ownerId),
    ownerId: policy.ownerId,
    targetChatId: policy.targetChatId,
    sources: [
      createTelegramInboxSource({ client: telegramClient, env }),
      createGmailInboxSource(),
      createCalendarInboxSource(),
    ],
    classifier: createModelInboxClassifier(),
  });
}

export interface UnifiedInboxCommandDependencies {
  env?: NodeJS.ProcessEnv;
  root?: string;
  writeOutput?: (line: string) => void;
  runImpl?: (policy: UnifiedInboxPolicy) => Promise<UnifiedInboxResult>;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(unified_inbox|telegram_analysis)_[a-z0-9_]+$/u.test(message)
    ? message
    : "unified_inbox_failed";
}

function validArguments(argv: readonly string[]): boolean {
  return (
    argv[0] === "run" &&
    argv.slice(1).every((argument) => argument === "--json") &&
    argv.filter((argument) => argument === "--json").length <= 1
  );
}

export async function runUnifiedInboxCommand(
  argv: readonly string[],
  {
    env = process.env,
    root = process.cwd(),
    writeOutput = (line) => console.log(line),
    runImpl = (policy) => runRealUnifiedInbox(policy, { env, root }),
  }: UnifiedInboxCommandDependencies = {},
): Promise<number> {
  if (!validArguments(argv)) {
    writeOutput("unified_inbox_usage_error");
    return 1;
  }
  try {
    const policy = validateUnifiedInboxPolicy(env);
    const result = await runImpl(policy);
    writeOutput(
      argv.includes("--json")
        ? JSON.stringify(result.envelope)
        : result.envelope.text,
    );
    return result.report.partial ? 2 : 0;
  } catch (error) {
    writeOutput(safeErrorCode(error));
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  process.exitCode = await runUnifiedInboxCommand(process.argv.slice(2));
}
