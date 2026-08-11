import { readFileSync } from "node:fs";

const SCHEMA = "iva-contact-backfill-operator/v1";
const DRY_RUN_SCHEMA = "iva-contact-backfill-dry-run/v1";
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_ERROR = /^[a-z0-9_]+$/u;
const PHASES = new Set([
  "inventory",
  "running",
  "complete",
  "failed",
  "rolled_back",
]);
const BOOLEAN_FIELDS = [
  "backupReady",
  "backupVerified",
  "inventoryComplete",
  "incrementalHandoffComplete",
] as const;
const COUNT_FIELDS = [
  "privateChats",
  "completedChats",
  "pendingChats",
  "failedChats",
  "processedMessages",
  "skippedMessages",
  "pendingBatches",
  "highWaterReachedChats",
] as const;
const DRY_RUN_COUNT_FIELDS = [
  "privateChats",
  "completedChats",
  "failedChats",
  "processedMessages",
  "skippedMessages",
] as const;
const EXPECTED_KEYS = [
  "schema",
  "runId",
  "phase",
  ...BOOLEAN_FIELDS,
  ...COUNT_FIELDS,
  "errorCodes",
].sort();

function validSummary(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const summary = value as Record<string, unknown>;
  if (summary.schema === DRY_RUN_SCHEMA) {
    const dryRunKeys = [
      "schema",
      "privateChats",
      "completedChats",
      "failedChats",
      "processedMessages",
      "skippedMessages",
    ].sort();
    return (
      JSON.stringify(Object.keys(summary).sort()) ===
        JSON.stringify(dryRunKeys) &&
      DRY_RUN_COUNT_FIELDS.every(
        (field) =>
          Object.hasOwn(summary, field) &&
          Number.isSafeInteger(summary[field]) &&
          Number(summary[field]) >= 0,
      ) &&
      summary.skippedMessages === 0
    );
  }
  if (
    JSON.stringify(Object.keys(summary).sort()) !==
      JSON.stringify(EXPECTED_KEYS) ||
    summary.schema !== SCHEMA ||
    typeof summary.runId !== "string" ||
    !RUN_ID.test(summary.runId) ||
    typeof summary.phase !== "string" ||
    !PHASES.has(summary.phase)
  ) {
    return false;
  }
  if (BOOLEAN_FIELDS.some((field) => typeof summary[field] !== "boolean")) {
    return false;
  }
  if (
    COUNT_FIELDS.some(
      (field) =>
        !Number.isSafeInteger(summary[field]) || Number(summary[field]) < 0,
    ) ||
    summary.skippedMessages !== 0
  ) {
    return false;
  }
  return (
    Array.isArray(summary.errorCodes) &&
    summary.errorCodes.length <= 100 &&
    summary.errorCodes.every(
      (code) => typeof code === "string" && SAFE_ERROR.test(code),
    )
  );
}

const raw = readFileSync(0, "utf8");
if (Buffer.byteLength(raw) > 64 * 1024) process.exit(1);

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!validSummary(parsed)) process.exit(1);
process.stdout.write(`${JSON.stringify(parsed)}\n`);
