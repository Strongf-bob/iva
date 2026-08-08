import { readFile } from "node:fs/promises";

export type UserbotOnboardingState =
  "idle" | "code_sent" | "password_needed" | "authorized" | "expired" | "error";

export type UserbotOnboardingReason =
  | "idle"
  | "cancelled"
  | "code_sent"
  | "password_needed"
  | "ok"
  | "phone_invalid"
  | "phone_flood_wait"
  | "code_invalid"
  | "code_expired"
  | "password_invalid"
  | "attempt_limit"
  | "flow_missing"
  | "transport_failed"
  | "invalid_request";

export interface UserbotOnboardingResult {
  readonly state: UserbotOnboardingState;
  readonly reason: UserbotOnboardingReason;
}

type FetchImpl = typeof fetch;
type ReadToken = (tokenFile: string) => Promise<string>;

interface ClientOptions {
  readonly tokenFile?: string;
  readonly mcpUrl?: string;
  readonly port?: string | number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchImpl;
  readonly readToken?: ReadToken;
}

const STATES = new Set<UserbotOnboardingState>([
  "idle",
  "code_sent",
  "password_needed",
  "authorized",
  "expired",
  "error",
]);
const REASONS = new Set<UserbotOnboardingReason>([
  "idle",
  "cancelled",
  "code_sent",
  "password_needed",
  "ok",
  "phone_invalid",
  "phone_flood_wait",
  "code_invalid",
  "code_expired",
  "password_invalid",
  "attempt_limit",
  "flow_missing",
  "transport_failed",
  "invalid_request",
]);

export class UserbotOnboardingError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`userbot onboarding failed: ${reason}`);
    this.name = "UserbotOnboardingError";
    this.reason = reason;
  }
}

async function defaultReadToken(tokenFile: string): Promise<string> {
  if (!tokenFile) return "";
  try {
    return (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return "";
  }
}

function baseUrl(mcpUrl: string | undefined, port: string | number): URL {
  let url: URL;
  try {
    url = new URL(
      mcpUrl ??
        `http://127.0.0.1:${/^\d{1,5}$/u.test(String(port)) ? String(port) : "8724"}/mcp`,
    );
  } catch {
    throw new UserbotOnboardingError("invalid_configuration");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserbotOnboardingError("invalid_configuration");
  }
  url.search = "";
  url.hash = "";
  return url;
}

function parseResult(value: unknown): UserbotOnboardingResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UserbotOnboardingError("invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.state !== "string" ||
    typeof record.reason !== "string" ||
    !STATES.has(record.state as UserbotOnboardingState) ||
    !REASONS.has(record.reason as UserbotOnboardingReason)
  ) {
    throw new UserbotOnboardingError("invalid_response");
  }
  return {
    state: record.state as UserbotOnboardingState,
    reason: record.reason as UserbotOnboardingReason,
  };
}

export function createUserbotOnboardingClient({
  tokenFile = process.env.TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE ?? "",
  mcpUrl = process.env.TELEGRAM_MCP_URL,
  port = process.env.TELEGRAM_MCP_PORT ?? "8724",
  timeoutMs = 3000,
  fetchImpl = globalThis.fetch,
  readToken = defaultReadToken,
}: ClientOptions = {}) {
  async function call(
    path: "start" | "code" | "password" | "cancel" | "status",
    payload?: Record<string, string>,
  ): Promise<UserbotOnboardingResult> {
    const url = baseUrl(mcpUrl, port);
    url.pathname = `/onboarding/phone/${path}`;
    const token = String(await readToken(tokenFile)).trim();
    if (!token) throw new UserbotOnboardingError("proxy_token_missing");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: path === "status" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new UserbotOnboardingError("proxy_auth_rejected");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new UserbotOnboardingError("invalid_response");
      }
      const result = parseResult(body);
      if (!response.ok && response.status !== 400) {
        throw new UserbotOnboardingError("proxy_unreachable");
      }
      return result;
    } catch (error) {
      if (error instanceof UserbotOnboardingError) throw error;
      throw new UserbotOnboardingError("transport_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    start: (phone: string) => call("start", { phone }),
    code: (code: string) => call("code", { code }),
    password: (password: string) => call("password", { password }),
    cancel: () => call("cancel"),
    status: () => call("status"),
  };
}

export type UserbotOnboardingClient = ReturnType<
  typeof createUserbotOnboardingClient
>;
