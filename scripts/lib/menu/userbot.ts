/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable exec boundary source-compatible. */
// Экран «Userbot» меню (/menu → 📡). Статус личного userbot-прокси (Telegram) + подключение.
// Общая CLI/Telegram-проба проверяет systemd, health endpoint и авторизацию Telethon.
// Общий таймаут 1.5с: getUpdates-цикл нельзя блокировать дольше.
// Наличие creds — булевы TELEGRAM_API_ID/TELEGRAM_API_HASH из .env (значения не показываем).
//
// Секреты (api_id/api_hash) принимаются только в личке; сообщение с ними удаляет движок
// (secret:true) до texts.ubcred. Значения не попадают в лог/eve/текст. Пишем через upsertEnv.
// Включение — отсоединённый `iva userbot setup` (сборка venv медленная, до 3 мин): не ждём
// синхронно, показываем заглушку и перерисовываем экран по завершении.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readEnvValues, upsertEnv } from "../env-file.ts";
import {
  disableContainerUserbot,
  enableContainerUserbot,
  readUserbotCredentials,
  writeUserbotCredentials,
} from "../userbot-container-runtime.ts";
import { probeUserbotHealth } from "../userbot-health.ts";
import { createUserbotOnboardingClient } from "../userbot-onboarding-client.ts";

type ErrorLike = { code?: unknown; message?: unknown };
type Health = { state: string };
type OnboardingResult = { state: string; reason: string };
type OnboardingClient = {
  start: (phone: string) => Promise<OnboardingResult>;
  code: (code: string) => Promise<OnboardingResult>;
  password: (password: string) => Promise<OnboardingResult>;
  cancel: () => Promise<OnboardingResult>;
  status: () => Promise<OnboardingResult>;
};
type UserbotFlowData = {
  apiId?: string;
  codeDigits?: string;
  loginExpiresAt?: number;
  loginExpiryScheduledFor?: number;
};
type MenuState = {
  chatId: number | string;
  userId: string;
  screen: string;
  data: { ub?: UserbotFlowData | null };
  awaitText?: { kind: string; secret: boolean; data: { step?: string } } | null;
};
type View = { text: string; rows: Array<Array<unknown>> };
type MenuContext = {
  deps: {
    root: string;
    envPath: string;
    probeUserbotHealth?: (options: {
      root: string;
      port: string;
      runtime?: string;
      mcpUrl?: string;
    }) => Promise<Health>;
    userbotOnboarding?: OnboardingClient;
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    runUserbotSetup?: () => Promise<void>;
    log?: (...parts: unknown[]) => void;
  };
  flows: {
    get: (chatId: number | string, userId: string) => MenuState | null;
    screen: (
      state: MenuState,
      text: string,
      rows: Array<Array<unknown>>,
    ) => Promise<unknown>;
  };
  tr: (en: string, ru: string) => string;
  btn: (text: string, callbackData: string) => unknown;
  backRow: (screen: string) => Array<unknown>;
  show: (state: MenuState, screen: string) => Promise<unknown>;
};
type Exec = (
  file: string,
  args: string[],
  options: { timeout: number; encoding: "utf8" },
  callback: (error: ErrorLike | null, stdout?: string) => void,
) => unknown;

const errorMessage = (error: unknown) => (error as ErrorLike).message;

const SID = "ub";
const PARENT = "r";
const SVC = "iva-telegram-userbot.service";
const LOGIN_TTL_MS = 5 * 60 * 1000;

const isPrivate = (st: MenuState) => Number(st.chatId) > 0;
const isContainerRuntime = () =>
  process.env.TELEGRAM_USERBOT_RUNTIME === "container";
const phoneLoginAvailable = (ctx: MenuContext) =>
  Boolean(
    ctx.deps.userbotOnboarding ||
    (isContainerRuntime() &&
      process.env.TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE),
  );

function onboardingFor(ctx: MenuContext): OnboardingClient {
  return ctx.deps.userbotOnboarding || createUserbotOnboardingClient();
}

