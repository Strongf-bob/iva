import {
  defaultUserLimits,
  enableLegacyOwnerRoute,
  parseTelegramUserId,
  readRoutingUserRegistry,
  readUserRegistry,
  type UserRecord,
} from "./user-registry.ts";

export type OwnerRoutingResult = {
  outcome: "created" | "preserved";
  owner: UserRecord;
};

export async function requireActiveTelegramOwner(
  controlDir: string,
): Promise<UserRecord> {
  const registry = await readRoutingUserRegistry(controlDir);
  const owners = registry.users.filter((user) => user.role === "owner");
  if (owners.length !== 1 || owners[0]?.status !== "active") {
    throw new Error("Telegram routing requires exactly one active owner");
  }
  return owners[0];
}

export async function reconcileTelegramOwnerRoute({
  controlDir,
  allowedUserIds,
  now = new Date(),
}: {
  controlDir: string;
  allowedUserIds: ReadonlySet<string>;
  now?: Date;
}): Promise<OwnerRoutingResult> {
  const effective = await readRoutingUserRegistry(controlDir);
  if (effective.users.some((user) => user.role === "owner")) {
    return {
      outcome: "preserved",
      owner: await requireActiveTelegramOwner(controlDir),
    };
  }

  const persisted = await readUserRegistry(controlDir);
  if (persisted.users.length > 0) {
    throw new Error("Telegram routing registry contains users but no owner");
  }

  const ownerIds = [...allowedUserIds].map((value) =>
    parseTelegramUserId(value),
  );
  if (ownerIds.length !== 1 || ownerIds[0] === null) {
    throw new Error(
      "Telegram routing bootstrap requires exactly one canonical Telegram owner ID",
    );
  }

  const owner: UserRecord = {
    id: ownerIds[0],
    role: "owner",
    status: "active",
    port: 8723,
    limits: defaultUserLimits(),
    createdAt: now.toISOString(),
  };
  await enableLegacyOwnerRoute(controlDir, owner);
  return {
    outcome: "created",
    owner: await requireActiveTelegramOwner(controlDir),
  };
}
