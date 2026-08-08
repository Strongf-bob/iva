/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSetupCommand } from "./userbot.ts";
import userbot from "./userbot.ts";

type ExecCallback = (
  error: (Error & { code?: number }) | null,
  stdout?: string,
  stderr?: string,
) => void;
type Rendered = { text: string; rows: unknown };

test("userbot menu setup rejects exit 1 with a redacted error", async () => {
  const secret = "setup-stderr-secret";
  const exec = (
    _cmd: string,
    _args: string[],
    _opts: { timeout: number; encoding: "utf8" },
    callback: ExecCallback,
  ) => {
    const error = Object.assign(new Error(secret), { code: 1 });
    callback(error, "", secret);
  };

  await assert.rejects(
    runSetupCommand("/iva/bin/iva.mjs", { exec }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "userbot setup failed (exit 1)");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("userbot menu renders the shared Telethon authorization state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iva-userbot-health-menu-"));
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    "TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n",
  );
  let calls = 0;
  const ctx = {
    deps: {
      root: dir,
      envPath,
      probeUserbotHealth: async ({
        root,
        port,
      }: {
        root: string;
        port: string;
      }) => {
        calls += 1;
        assert.equal(root, dir);
        assert.equal(port, "8724");
        return { state: "unauthorized", reason: "telegram_login_required" };
      },
    },
    tr: (en: string) => en,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    flows: { get: () => null, screen: async () => {} },
    show: async () => {},
  };

  const view = await userbot.render(
    { chatId: 1, userId: "2", screen: "ub", data: {} },
    ctx,
  );

  assert.equal(calls, 1);
  assert.match(view.text, /Status: login required/);
  assert.match(view.text, /Beta/);
});

test("userbot menu surfaces setup exit 1 and keeps the beta warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iva-userbot-menu-"));
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    "TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n",
  );
  const rendered: Rendered[] = [];
  const state = {
    chatId: 1,
    userId: "2",
    screen: "ub",
    data: {},
    _last: undefined as Rendered | undefined,
  };
  const flows = {
    get: () => state,
    screen: async (_state: unknown, text: string, rows: unknown) => {
      state._last = { text, rows };
      rendered.push(state._last);
    },
  };
  const ctx = {
    deps: {
      root: dir,
      envPath,
      probeUserbotHealth: async () => ({ state: "off", reason: "service_off" }),
      runUserbotSetup: async () => {
        throw new Error("must stay redacted");
      },
      log: () => {},
    },
    flows,
    tr: (en: string) => en,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    show: async () => {},
  };

  await userbot.on("do", ["setup"], state, ctx);
  for (
    let i = 0;
    i < 20 && !rendered.some((view) => /Setup failed/.test(view.text));
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.match(state._last?.text ?? "", /Beta/);
  assert.match(state._last?.text ?? "", /Setup failed/);
  assert.doesNotMatch(state._last?.text ?? "", /must stay redacted/);
});

test("container menu stores credentials outside .env and toggles the sidecar marker", async (t) => {
  const previousRuntime = process.env.TELEGRAM_USERBOT_RUNTIME;
  process.env.TELEGRAM_USERBOT_RUNTIME = "container";
  t.after(() => {
    if (previousRuntime === undefined)
      delete process.env.TELEGRAM_USERBOT_RUNTIME;
    else process.env.TELEGRAM_USERBOT_RUNTIME = previousRuntime;
  });

  const root = await mkdtemp(join(tmpdir(), "iva-userbot-container-menu-"));
  const envPath = join(root, ".env");
  await writeFile(envPath, "UNCHANGED=1\n", { mode: 0o600 });
  const rendered: Rendered[] = [];
  const state = {
    chatId: 1,
    userId: "2",
    screen: "ub",
    data: { ub: { apiId: "12345" } },
    awaitText: { kind: "ubcred", secret: true, data: { step: "api_hash" } },
  };
  const ctx = {
    deps: {
      root,
      envPath,
      probeUserbotHealth: async () => ({
        state: "off",
        reason: "marker_absent",
      }),
      log: (...parts: unknown[]) => {
        rendered.push({ text: parts.map(String).join(" "), rows: [] });
      },
    },
    flows: {
      get: () => state,
      screen: async (_state: unknown, text: string, rows: unknown) => {
        rendered.push({ text, rows });
      },
    },
    tr: (en: string) => en,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    show: async () => {},
  };
  const apiHash = "abcdef123456";

  await userbot.texts.ubcred(apiHash, {}, state, ctx);

  assert.equal(await readFile(envPath, "utf8"), "UNCHANGED=1\n");
  assert.equal(
    await readFile(join(root, "data", "telegram-userbot.env"), "utf8"),
    `TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=${apiHash}\n`,
  );

  await userbot.on("do", ["setup"], state, ctx);
  assert.equal(
    await readFile(join(root, "data", "telegram-userbot.enabled"), "utf8"),
    "enabled\n",
  );
  assert.equal(
    (await stat(join(root, "data", "telegram-userbot.token"))).mode & 0o777,
    0o600,
  );

  await userbot.on("do", ["off"], state, ctx);
  await assert.rejects(stat(join(root, "data", "telegram-userbot.enabled")), {
    code: "ENOENT",
  });
  assert.doesNotMatch(JSON.stringify(rendered), new RegExp(apiHash));
});