function run(cmd: string, args: string[], timeout = 1500) {
  return new Promise<{ failed: boolean; code: number; stdout: string }>(
    (resolve) => {
      execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
        resolve({
          failed: Boolean(err),
          code:
            typeof (err as ErrorLike | null)?.code === "number"
              ? Number((err as ErrorLike).code)
              : err
                ? 1
                : 0,
          stdout: String(stdout),
        }),
      );
    },
  );
}

export function runSetupCommand(
  bin: string,
  {
    exec = execFile as unknown as Exec,
    timeoutMs = 180_000,
  }: { exec?: Exec; timeoutMs?: number } = {},
) {
  return new Promise<void>((resolve, reject) => {
    exec(
      process.execPath,
      [bin, "userbot", "setup"],
      { timeout: timeoutMs, encoding: "utf8" },
      (error) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : 1;
          reject(new Error(`userbot setup failed (exit ${code})`));
          return;
        }
        resolve();
      },
    );
  });
}

async function probeStatus(
  ctx: MenuContext,
  env: Record<string, string | undefined>,
) {
  const probe = ctx.deps.probeUserbotHealth || probeUserbotHealth;
  return probe({
    root: ctx.deps.root,
    port: env.TELEGRAM_MCP_PORT || process.env.TELEGRAM_MCP_PORT || "8724",
    runtime: process.env.TELEGRAM_USERBOT_RUNTIME,
    mcpUrl: process.env.TELEGRAM_MCP_URL,
  });
}

// Единая сборка карты — используется и render(), и async-перерисовкой после setup.
async function buildScreen(st: MenuState, ctx: MenuContext): Promise<View> {
  const T = ctx.tr;
  const env = isContainerRuntime()
    ? await readUserbotCredentials(ctx.deps.root)
    : await readEnvValues(ctx.deps.envPath);
  const hasCreds = Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
  const status = await probeStatus(ctx, env);
  const head = T("📡 Telegram userbot", "📡 Telegram-userbot");
  const beta = T(
    "🧪 Beta: personal-account automation can misbehave and carries account-ban risk.",
    "🧪 Бета: автоматизация личного аккаунта может сбоить и несёт риск блокировки.",
  );
  const stateLabel =
    {
      off: T("off", "выкл"),
      starting: T("starting", "запускается"),
      unreachable: T("unreachable", "недоступен"),
      unauthorized: T("login required", "нужен вход"),
      ready: T("ready", "готов"),
    }[
      status.state as
        "off" | "starting" | "unreachable" | "unauthorized" | "ready"
    ] || T("unreachable", "недоступен");
  const statusLine = `${T("Status", "Статус")}: ${stateLabel}`;

  if (!hasCreds) {
    const text = [
      head,
      "",
      beta,
      "",
      statusLine,
      "",
      T(
        "No API credentials yet. Create an app at https://my.telegram.org (API development tools) — you'll get api_id and api_hash.",
        "Ключей ещё нет. Создай приложение на https://my.telegram.org (API development tools) — получишь api_id и api_hash.",
      ),
    ].join("\n");
    return {
      text,
      rows: [
        [
          ctx.btn(
            T("Enter credentials", "Ввести ключи"),
            `iva_menu:${SID}:do:creds`,
          ),
        ],
        ctx.backRow(PARENT),
      ],
    };
  }

  if (status.state === "off") {
    const text = [
      head,
      "",
      beta,
      "",
      statusLine,
      "",
      T(
        "Credentials are set. Turn the proxy on — it builds a venv (up to ~3 min).",
        "Ключи заданы. Включи прокси — соберётся venv (до ~3 мин).",
      ),
    ].join("\n");
    return {
      text,
      rows: [
        [ctx.btn(T("Turn on", "Включить"), `iva_menu:${SID}:do:setup`)],
        [ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
        ctx.backRow(PARENT),
      ],
    };
  }

  if (status.state === "starting") {
    return {
      text: [
        head,
        "",
        beta,
        "",
        statusLine,
        "",
        T(
          "The proxy service is still starting. Refresh in a moment.",
          "Прокси ещё запускается. Обнови через несколько секунд.",
        ),
      ].join("\n"),
      rows: [
        [
          ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`),
          ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`),
        ],
        ctx.backRow(PARENT),
      ],
    };
  }

  if (status.state === "unreachable") {
    return {
      text: [
        head,
        "",
        beta,
        "",
        statusLine,
        "",
        T(
          "The service is active, but its health endpoint did not answer. Run `iva userbot diagnose --json` for the fixed diagnostic.",
          "Сервис активен, но health endpoint не ответил. Запусти `iva userbot diagnose --json` для точной диагностики.",
        ),
      ].join("\n"),
      rows: [
        [
          ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`),
          ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`),
        ],
        ctx.backRow(PARENT),
      ],
    };
  }

  const accountHint =
    status.state === "unauthorized"
      ? phoneLoginAvailable(ctx)
        ? T(
            "Proxy is on, but the Telegram account is not connected. Log in by phone; the code is entered with private keypad buttons.",
            "Прокси включён, но аккаунт Telegram не подключён. Войди по номеру; код вводится приватными кнопками.",
          )
        : T(
            "Phone login is disabled in host-native mode because it cannot isolate onboarding authority from model shell tools. Use container production.",
            "Вход по номеру отключён в host-native режиме: там нельзя изолировать права онбординга от shell-инструментов модели. Используй container production.",
          )
      : T(
          "Proxy and Telegram account are ready.",
          "Прокси и аккаунт Telegram готовы.",
        );
  const text = [head, "", beta, "", statusLine, "", accountHint].join("\n");
  return {
    text,
    rows: [
      ...(status.state === "unauthorized" && phoneLoginAvailable(ctx)
        ? [
            [
              ctx.btn(
                T("Log in by phone", "Войти по номеру"),
                `iva_menu:${SID}:do:login`,
              ),
            ],
          ]
        : []),
      [
        ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`),
        ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`),
      ],
      ctx.backRow(PARENT),
    ],
  };
}

