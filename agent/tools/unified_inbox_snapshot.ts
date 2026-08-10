import { defineTool } from "eve/tools";
import { z } from "zod";
import { lstat, readFile } from "node:fs/promises";

import {
  InboxStateSchema,
  inboxStatePaths,
} from "../../scripts/unified-inbox/state.ts";
import {
  OwnerIdSchema,
  truncateCodePoints,
} from "../../scripts/unified-inbox/types.ts";

const MAX_ITEMS = 10;

async function readSnapshot(paths: ReturnType<typeof inboxStatePaths>) {
  for (const [path, kind] of [
    ...paths.guardPaths.map((path) => [path, "directory"] as const),
    [paths.dataRoot, "directory"] as const,
    [paths.baseDir, "directory"] as const,
    [paths.ownerDir, "directory"] as const,
    [paths.stateFile, "file"] as const,
  ]) {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (kind === "directory" ? !info.isDirectory() : !info.isFile())
    ) {
      throw new Error("snapshot_path_invalid");
    }
  }
  const raw = await readFile(paths.stateFile, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const result = InboxStateSchema.safeParse(parsed);
  if (!result.success || result.data.ownerId !== paths.ownerId) {
    throw new Error("snapshot_schema_invalid");
  }
  return result.data;
}

function ownerId(): string | null {
  const direct =
    process.env.ASSISTANT_USER_ID ?? process.env.TELEGRAM_DIGEST_CHAT_ID;
  if (direct) {
    const parsed = OwnerIdSchema.safeParse(direct.trim());
    return parsed.success ? parsed.data : null;
  }
  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed.length !== 1) return null;
  const parsed = OwnerIdSchema.safeParse(allowed[0]);
  return parsed.success ? parsed.data : null;
}

export default defineTool({
  description:
    "Read the current owner's already-collected unified inbox snapshot for a private review. " +
    "Returns bounded urgent and reply-needed observations with evidence locators. Read-only: " +
    "does not recollect, send, draft, mark read, or mutate provider or local state.",
  inputSchema: z.strictObject({}),
  async execute() {
    if (
      process.env.ASSISTANT_MULTI_USER === "1" &&
      process.env.ASSISTANT_ROLE !== "owner"
    ) {
      return { ok: false, error: "owner_only" };
    }
    const assignedOwner = ownerId();
    if (assignedOwner === null) {
      return { ok: false, error: "owner_unavailable" };
    }
    try {
      const paths = inboxStatePaths(
        process.env.ASSISTANT_APP_DIR ?? process.cwd(),
        process.env.ASSISTANT_DATA_DIR ?? "data",
        assignedOwner,
      );
      const state = await readSnapshot(paths);
      const totalActionable = Object.values(state.classifications).filter(
        (category) => category === "urgent" || category === "needs_reply",
      ).length;
      const items = Object.entries(state.classifications)
        .filter(
          ([, category]) => category === "urgent" || category === "needs_reply",
        )
        .flatMap(([id, category]) => {
          const observation = state.observations[id];
          return observation ? [{ observation, category }] : [];
        })
        .sort(
          (left, right) =>
            Date.parse(right.observation.occurredAt) -
              Date.parse(left.observation.occurredAt) ||
            left.observation.id.localeCompare(right.observation.id),
        )
        .slice(0, MAX_ITEMS)
        .map(({ observation, category }) => ({
          category,
          source: observation.source,
          occurredAt: observation.occurredAt,
          title: observation.title
            ? truncateCodePoints(observation.title, 160)
            : null,
          excerpt: truncateCodePoints(observation.excerpt, 300),
          evidence: {
            locator: observation.evidence.locator,
            timestamp: observation.evidence.timestamp,
          },
        }));
      return {
        ok: true,
        lastReport: state.lastReport,
        sourceHealth: state.sourceHealth,
        totalActionable,
        truncated: totalActionable > items.length,
        items,
      };
    } catch {
      return { ok: false, error: "snapshot_unavailable" };
    }
  },
});
