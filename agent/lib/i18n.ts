// Двуязычие моста и канала. Один источник языка (getLang) и одна таблица команд
// (COMMANDS) кормят и /help, и синее командное меню Telegram (setMyCommands).
//
// ЖЁСТКОЕ ПРАВИЛО репо: ни одна module-level const нигде не должна захватывать
// переведённую строку — иначе язык замерзает до рестарта процесса. Поэтому tr —
// функция, а helpText() генерит текст на каждый вызов. Захватывать можно только
// САМИ пары {en, ru} (COMMANDS), выбор из них делается в момент вызова.

import { statSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "./settings.ts";

// Тот же путь, что в settings.ts (от cwd, не от import.meta.url — см. там про
// authored-modules-кэш eve). Нужен для statSync-дросселя ниже.
const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/")
  ? DATA_DIR_RAW
  : join(process.cwd(), DATA_DIR_RAW);
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// settings.json меняется кнопкой в /menu и должен подхватываться на лету. Но statSync
// на КАЖДЫЙ tr() (а их сотни за ход) — лишний сисколл, поэтому проверку файла
// дросселируем до ~2с: между проверками отдаём закэшированный язык, ошибки stat глотаем.
const CHECK_INTERVAL_MS = 2000;
type Language = "ru" | "en";
type Command = {
  readonly command: string;
  readonly en: string;
  readonly ru: string;
  readonly args?: { readonly en: string; readonly ru: string };
};

export type ChiefOfStaffCommand =
  | { readonly skill: "chief-of-staff-today"; readonly subject: null }
  | { readonly skill: "relationship-briefing"; readonly subject: string }
  | { readonly skill: "weekly-review"; readonly subject: null };

export type PersonMemoryCommand =
  | { readonly mode: "view"; readonly name: string }
  | {
      readonly mode: "supplement";
      readonly name: string;
      readonly note: string;
    };

const cache: { lang: Language | null; mtimeMs: number; checkedAt: number } = {
  lang: null,
  mtimeMs: -1,
  checkedAt: 0,
};

// settings.language ("ru"|"en") → env AGENT_LANGUAGE → "ru". Незнакомые значения
// в settings проваливаются к env, незнакомый env — к дефолту "ru".
function resolveLang(): Language {
  const fromSettings = readSettings().language;
  if (fromSettings === "ru" || fromSettings === "en") return fromSettings;
  return process.env.AGENT_LANGUAGE === "en" ? "en" : "ru";
}

export function getLang(): Language {
  const now = Date.now();
  if (cache.lang !== null && now - cache.checkedAt < CHECK_INTERVAL_MS)
    return cache.lang;
  cache.checkedAt = now;
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    // файла нет / нет доступа — mtimeMs=-1, язык возьмётся из env-фолбэка
  }
  if (cache.lang !== null && mtimeMs === cache.mtimeMs) return cache.lang;
  cache.mtimeMs = mtimeMs;
  cache.lang = resolveLang();
  return cache.lang;
}

// Идиома репо: выбор перевода двумя литералами на месте вызова (не словари по ключам).
export const tr = (en: string, ru: string): string =>
  getLang() === "ru" ? ru : en;

