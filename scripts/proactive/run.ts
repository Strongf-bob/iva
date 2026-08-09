import { isAbsolute, join } from "node:path";

import { requireActiveTelegramOwner } from "../lib/owner-routing.ts";
import { reconcileProactiveReviews } from "./reconciler.ts";
import { createRuntimeProviders, resolveProactiveOwnerId } from "./runtime.ts";
import { ProactiveStore } from "./store.ts";

function dataDirectory(): string {
  const raw = process.env.ASSISTANT_DATA_DIR ?? "data";
  return isAbsolute(raw) ? raw : join(process.cwd(), raw);
}

if (
  process.env.ASSISTANT_MULTI_USER === "1" &&
  process.env.ASSISTANT_ROLE !== "owner"
) {
  throw new Error("proactive reviews run only for the owner");
}

const multiUser = process.env.ASSISTANT_MULTI_USER === "1";
const controlDir = process.env.IVA_USER_CONTROL_DIR;
const routedOwnerId =
  !multiUser && controlDir
    ? (await requireActiveTelegramOwner(controlDir)).id
    : undefined;
const ownerId = resolveProactiveOwnerId(process.env, routedOwnerId);
const tokenSecret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN ?? "";
if (!/^\d+$/u.test(ownerId)) throw new Error("proactive owner id is missing");
if (tokenSecret.length < 32) {
  throw new Error("proactive callback secret is missing or too short");
}

const store = ProactiveStore.open(dataDirectory());
try {
  const result = await reconcileProactiveReviews({
    nowMs: Date.now(),
    ownerId,
    store,
    providers: createRuntimeProviders(process.env, ownerId),
    settings: { tokenSecret },
  });
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
