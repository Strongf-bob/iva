import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../../agent/lib/json-store.ts";
import {
  emptyRelationshipRegistry,
  RelationshipRegistrySchema,
  type RelationshipRegistry,
} from "./types.ts";

export interface RelationshipPaths {
  baseDir: string;
  registry: string;
  lock: string;
  reportsDir: string;
}

export function relationshipPaths(
  root = process.cwd(),
  dataDir = process.env.ASSISTANT_DATA_DIR ?? "data",
): RelationshipPaths {
  const resolvedData = isAbsolute(dataDir)
    ? resolve(dataDir)
    : resolve(root, dataDir);
  const baseDir = resolve(resolvedData, "relationship-intelligence");
  return {
    baseDir,
    registry: resolve(baseDir, "commitments.json"),
    lock: resolve(baseDir, "commitments.json.lock"),
    reportsDir: resolve(baseDir, "reports"),
  };
}

async function ensurePrivate(paths: RelationshipPaths): Promise<void> {
  await mkdir(paths.baseDir, { recursive: true, mode: 0o700 });
  await chmod(paths.baseDir, 0o700);
}

export async function loadRegistry(
  paths: RelationshipPaths,
): Promise<RelationshipRegistry> {
  const raw = await loadJsonStrict<unknown>(
    paths.registry,
    emptyRelationshipRegistry(),
  );
  const parsed = RelationshipRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("invalid relationship registry schema");
  }
  return parsed.data;
}

export async function mutateRegistry(
  paths: RelationshipPaths,
  mutation: (registry: RelationshipRegistry) => boolean | void,
): Promise<RelationshipRegistry> {
  await ensurePrivate(paths);
  const token = await acquireLock(paths.lock);
  try {
    const registry = await loadRegistry(paths);
    const changed = mutation(registry) !== false;
    const validated = RelationshipRegistrySchema.parse({
      ...registry,
      revision: changed ? registry.revision + 1 : registry.revision,
    });
    if (changed) {
      await saveJsonAtomic(paths.registry, validated);
      await chmod(paths.registry, 0o600);
    }
    return validated;
  } finally {
    releaseLock(paths.lock, token);
  }
}
