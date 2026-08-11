import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { saveJsonAtomic } from "../../agent/lib/json-store.ts";
import { parseTelegramUserId, type TelegramUserId } from "./user-registry.ts";

export const CONTAINER_COMMAND_SCHEMA = "iva-container-command/v1" as const;
export const CONTAINER_RECEIPT_SCHEMA = "iva-container-receipt/v1" as const;
export const CONTAINER_STATUS_SCHEMA =
  "iva-container-runtime-status/v1" as const;

export type ContainerAction =
  "start-worker" | "stop-worker" | "pause-poller" | "resume-poller";

export type ContainerCommandInput =
  | { action: "start-worker" | "stop-worker"; userId: string }
  | { action: "pause-poller" | "resume-poller" };

export type ClaimedContainerCommand = {
  schema: typeof CONTAINER_COMMAND_SCHEMA;
  operationId: string;
  action: ContainerAction;
  userId: TelegramUserId | null;
  createdAt: string;
};

export type ContainerCommandReceipt = {
  schema: typeof CONTAINER_RECEIPT_SCHEMA;
  operationId: string;
  action: ContainerAction;
  userId: TelegramUserId | null;
  ok: boolean;
  message: string;
  completedAt: string;
};

export type ContainerProcessStatus = {
  state: "running" | "stopped" | "backoff";
  pid: number | null;
  restarts: number;
};

export type ContainerWorkerStatus = ContainerProcessStatus & {
  port: number;
};

export type ContainerRuntimeStatus = {
  schema: typeof CONTAINER_STATUS_SCHEMA;
  supervisorPid: number;
  updatedAt: string;
  poller: ContainerProcessStatus;
  workers: Record<string, ContainerWorkerStatus>;
};

export type ContainerControlPaths = {
  root: string;
  requests: string;
  processing: string;
  receipts: string;
  status: string;
};

type SubmitOptions = {
  operationId?: string;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const TelegramUserIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/u)
  .transform((value) => value as TelegramUserId);
const OperationIdSchema = z.uuid();
const WorkerInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start-worker"),
    userId: TelegramUserIdSchema,
  }),
  z.strictObject({
    action: z.literal("stop-worker"),
    userId: TelegramUserIdSchema,
  }),
  z.strictObject({ action: z.literal("pause-poller") }),
  z.strictObject({ action: z.literal("resume-poller") }),
]);
const CommandSchema = z.strictObject({
  schema: z.literal(CONTAINER_COMMAND_SCHEMA),
  operationId: OperationIdSchema,
  action: z.enum([
    "start-worker",
    "stop-worker",
    "pause-poller",
    "resume-poller",
  ]),
  userId: TelegramUserIdSchema.nullable(),
  createdAt: z.iso.datetime(),
});
const ReceiptSchema = z.strictObject({
  schema: z.literal(CONTAINER_RECEIPT_SCHEMA),
  operationId: OperationIdSchema,
  action: CommandSchema.shape.action,
  userId: TelegramUserIdSchema.nullable(),
  ok: z.boolean(),
  message: z.string().max(500),
  completedAt: z.iso.datetime(),
});
const ProcessStatusSchema = z.strictObject({
  state: z.enum(["running", "stopped", "backoff"]),
  pid: z.number().int().positive().nullable(),
  restarts: z.number().int().nonnegative(),
});
const WorkerStatusSchema = ProcessStatusSchema.extend({
  port: z.number().int().min(1).max(65_535),
});
const RuntimeStatusSchema = z.strictObject({
  schema: z.literal(CONTAINER_STATUS_SCHEMA),
  supervisorPid: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  poller: ProcessStatusSchema,
  workers: z.record(
    z.string().regex(/^[1-9][0-9]{0,19}$/u),
    WorkerStatusSchema,
  ),
});

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `container control directory must not be a symbolic link: ${path}`,
    );
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory()) {
    throw new Error(`container control path is not a directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function ensureControlPaths(controlDir: string): ContainerControlPaths {
  const paths = resolveContainerControlPaths(controlDir);
  for (const path of [
    paths.root,
    paths.requests,
    paths.processing,
    paths.receipts,
  ]) {
    ensurePrivateDirectory(path);
  }
  return paths;
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid container control JSON: ${path}`, {
      cause: error,
    });
  }
}

