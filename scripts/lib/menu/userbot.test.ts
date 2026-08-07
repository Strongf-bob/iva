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