type PhoneCall = { operation: string; value?: string };

async function phoneMenuFixture({ withOnboarding = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "iva-userbot-phone-menu-"));
  const envPath = join(root, ".env");
  await writeFile(
    envPath,
    "TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n",
    { mode: 0o600 },
  );
  const rendered: Rendered[] = [];
  const calls: PhoneCall[] = [];
  const scheduled: Array<() => void> = [];
  let now = 1_000;
  const results = {
    start: { state: "code_sent", reason: "code_sent" },
    code: { state: "password_needed", reason: "password_needed" },
    password: { state: "authorized", reason: "ok" },
    cancel: { state: "idle", reason: "cancelled" },
    status: { state: "code_sent", reason: "code_sent" },
  };
  const onboarding = {
    start: (value: string) => {
      calls.push({ operation: "start", value });
      return Promise.resolve(results.start);
    },
    code: (value: string) => {
      calls.push({ operation: "code", value });
      return Promise.resolve(results.code);
    },
    password: (value: string) => {
      calls.push({ operation: "password", value });
      return Promise.resolve(results.password);
    },
    cancel: () => {
      calls.push({ operation: "cancel" });
      return Promise.resolve(results.cancel);
    },
    status: () => Promise.resolve(results.status),
  };
  const state = {
    chatId: 1,
    userId: "2",
    screen: "ub",
    data: {
      ub: null as {
        apiId?: string;
        codeDigits?: string;
        loginExpiresAt?: number;
        loginExpiryScheduledFor?: number;
      } | null,
    },
    awaitText: null as {
      kind: string;
      secret: boolean;
      data: { step?: string };
    } | null,
  };
  const ctx = {
    deps: {
      root,
      envPath,
      probeUserbotHealth: () =>
        Promise.resolve({
          state: "unauthorized",
          reason: "telegram_login_required",
        }),
      ...(withOnboarding ? { userbotOnboarding: onboarding } : {}),
      now: () => now,
      schedule: (callback: () => void) => scheduled.push(callback),
      log: (...parts: unknown[]) => {
        rendered.push({ text: parts.map(String).join(" "), rows: [] });
      },
    },
    flows: {
      get: () => state,
      screen: async (_state: unknown, text: string, rows: unknown) => {
        rendered.push({ text, rows });
      },
    },
    tr: (en: string) => en,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    show: async () => {},
  };
  return {
    state,
    ctx,
    calls,
    rendered,
    results,
    scheduled,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("unauthorized userbot screen offers phone login instead of QR", async () => {
  const { state, ctx } = await phoneMenuFixture();

  const view = await userbot.render(state, ctx);
  const serialized = JSON.stringify(view);

  assert.match(serialized, /Log in by phone/u);
  assert.match(serialized, /iva_menu:ub:do:login/u);
  assert.doesNotMatch(serialized, /QR/u);
});

test("host-native userbot screen fails closed even if a token-file env leaks", async () => {
  const previousTokenFile = process.env.TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE;
  const previousRuntime = process.env.TELEGRAM_USERBOT_RUNTIME;
  process.env.TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE = "/synthetic/token";
  delete process.env.TELEGRAM_USERBOT_RUNTIME;
  try {
    const { state, ctx } = await phoneMenuFixture({ withOnboarding: false });

    const view = await userbot.render(state, ctx);
    const serialized = JSON.stringify(view);

    assert.match(serialized, /Phone login is disabled in host-native mode/u);
    assert.doesNotMatch(serialized, /iva_menu:ub:do:login/u);
  } finally {
    if (previousTokenFile === undefined)
      delete process.env.TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE;
    else process.env.TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE = previousTokenFile;
    if (previousRuntime === undefined)
      delete process.env.TELEGRAM_USERBOT_RUNTIME;
    else process.env.TELEGRAM_USERBOT_RUNTIME = previousRuntime;
  }
});

test("phone login accepts a deleted private number and renders a masked keypad", async () => {
  const { state, ctx, calls, rendered } = await phoneMenuFixture();

  await userbot.on("do", ["login"], state, ctx);
  assert.deepEqual(state.awaitText, {
    kind: "ubphone",
    secret: true,
    data: { step: "phone" },
  });

  const phone = "+7 (999) 765-43-21";
  await userbot.texts.ubphone(phone, {}, state, ctx);
  assert.deepEqual(calls.at(-1), {
    operation: "start",
    value: "+79997654321",
  });
  assert.equal(state.awaitText, null);
  assert.equal(state.data.ub?.codeDigits, "");
  const output = JSON.stringify(rendered);
  assert.match(output, /Enter the code/u);
  assert.match(output, /iva_menu:ub:do:digit:1/u);
  assert.doesNotMatch(output, /79997654321/u);
});

test("keypad masks digits and transitions to a secret 2FA prompt", async () => {
  const { state, ctx, calls, rendered } = await phoneMenuFixture();
  state.data.ub = { codeDigits: "" };

  for (const digit of ["1", "2", "3", "4", "5"]) {
    await userbot.on("do", ["digit", digit], state, ctx);
  }
  assert.equal(state.data.ub.codeDigits, "12345");
  assert.match(rendered.at(-1)?.text ?? "", /•••••/u);
  assert.doesNotMatch(rendered.at(-1)?.text ?? "", /12345/u);

  await userbot.on("do", ["submit_code"], state, ctx);
  assert.deepEqual(calls.at(-1), { operation: "code", value: "12345" });
  assert.equal(state.data.ub?.codeDigits, undefined);
  assert.deepEqual(state.awaitText, {
    kind: "ubpassword",
    secret: true,
    data: { step: "password" },
  });
});

test("phone login wipes abandoned code digits at the absolute five-minute deadline", async () => {
  const { state, ctx, scheduled, setNow } = await phoneMenuFixture();

  await userbot.on("do", ["login"], state, ctx);
  await userbot.texts.ubphone("+79997654321", {}, state, ctx);
  for (const digit of ["1", "2", "3", "4", "5"]) {
    await userbot.on("do", ["digit", digit], state, ctx);
  }
  const deadline = state.data.ub?.loginExpiresAt;
  assert.equal(deadline, 301_000);
  assert.equal(scheduled.length, 1);

  setNow(deadline);
  scheduled[0]?.();

  assert.equal(state.data.ub, null);
  assert.equal(state.awaitText, null);
});

test("2FA expiry keeps consuming late secrets even after prompt replacement fails", async () => {
  const { state, ctx, scheduled, calls } = await phoneMenuFixture();

  await userbot.on("do", ["login"], state, ctx);
  await userbot.texts.ubphone("+79997654321", {}, state, ctx);
  for (const digit of ["1", "2", "3", "4", "5"]) {
    await userbot.on("do", ["digit", digit], state, ctx);
  }
  await userbot.on("do", ["submit_code"], state, ctx);
  assert.equal(state.awaitText?.kind, "ubpassword");

  const originalScreen = ctx.flows.screen;
  let finishReplacement: (() => void) | undefined;
  ctx.flows.screen = () =>
    new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
  scheduled[0]?.();

  assert.equal(state.data.ub, null);
  assert.equal(state.awaitText?.kind, "ubpassword");
  finishReplacement?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.awaitText?.kind, "ubpassword");

  ctx.flows.screen = originalScreen;
  await userbot.texts.ubpassword("late-secret-canary", {}, state, ctx);
  assert.equal(state.awaitText?.kind, "ubpassword");
  assert.equal(
    calls.some((call) => call.operation === "password"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(ctx), /late-secret-canary/u);
});

test("2FA and cancel never render the submitted secret", async () => {
  const { state, ctx, calls, rendered } = await phoneMenuFixture();
  const canary = "synthetic-2fa-canary";
  state.awaitText = {
    kind: "ubpassword",
    secret: true,
    data: { step: "password" },
  };
  state.data.ub = {};

  await userbot.texts.ubpassword(canary, {}, state, ctx);
  assert.deepEqual(calls.at(-1), { operation: "password", value: canary });
  assert.equal(state.awaitText, null);
  assert.doesNotMatch(JSON.stringify(rendered), new RegExp(canary));

  await userbot.on("do", ["cancel_login"], state, ctx);
  assert.deepEqual(calls.at(-1), { operation: "cancel" });
  assert.equal(state.data.ub, null);
});
