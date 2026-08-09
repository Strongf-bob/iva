import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { requireActiveTelegramOwner } from "../lib/owner-routing.ts";
import { CONTROL_DIR, HOST } from "../poller/config.ts";
import { routesForTenant } from "../poller/tenant-routing.ts";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function checkRoutingHealth({
  controlDir,
  legacyBase,
  fetchImpl = fetch,
}: {
  controlDir: string;
  legacyBase: string;
  fetchImpl?: Fetch;
}): Promise<void> {
  const owner = await requireActiveTelegramOwner(controlDir);
  const routes = routesForTenant(owner, legacyBase);
  const healthUrl = new URL("/eve/v1/health", routes.webhook);
  let response: Response;
  try {
    response = await fetchImpl(healthUrl, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Telegram owner worker health request failed");
  }
  if (!response.ok) {
    throw new Error(
      `Telegram owner worker health returned HTTP ${response.status}`,
    );
  }
}

export async function main(): Promise<void> {
  await checkRoutingHealth({
    controlDir: CONTROL_DIR,
    legacyBase: HOST,
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "unknown routing health error";
    console.error("routing health failed:", message);
    process.exitCode = 1;
  });
}