function parseCommand(value: unknown): ClaimedContainerCommand {
  const parsed = CommandSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid container command: ${z.prettifyError(parsed.error)}`,
    );
  }
  const workerAction =
    parsed.data.action === "start-worker" ||
    parsed.data.action === "stop-worker";
  if (workerAction !== (parsed.data.userId !== null)) {
    throw new Error("invalid container command: action and userId disagree");
  }
  return parsed.data;
}

function parseReceipt(value: unknown): ContainerCommandReceipt {
  const parsed = ReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid container command receipt: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function sameCommand(
  left: Pick<ClaimedContainerCommand, "operationId" | "action" | "userId">,
  right: Pick<ClaimedContainerCommand, "operationId" | "action" | "userId">,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.action === right.action &&
    left.userId === right.userId
  );
}

function receiptPath(
  paths: ContainerControlPaths,
  operationId: string,
): string {
  return join(paths.receipts, `${operationId}.json`);
}

function commandPath(directory: string, operationId: string): string {
  return join(directory, `${operationId}.json`);
}

export function resolveContainerControlPaths(
  controlDir: string,
): ContainerControlPaths {
  const root = join(controlDir, "container-runtime");
  return {
    root,
    requests: join(root, "requests"),
    processing: join(root, "processing"),
    receipts: join(root, "receipts"),
    status: join(root, "status.json"),
  };
}

export async function submitContainerCommand(
  controlDir: string,
  input: ContainerCommandInput,
  {
    operationId = randomUUID(),
    timeoutMs = 15_000,
    intervalMs = 50,
    now = Date.now,
    sleep = (milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  }: SubmitOptions = {},
): Promise<ContainerCommandReceipt> {
  const parsedInput = WorkerInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const invalidId =
      typeof (input as { userId?: unknown })?.userId === "string" &&
      !parseTelegramUserId((input as { userId: string }).userId);
    throw new Error(
      invalidId
        ? "container command requires a canonical Telegram user id"
        : `invalid container command: ${z.prettifyError(parsedInput.error)}`,
    );
  }
  const parsedOperationId = OperationIdSchema.safeParse(operationId);
  if (!parsedOperationId.success) {
    throw new Error("invalid container command operation id");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("container command timeout must be a positive integer");
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("container command interval must be a positive integer");
  }
  const paths = ensureControlPaths(controlDir);
  const userId = "userId" in parsedInput.data ? parsedInput.data.userId : null;
  const command = parseCommand({
    schema: CONTAINER_COMMAND_SCHEMA,
    operationId: parsedOperationId.data,
    action: parsedInput.data.action,
    userId,
    createdAt: new Date().toISOString(),
  });
  const request = commandPath(paths.requests, command.operationId);
  const processing = commandPath(paths.processing, command.operationId);
  const receipt = receiptPath(paths, command.operationId);
  if (existsSync(receipt)) {
    const existing = parseReceipt(parseJson(receipt));
    if (!sameCommand(existing, command)) {
      throw new Error("container operation id belongs to another command");
    }
    return existing;
  }
  for (const existingPath of [request, processing]) {
    if (!existsSync(existingPath)) continue;
    const existing = parseCommand(parseJson(existingPath));
    if (!sameCommand(existing, command)) {
      throw new Error("container operation id belongs to another command");
    }
  }
  if (!existsSync(request) && !existsSync(processing)) {
    await saveJsonAtomic(request, command);
    chmodSync(request, 0o600);
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    if (existsSync(receipt)) {
      const result = parseReceipt(parseJson(receipt));
      if (!sameCommand(result, command)) {
        throw new Error("container command receipt does not match its request");
      }
      return result;
    }
    if (now() >= deadline) {
      throw new Error(
        `container command ${command.operationId} timed out without a receipt`,
      );
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
  }
}

export function claimContainerCommands(
  controlDir: string,
): ClaimedContainerCommand[] {
  const paths = ensureControlPaths(controlDir);
  const claimed: ClaimedContainerCommand[] = [];
  for (const name of readdirSync(paths.requests).sort()) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(name)) {
      throw new Error(`invalid container command filename: ${name}`);
    }
    const source = join(paths.requests, name);
    const destination = join(paths.processing, name);
    try {
      renameSync(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    claimed.push(parseCommand(parseJson(destination)));
  }
  return claimed;
}

export function recoverClaimedContainerCommands(controlDir: string): void {
  const paths = ensureControlPaths(controlDir);
  for (const name of readdirSync(paths.processing).sort()) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(name)) {
      throw new Error(`invalid claimed container command filename: ${name}`);
    }
    const source = join(paths.processing, name);
    const command = parseCommand(parseJson(source));
    const receipt = receiptPath(paths, command.operationId);
    if (existsSync(receipt)) {
      const completed = parseReceipt(parseJson(receipt));
      if (!sameCommand(completed, command)) {
        throw new Error(
          "container command receipt does not match claimed request",
        );
      }
      rmSync(source, { force: true });
      continue;
    }
    const destination = join(paths.requests, name);
    if (existsSync(destination)) {
      const queued = parseCommand(parseJson(destination));
      if (!sameCommand(queued, command)) {
        throw new Error("conflicting queued and claimed container commands");
      }
      rmSync(source, { force: true });
      continue;
    }
    renameSync(source, destination);
  }
}

export async function completeContainerCommand(
  controlDir: string,
  command: ClaimedContainerCommand,
  result: { ok: boolean; message: string },
): Promise<void> {
  const parsedCommand = parseCommand(command);
  const paths = ensureControlPaths(controlDir);
  const path = receiptPath(paths, parsedCommand.operationId);
  const next = parseReceipt({
    schema: CONTAINER_RECEIPT_SCHEMA,
    operationId: parsedCommand.operationId,
    action: parsedCommand.action,
    userId: parsedCommand.userId,
    ok: result.ok,
    message: result.message,
    completedAt: new Date().toISOString(),
  });
  if (existsSync(path)) {
    const existing = parseReceipt(parseJson(path));
    if (
      !sameCommand(existing, next) ||
      existing.ok !== next.ok ||
      existing.message !== next.message
    ) {
      throw new Error("conflicting container command receipt");
    }
  } else {
    await saveJsonAtomic(path, next);
    chmodSync(path, 0o600);
  }
  rmSync(commandPath(paths.processing, parsedCommand.operationId), {
    force: true,
  });
}

export async function writeContainerRuntimeStatus(
  controlDir: string,
  status: ContainerRuntimeStatus,
): Promise<void> {
  const parsed = RuntimeStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw new Error(
      `invalid container runtime status: ${z.prettifyError(parsed.error)}`,
    );
  }
  const paths = ensureControlPaths(controlDir);
  await saveJsonAtomic(paths.status, parsed.data);
  chmodSync(paths.status, 0o600);
}

export function readContainerRuntimeStatus(
  controlDir: string,
): ContainerRuntimeStatus {
  const paths = ensureControlPaths(controlDir);
  let value: unknown;
  try {
    value = parseJson(paths.status);
  } catch (error) {
    if (!existsSync(paths.status)) {
      throw new Error("container runtime status is unavailable", {
        cause: error,
      });
    }
    throw error;
  }
  const parsed = RuntimeStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid container runtime status: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
