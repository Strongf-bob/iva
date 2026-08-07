import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { userbotRuntimePaths } from "./userbot-container-runtime.ts";

export const USERBOT_HEALTH_TIMEOUT_MS = 1500;
export const USERBOT_SERVICE = "iva-telegram-userbot.service";

export type UserbotHealthState =
  "off" | "starting" | "unreachable" | "unauthorized" | "ready";

export interface UserbotHealth {
  readonly state: UserbotHealthState;
  readonly reason: string;
}

interface SystemctlResult {
  readonly code: number;
  readonly out: string;
}

interface HealthResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

interface HealthFetchInit {
  readonly method: "GET";
  readonly headers: { readonly authorization: string };
  readonly signal: AbortSignal;
}

type RunSystemctl = (
  args: string[],
  options: { signal?: AbortSignal },
) => Promise<SystemctlResult>;
type ReadToken = (root: string) => Promise<string>;
type IsContainerEnabled = (root: string) => Promise<boolean>;
type FetchImpl = (
  url: string,
  init: HealthFetchInit,
) => Promise<HealthResponse>;

interface ProbeOptions {
  readonly root?: string;
  readonly port?: string | number;
  readonly runtime?: string;
  readonly mcpUrl?: string;
  readonly timeoutMs?: number;
  readonly runSystemctl?: RunSystemctl;
  readonly readToken?: ReadToken;
  readonly isContainerEnabled?: IsContainerEnabled;
  readonly fetchImpl?: FetchImpl;
}

function fixed(state: UserbotHealthState, reason: string): UserbotHealth {
  return { state, reason };
}

function defaultRunSystemctl(
  args: string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<SystemctlResult> {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--user", ...args],
      { encoding: "utf8", signal },
      (error, stdout = "") => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          out: String(stdout).trim(),
        });
      },
    );
  });
}

async function defaultReadToken(root: string): Promise<string> {
  try {
    return (
      await readFile(join(root, "data", "telegram-userbot.token"), "utf8")
    ).trim();
  } catch {
    return "";
  }
}

async function defaultIsContainerEnabled(root: string): Promise<boolean> {
  try {
    await access(userbotRuntimePaths(root).enabled);
    return true;
  } catch {
    return false;
  }
}

function payloadState(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const state = (payload as { state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

interface RunProbeOptions {
  readonly root: string;
  readonly port: string | number;
  readonly runtime: string;
  readonly mcpUrl?: string;
  readonly signal: AbortSignal;
  readonly runSystemctl: RunSystemctl;
  readonly readToken: ReadToken;
  readonly isContainerEnabled: IsContainerEnabled;
  readonly fetchImpl: FetchImpl;
}

function healthUrl(mcpUrl: string | undefined, port: string | number): string {
  if (mcpUrl) {
    const url = new URL(mcpUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported userbot MCP URL protocol");
    }
    url.pathname = "/healthz";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  const safePort = /^\d{1,5}$/u.test(String(port)) ? String(port) : "8724";
  return `http://127.0.0.1:${safePort}/healthz`;
}

async function runProbe({
  root,
  port,
  runtime,
  mcpUrl,
  signal,
  runSystemctl,
  readToken,
  isContainerEnabled,
  fetchImpl,
}: RunProbeOptions): Promise<UserbotHealth> {
  if (runtime === "container") {
    if (!(await isContainerEnabled(root))) {
      return fixed("off", "marker_absent");
    }
  } else {
    const [active, enabled] = await Promise.all([
      runSystemctl(["is-active", USERBOT_SERVICE], { signal }),
      runSystemctl(["is-enabled", USERBOT_SERVICE], { signal }),
    ]);
    const activeLabel = String(active?.out || "").trim();
    const enabledLabel = String(enabled?.out || "").trim();
    const isActive = active?.code === 0 && activeLabel === "active";
    const isEnabled = enabled?.code === 0 && enabledLabel === "enabled";

    if (!isActive) {
      if (activeLabel === "activating" || isEnabled)
        return fixed("starting", "service_starting");
      return fixed("off", "service_off");
    }
  }

  const token = String(await readToken(root)).trim();
  if (!token) {
    return runtime === "container"
      ? fixed("starting", "proxy_token_missing")
      : fixed("unreachable", "proxy_token_missing");
  }

  const response = await fetchImpl(healthUrl(mcpUrl, port), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (response.status === 401)
    return fixed("unreachable", "proxy_auth_rejected");
  if (!response.ok) return fixed("unreachable", "proxy_unreachable");

  const state = payloadState(await response.json());
  if (state === "ready") return fixed("ready", "ok");
  if (state === "unauthorized")
    return fixed("unauthorized", "telegram_login_required");
  return fixed("unreachable", "invalid_proxy_response");
}

export async function probeUserbotHealth({
  root = process.cwd(),
  port = process.env.TELEGRAM_MCP_PORT || "8724",
  runtime = process.env.TELEGRAM_USERBOT_RUNTIME || "systemd",
  mcpUrl = process.env.TELEGRAM_MCP_URL,
  timeoutMs = USERBOT_HEALTH_TIMEOUT_MS,
  runSystemctl = defaultRunSystemctl,
  readToken = defaultReadToken,
  isContainerEnabled = defaultIsContainerEnabled,
  fetchImpl = globalThis.fetch,
}: ProbeOptions = {}): Promise<UserbotHealth> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<UserbotHealth>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fixed("unreachable", "probe_timeout"));
    }, timeoutMs);
  });
  const probe = runProbe({
    root,
    port,
    runtime,
    mcpUrl,
    signal: controller.signal,
    runSystemctl,
    readToken,
    isContainerEnabled,
    fetchImpl,
  }).catch(() =>
    controller.signal.aborted
      ? fixed("unreachable", "probe_timeout")
      : fixed("unreachable", "proxy_unreachable"),
  );

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
