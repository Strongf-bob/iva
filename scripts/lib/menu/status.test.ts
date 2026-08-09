/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type StatusState = {
  chatId: number;
  userId: string;
  screen: string;
  personalRoot?: string;
};
type View = { text: string; rows: unknown[][] };
type StatusScreen = {
  render: (state: StatusState, context: StatusContext) => Promise<View>;
};
type StatusContext = {
  deps: {
    root: string;
    envPath: string;
    dataDir: string;
    runtime?: "container" | "host";
    probeUserbotHealth: (options: {
      root: string;
      port: string;
    }) => Promise<{ state: string }>;
  };
  flows: {
    get: (chatId: number, userId: string) => StatusState | null;
    screen: (
      state: StatusState,
      text: string,
      rows: unknown[][],
    ) => Promise<void>;
  };
  getLang: () => string;
  tr: (en: string, ru: string) => string;
  btn: (text: string, callbackData: string) => Record<string, string>;
  backRow: (screen: string) => Array<Record<string, string>>;
};

const statusModulePath = "./status.ts";
const status = (await import(statusModulePath)) as { default: StatusScreen };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iva-menu-status-"));
  const envPath = join(root, ".env");
  await Promise.all([
    writeFile(join(root, "package.json"), '{"version":"0.3.11"}\n'),
    writeFile(
      envPath,
      "MODEL_PROVIDER=codex\nCODEX_MODEL=gpt-5\nSEARCH_PROVIDER=tavily\n",
    ),
  ]);
  return { root, envPath };
}

test("status renders fast fields before the asynchronous userbot probe settles", async () => {
  const { root, envPath } = await fixture();
  const pending = deferred<{ state: string }>();
  const state: StatusState = { chatId: 1, userId: "2", screen: "st" };
  const edits: string[] = [];
  const context: StatusContext = {
    deps: {
      root,
      envPath,
      dataDir: join(root, "data"),
      probeUserbotHealth: () => pending.promise,
    },
    flows: {
      get: () => state,
      screen: async (_state, text) => {
        edits.push(text);
      },
    },
    getLang: () => "en",
    tr: (en) => en,
    btn: (text, callbackData) => ({ text, callback_data: callbackData }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
  };

  const initial = await status.default.render(state, context);
  assert.match(initial.text, /Iva v0\.3\.11/);
  assert.match(initial.text, /Userbot: …/);
  assert.equal(edits.length, 0);

  pending.resolve({ state: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits.length, 1);
  assert.match(edits[0] ?? "", /Userbot: ready/);
});

test("status does not edit an expired menu after the asynchronous probe settles", async () => {
  const { root, envPath } = await fixture();
  const pending = deferred<{ state: string }>();
  const state: StatusState = { chatId: 1, userId: "2", screen: "st" };
  let active: StatusState | null = state;
  let edits = 0;
  const context: StatusContext = {
    deps: {
      root,
      envPath,
      dataDir: join(root, "data"),
      probeUserbotHealth: () => pending.promise,
    },
    flows: {
      get: () => active,
      screen: async () => {
        edits += 1;
      },
    },
    getLang: () => "en",
    tr: (en) => en,
    btn: (text, callbackData) => ({ text, callback_data: callbackData }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
  };

  await status.default.render(state, context);
  active = { ...state };
  pending.resolve({ state: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits, 0);
});

test("container status reads Google and scheduler state from the selected user", async () => {
  const { root, envPath } = await fixture();
  const personalRoot = join(root, "data", "users", "101");
  await Promise.all([
    mkdir(join(root, "data", "control"), { recursive: true }),
    mkdir(join(personalRoot, ".config", "gws"), { recursive: true }),
    mkdir(join(personalRoot, "runtime", "data"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "data", "control", "reminder-scheduler-status.json"),
      JSON.stringify({ updatedAt: Date.now() }),
    ),
    writeFile(join(personalRoot, ".config", "gws", "client_secret.json"), "{}"),
    writeFile(
      join(root, "data", "usage.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), source: "telegram", provider: "test", model: "test", sessionId: "global", turnId: "global", step: 1, in: 999, out: 0, cacheRead: 0, cacheWrite: 0, total: 999 })}\n`,
    ),
    writeFile(
      join(personalRoot, "runtime", "data", "usage.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), source: "telegram", provider: "test", model: "test", sessionId: "personal", turnId: "personal", step: 1, in: 123, out: 0, cacheRead: 0, cacheWrite: 0, total: 123 })}\n`,
    ),
  ]);
  const state: StatusState = {
    chatId: 101,
    userId: "101",
    screen: "st",
    personalRoot,
  };
  const context: StatusContext = {
    deps: {
      root,
      envPath,
      dataDir: join(root, "data"),
      runtime: "container",
      probeUserbotHealth: () => Promise.resolve({ state: "ready" }),
    },
    flows: {
      get: () => state,
      screen: () => Promise.resolve(),
    },
    getLang: () => "en",
    tr: (en) => en,
    btn: (text, callbackData) => ({ text, callback_data: callbackData }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
  };
  const view = await status.default.render(state, context);
  assert.match(view.text, /Runtime: container/u);
  assert.match(view.text, /Scheduler: ready/u);
  assert.match(view.text, /Google: configured/u);
  assert.match(view.text, /Usage today: 123 tokens/u);
  assert.doesNotMatch(view.text, /999 tokens/u);
});