// ЕДИНЫЙ список команд для helpText() и setMyCommands. Порядок = порядок в /help и
// в синем меню. args (опц.) — подсказка аргументов: попадает только в /help, не в
// описание команды Telegram (там аргументов быть не должно). Никаких /clear и /compact —
// как в текущем HELP.
export const COMMANDS: ReadonlyArray<Command> = [
  { command: "menu", en: "settings menu", ru: "меню настроек" },
  { command: "help", en: "this list", ru: "этот список" },
  {
    command: "stop",
    en: "interrupt the current turn (same as the ⏹ Stop button)",
    ru: "прервать текущий ход (как кнопка ⏹ Стоп)",
  },
  {
    command: "new",
    en: "start over (reset the current conversation)",
    ru: "начать диалог заново",
  },
  {
    command: "restart",
    en: "restart the agent if it's stuck",
    ru: "перезапустить зависшего агента",
  },
  {
    command: "update",
    en: "check for a new version and install it",
    ru: "проверить и установить обновление",
  },
  {
    command: "model",
    en: "switch AI provider/model/thinking effort",
    ru: "сменить провайдера, модель и размышления",
  },
  {
    command: "think",
    en: "set thinking effort",
    ru: "настроить уровень размышлений",
  },
  {
    command: "usage",
    en: "token usage",
    ru: "расход токенов",
    args: {
      en: "[today|week|month|by-model|by-source]",
      ru: "[today|week|month|by-model|by-source]",
    },
  },
  {
    command: "task",
    en: "add a task",
    ru: "добавить задачу",
    args: { en: "<text>", ru: "<текст>" },
  },
  { command: "tasks", en: "show tasks", ru: "показать задачи" },
  { command: "digest", en: "morning digest", ru: "утренний дайджест" },
  {
    command: "brief",
    en: "daily brief or meeting prep",
    ru: "бриф дня или подготовка к разговору",
    args: { en: "<person>", ru: "<человек>" },
  },
  {
    command: "weekly",
    en: "weekly review",
    ru: "недельный обзор",
  },
];

export function chiefOfStaffCommand(text: string): ChiefOfStaffCommand | null {
  const match =
    /^\/(?<command>brief|weekly)(?:@[A-Za-z0-9_]+)?(?:\s+(?<subject>[\s\S]*?))?\s*$/iu.exec(
      text.trim(),
    );
  if (!match) return null;

  const command = match.groups?.command.toLowerCase();
  const subject = match.groups?.subject?.trim() ?? "";
  if (command === "weekly") {
    return subject.length === 0
      ? { skill: "weekly-review", subject: null }
      : null;
  }
  return subject.length === 0
    ? { skill: "chief-of-staff-today", subject: null }
    : { skill: "relationship-briefing", subject };
}

const boundedText = (
  value: unknown,
  maxCodePoints: number,
  collapseWhitespace = false,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = collapseWhitespace
    ? value.trim().replace(/\s+/gu, " ")
    : value.trim();
  const length = [...normalized].length;
  return length >= 1 && length <= maxCodePoints ? normalized : null;
};

export function personMemoryCommand(text: string): PersonMemoryCommand | null {
  const view = /^\/person(?:@[A-Za-z0-9_]+)?\s+(?<name>[\s\S]*?)\s*$/iu.exec(
    text.trim(),
  );
  if (view) {
    const name = boundedText(view.groups?.name, 160, true);
    return name === null ? null : { mode: "view", name };
  }

  const supplement =
    /^\/person_update(?:@[A-Za-z0-9_]+)?\s+(?<payload>[\s\S]+)$/iu.exec(
      text.trim(),
    );
  if (!supplement) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(supplement.groups?.payload ?? "");
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "note")
    return null;
  const name = boundedText(record.name, 160, true);
  const note = boundedText(record.note, 2000);
  return name === null || note === null
    ? null
    : { mode: "supplement", name, note };
}

// Текст /help на текущем языке. Генерится на каждый вызов (язык мог смениться).
export function helpText(): string {
  const isRu = getLang() === "ru";
  const pick = (en: string, ru: string): string => (isRu ? ru : en);
  const lines = COMMANDS.map((c) => {
    const hint = c.args ? ` ${pick(c.args.en, c.args.ru)}` : "";
    return `/${c.command}${hint} — ${pick(c.en, c.ru)}`;
  });
  return [pick("Iva commands:", "Команды Iva:"), ...lines].join("\n");
}

// Массив для setMyCommands на конкретном языке (мост зовёт дважды: default=en и
// language_code:"ru"), поэтому язык здесь явный, а не через getLang(). Описания без
// подсказок аргументов — Telegram показывает только имя команды и описание.
export function botCommands(
  lang: string,
): Array<{ command: string; description: string }> {
  const isRu = lang === "ru";
  return COMMANDS.map((c) => ({
    command: c.command,
    description: isRu ? c.ru : c.en,
  }));
}