function promptPhone(st: MenuState, ctx: MenuContext) {
  st.data.ub = {};
  st.awaitText = { kind: "ubphone", secret: true, data: { step: "phone" } };
  return ctx.flows.screen(
    st,
    ctx.tr(
      "Send the phone number with country code, for example +79991234567. I will delete the message before processing it.",
      "Пришли номер с кодом страны, например +79991234567. Сообщение удалю до обработки.",
    ),
    [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:do:cancel_login`)]],
  );
}

function promptPassword(st: MenuState, ctx: MenuContext) {
  const flow = st.data.ub;
  st.data.ub = {
    loginExpiresAt: flow?.loginExpiresAt,
    loginExpiryScheduledFor: flow?.loginExpiryScheduledFor,
  };
  st.awaitText = {
    kind: "ubpassword",
    secret: true,
    data: { step: "password" },
  };
  return ctx.flows.screen(
    st,
    ctx.tr(
      "Telegram requires the 2FA password. Send it now; I will delete the message before processing it.",
      "Telegram запросил пароль 2FA. Пришли его сейчас; сообщение удалю до обработки.",
    ),
    [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:do:cancel_login`)]],
  );
}

function codeKeypad(st: MenuState, ctx: MenuContext, note = "") {
  const now = ctx.deps.now?.() ?? Date.now();
  if (st.data.ub?.loginExpiresAt && now >= st.data.ub.loginExpiresAt) {
    st.data.ub = null;
    st.awaitText = null;
    return renderExpired(st, ctx);
  }
  const digits = st.data.ub?.codeDigits ?? "";
  st.data.ub = { ...st.data.ub, codeDigits: digits };
  st.awaitText = null;
  const button = (digit: string) =>
    ctx.btn(digit, `iva_menu:${SID}:do:digit:${digit}`);
  const text = [
    ctx.tr(
      "Enter the code Telegram sent to the official app. The digits are never shown or sent to the model.",
      "Введи код, который Telegram прислал в официальное приложение. Цифры не показываются и не отправляются модели.",
    ),
    "",
    digits ? "•".repeat(digits.length) : ctx.tr("No digits yet", "Пока пусто"),
    note ? `\n${note}` : "",
  ].join("\n");
  return ctx.flows.screen(st, text, [
    [button("1"), button("2"), button("3")],
    [button("4"), button("5"), button("6")],
    [button("7"), button("8"), button("9")],
    [
      ctx.btn(ctx.tr("Erase", "Стереть"), `iva_menu:${SID}:do:erase`),
      button("0"),
      ctx.btn(ctx.tr("Done", "Готово"), `iva_menu:${SID}:do:submit_code`),
    ],
    [ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:do:cancel_login`)],
  ]);
}

function reasonText(result: OnboardingResult, ctx: MenuContext): string {
  const messages: Record<string, string> = {
    phone_invalid: ctx.tr("Invalid phone number.", "Неверный номер телефона."),
    phone_flood_wait: ctx.tr(
      "Telegram temporarily limited login attempts. Try later.",
      "Telegram временно ограничил попытки входа. Попробуй позже.",
    ),
    code_invalid: ctx.tr("The code is invalid.", "Код неверный."),
    code_expired: ctx.tr(
      "The code expired. Start again.",
      "Код истёк. Начни заново.",
    ),
    password_invalid: ctx.tr(
      "The 2FA password is invalid.",
      "Пароль 2FA неверный.",
    ),
    attempt_limit: ctx.tr(
      "Too many failed attempts. Start again later.",
      "Слишком много ошибок. Начни заново позже.",
    ),
    flow_missing: ctx.tr("The login flow expired.", "Попытка входа истекла."),
    transport_failed: ctx.tr(
      "Telegram is temporarily unavailable.",
      "Telegram временно недоступен.",
    ),
  };
  return (
    messages[result.reason] || ctx.tr("Login failed.", "Вход не выполнен.")
  );
}

function renderExpired(st: MenuState, ctx: MenuContext) {
  return ctx.flows.screen(
    st,
    reasonText({ state: "expired", reason: "code_expired" }, ctx),
    [
      [ctx.btn(ctx.tr("Try again", "Повторить"), `iva_menu:${SID}:do:login`)],
      ctx.backRow(PARENT),
    ],
  );
}

async function renderOnboardingResult(
  result: OnboardingResult,
  st: MenuState,
  ctx: MenuContext,
) {
  if (result.state === "code_sent") {
    const now = ctx.deps.now?.() ?? Date.now();
    const deadline = st.data.ub?.loginExpiresAt ?? now + LOGIN_TTL_MS;
    const needsTimer = st.data.ub?.loginExpiryScheduledFor !== deadline;
    st.data.ub = {
      ...st.data.ub,
      loginExpiresAt: deadline,
      loginExpiryScheduledFor: deadline,
    };
    if (needsTimer) {
      const schedule = ctx.deps.schedule ?? setTimeout;
      schedule(
        () => {
          if (st.data.ub?.loginExpiresAt === deadline) {
            st.data.ub = null;
            // Never clear an active secret capture from a background timer. Telegram
            // can report both edit and fallback-send failure without throwing, leaving
            // the old 2FA prompt visible. A late password must therefore stay in this
            // deterministic delete-first handler until the user retries or navigates.
            void renderExpired(st, ctx).catch(() => {});
          }
        },
        Math.max(0, deadline - now),
      );
    }
    return codeKeypad(
      st,
      ctx,
      result.reason === "code_invalid" ? reasonText(result, ctx) : "",
    );
  }
  if (result.state === "password_needed") return promptPassword(st, ctx);
  if (result.state === "authorized") {
    st.awaitText = null;
    st.data.ub = null;
    return ctx.flows.screen(
      st,
      ctx.tr(
        "✅ Telegram account connected.",
        "✅ Аккаунт Telegram подключён.",
      ),
      [
        [ctx.btn(ctx.tr("Refresh", "Обновить"), `iva_menu:${SID}:rf`)],
        ctx.backRow(PARENT),
      ],
    );
  }
  st.awaitText = null;
  st.data.ub = null;
  return ctx.flows.screen(st, reasonText(result, ctx), [
    [ctx.btn(ctx.tr("Try again", "Повторить"), `iva_menu:${SID}:do:login`)],
    ctx.backRow(PARENT),
  ]);
}

// Приглашение ввести api_id или api_hash (двухшаговый секретный приём).
function promptCred(st: MenuState, ctx: MenuContext, step: string) {
  st.awaitText = { kind: "ubcred", secret: true, data: { step } };
  const text =
    step === "api_id"
      ? ctx.tr(
          "Send your api_id (a number). I'll delete the message right away.",
          "Пришли api_id (число). Сообщение сразу удалю.",
        )
      : ctx.tr(
          "Now send your api_hash. I'll delete the message right away.",
          "Теперь пришли api_hash. Сообщение сразу удалю.",
        );
  return ctx.flows.screen(st, text, [
    [ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)],
  ]);
}

export default {
  parent: PARENT,

  render(st: MenuState, ctx: MenuContext) {
    return buildScreen(st, ctx);
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];

    if (step === "creds") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr(
            "Credentials are secrets — open a private chat and enter them there.",
            "Ключи — это секрет. Открой личный чат и введи их там.",
          ),
          [ctx.backRow(PARENT)],
        );
      }
      st.data.ub = {};
      return promptCred(st, ctx, "api_id");
    }

    if (step === "login") {
      if (!phoneLoginAvailable(ctx)) return ctx.show(st, SID);
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr(
            "Phone login is available only in a private chat.",
            "Вход по номеру доступен только в личном чате.",
          ),
          [ctx.backRow(PARENT)],
        );
      }
      return promptPhone(st, ctx);
    }

    if (step === "digit") {
      const digit = args[1];
      const current = st.data.ub?.codeDigits;
      if (typeof current !== "string" || !/^[0-9]$/u.test(digit || ""))
        return ctx.show(st, SID);
      if (current.length < 8)
        st.data.ub = { ...st.data.ub, codeDigits: current + digit };
      return codeKeypad(st, ctx);
    }

    if (step === "erase") {
      if (typeof st.data.ub?.codeDigits === "string")
        st.data.ub = {
          ...st.data.ub,
          codeDigits: st.data.ub.codeDigits.slice(0, -1),
        };
      return codeKeypad(st, ctx);
    }

    if (step === "submit_code") {
      const code = st.data.ub?.codeDigits || "";
      if (!/^[0-9]{5,8}$/u.test(code)) {
        return codeKeypad(
          st,
          ctx,
          ctx.tr("Enter 5-8 digits.", "Введи 5-8 цифр."),
        );
      }
      st.data.ub = {
        loginExpiresAt: st.data.ub?.loginExpiresAt,
        loginExpiryScheduledFor: st.data.ub?.loginExpiryScheduledFor,
      };
      try {
        return await renderOnboardingResult(
          await onboardingFor(ctx).code(code),
          st,
          ctx,
        );
      } catch {
        return renderOnboardingResult(
          { state: "error", reason: "transport_failed" },
          st,
          ctx,
        );
      }
    }

    if (step === "cancel_login") {
      try {
        await onboardingFor(ctx).cancel();
      } catch {
        // Local state still clears; the server flow expires after five minutes.
      }
      st.awaitText = null;
      st.data.ub = null;
      return ctx.show(st, SID);
    }

    if (step === "setup") {
      if (isContainerRuntime()) {
        try {
          await enableContainerUserbot(ctx.deps.root);
        } catch {
          ctx.deps.log?.("userbot container enable failed");
          return ctx.flows.screen(
            st,
            ctx.tr(
              "🧪 Beta\n\nSetup failed. Re-enter the credentials, then try again.",
              "🧪 Бета\n\nНастройка завершилась с ошибкой. Введи ключи заново и повтори.",
            ),
            [ctx.backRow(PARENT)],
          );
        }
        return ctx.show(st, SID);
      }
      const bin = join(ctx.deps.root, "bin/iva.mjs");
      // Отсоединённо: НЕ ждём (venv-сборка до 3 мин заблокировала бы poll-цикл). Перерисуем
      // экран по завершении — только если пользователь всё ещё на нём.
      const setup = ctx.deps.runUserbotSetup || (() => runSetupCommand(bin));
      setup()
        .then(async () => {
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            const v = await buildScreen(st, ctx);
            await ctx.flows.screen(st, v.text, v.rows);
          }
        })
        .catch(async () => {
          ctx.deps.log?.("userbot setup failed");
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            await ctx.flows.screen(
              st,
              ctx.tr(
                "🧪 Beta\n\nSetup failed. Check the service logs, then try again.",
                "🧪 Бета\n\nНастройка завершилась с ошибкой. Проверь логи сервиса и повтори.",
              ),
              [
                [
                  ctx.btn(
                    ctx.tr("Try again", "Повторить"),
                    `iva_menu:${SID}:do:setup`,
                  ),
                ],
                ctx.backRow(PARENT),
              ],
            );
          }
        });
      return ctx.flows.screen(
        st,
        ctx.tr(
          "🧪 Beta\n\n◇ Setting up the userbot proxy…",
          "🧪 Бета\n\n◇ Собираю userbot-прокси…",
        ),
        [ctx.backRow(PARENT)],
      );
    }

    if (step === "off") {
      if (isContainerRuntime()) {
        await disableContainerUserbot(ctx.deps.root);
      } else {
        await run("systemctl", ["--user", "disable", "--now", SVC]);
      }
      return ctx.show(st, SID);
    }
    return ctx.show(st, SID);
  },

  texts: {
    async ubphone(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const phone = String(text)
        .trim()
        .replace(/[\s()-]/gu, "");
      if (!/^\+[0-9]{8,15}$/u.test(phone)) return promptPhone(st, ctx);
      st.awaitText = null;
      try {
        return await renderOnboardingResult(
          await onboardingFor(ctx).start(phone),
          st,
          ctx,
        );
      } catch {
        return renderOnboardingResult(
          { state: "error", reason: "transport_failed" },
          st,
          ctx,
        );
      }
    },

    async ubpassword(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      if (st.data.ub === null) {
        st.awaitText = {
          kind: "ubpassword",
          secret: true,
          data: { step: "expired" },
        };
        return renderExpired(st, ctx);
      }
      const password = String(text);
      if (!password || password.length > 256) return promptPassword(st, ctx);
      st.awaitText = null;
      try {
        return await renderOnboardingResult(
          await onboardingFor(ctx).password(password),
          st,
          ctx,
        );
      } catch {
        return renderOnboardingResult(
          { state: "error", reason: "transport_failed" },
          st,
          ctx,
        );
      }
    },

    // Двухшаговый приём: сначала api_id (число), затем api_hash. Сообщения уже удалены движком.
    async ubcred(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const value = String(text).trim();
      const step = st.awaitText?.data?.step;
      if (step === "api_id") {
        if (!/^\d+$/.test(value)) {
          return ctx.flows.screen(
            st,
            ctx.tr(
              "api_id must be a number. Send it again or cancel.",
              "api_id должен быть числом. Пришли ещё раз или отмени.",
            ),
            [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
          );
        }
        st.data.ub = { apiId: value };
        return promptCred(st, ctx, "api_hash");
      }
      // api_hash: у Telegram это 32 hex-символа; принимаем непустой токен без пробелов.
      if (!/^\S{8,}$/.test(value)) {
        return ctx.flows.screen(
          st,
          ctx.tr(
            "That doesn't look like an api_hash. Send it again or cancel.",
            "Это не похоже на api_hash. Пришли ещё раз или отмени.",
          ),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      const apiId = st.data.ub?.apiId;
      st.awaitText = null;
      st.data.ub = null;
      try {
        if (isContainerRuntime()) {
          await writeUserbotCredentials(ctx.deps.root, apiId ?? "", value);
        } else {
          await upsertEnv(ctx.deps.envPath, {
            TELEGRAM_API_ID: apiId ?? "",
            TELEGRAM_API_HASH: value,
          });
        }
      } catch (error) {
        const detail = isContainerRuntime()
          ? ""
          : `: ${String(errorMessage(error))}`;
        return ctx.flows.screen(
          st,
          ctx.tr(
            `Couldn't save credentials${detail}`,
            `Не удалось сохранить ключи${detail}`,
          ),
          [ctx.backRow(PARENT)],
        );
      }
      // Ключи есть — экран покажет [Включить].
      return ctx.show(st, SID);
    },
  },
};
