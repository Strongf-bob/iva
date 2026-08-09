import { isAbsolute, join } from "node:path";

import { reconcileProactiveReviews } from "./reconciler.ts";
import { createRuntimeProviders } from "./runtime.ts";
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

const ownerId = String(process.env.ASSISTANT_USER_ID ?? "").trim();
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
    providers: createRuntimeProviders(process.env),
    settings: { tokenSecret },
  });
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
