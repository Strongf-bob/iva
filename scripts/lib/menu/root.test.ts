/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";

import root from "./root.ts";

function makeCtx(lang: string) {
  return {
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
  };
}

const englishRows = [
  [
    ["✨ Today", "iva_menu:td:o"],
    ["📥 Inbox", "iva_menu:in:o"],
  ],
  [
    ["👥 People", "iva_menu:ppl:o"],
    ["✅ Tasks", "iva_menu:tsk:o"],
  ],
  [
    ["🔔 Automation", "iva_menu:auto:o"],
    ["⚙️ Settings", "iva_menu:set:o"],
  ],
  [["✖ Close", "iva_menu:r:x"]],
];

const russianRows = [
  [
    ["✨ Сегодня", "iva_menu:td:o"],
    ["📥 Входящие", "iva_menu:in:o"],
  ],
  [
    ["👥 Люди", "iva_menu:ppl:o"],
    ["✅ Задачи", "iva_menu:tsk:o"],
  ],
  [
    ["🔔 Автоматизация", "iva_menu:auto:o"],
    ["⚙️ Настройки", "iva_menu:set:o"],
  ],
  [["✖ Закрыть", "iva_menu:r:x"]],
];

function compact(
  rows: Array<Array<{ text: string; callback_data: string }>>,
): Array<Array<[string, string]>> {
  return rows.map((row) =>
    row.map(({ text, callback_data }) => [text, callback_data]),
  );
}

test("root preserves English row order, callbacks, and close action", () => {
  const state = { page: 3 };
  const view = root.render(state, makeCtx("en"));

  assert.equal(view.text, "Iva\n\nChoose what you want to do.");
  assert.deepEqual(compact(view.rows), englishRows);
  assert.deepEqual(state, { page: 3 });
});

test("root translates labels without changing callback routing", () => {
  const view = root.render({}, makeCtx("ru"));

  assert.equal(view.text, "Ива\n\nЧто хочешь сделать?");
  assert.deepEqual(compact(view.rows), russianRows);
  assert.deepEqual(
    compact(view.rows)
      .flat()
      .map(([, callback]) => callback),
    englishRows.flat().map(([, callback]) => callback),
  );
});

test("root exposes the top-level screen contract", () => {
  assert.equal(root.parent, null);
  assert.equal(root.on("ignored", [], {}, makeCtx("en")), undefined);
});

test("ordinary user root exposes only personal action hubs", () => {
  const view = root.render({ role: "user" }, makeCtx("en"));
  assert.deepEqual(compact(view.rows), [
    [
      ["✨ Today", "iva_menu:td:o"],
      ["✅ Tasks", "iva_menu:tsk:o"],
    ],
    [
      ["🔔 Automation", "iva_menu:auto:o"],
      ["⚙️ Settings", "iva_menu:set:o"],
    ],
    [["✖ Close", "iva_menu:r:x"]],
  ]);
});

test("personalized owner retains all owner action hubs", () => {
  const view = root.render(
    { role: "owner", personalRoot: "/srv/iva/data/users/101" },
    makeCtx("en"),
  );
  assert.deepEqual(compact(view.rows), englishRows);
});
