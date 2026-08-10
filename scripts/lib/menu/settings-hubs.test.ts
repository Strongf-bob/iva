/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import test from "node:test";

import { SCREENS } from "./index.ts";

type Button = { text: string; callback_data: string };
type View = { text: string; rows: Button[][] };
type State = { role?: "owner" | "user"; personalRoot?: string };
type Screen = {
  parent: string | null;
  render: (state: State, context: ReturnType<typeof makeCtx>) => View;
};

function makeCtx(lang = "en") {
  return {
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: (screen: string) => [
      { text: "back", callback_data: `iva_menu:${screen}:o` },
    ],
  };
}

function screen(id: string): Screen {
  const value = (SCREENS as Record<string, unknown>)[id];
  assert.ok(value, `screen ${id} must be registered`);
  return value as Screen;
}

function callbacks(view: View): string[] {
  return view.rows.flat().map((button) => button.callback_data);
}

test("settings root groups owner controls and hides unsafe personalized settings", () => {
  const settings = screen("set");
  assert.deepEqual(callbacks(settings.render({ role: "owner" }, makeCtx())), [
    "iva_menu:sai:o",
    "iva_menu:scon:o",
    "iva_menu:sper:o",
    "iva_menu:ssys:o",
    "iva_menu:r:o",
  ]);
  assert.deepEqual(
    callbacks(
      settings.render(
        { role: "owner", personalRoot: "/srv/iva/users/1" },
        makeCtx(),
      ),
    ),
    ["iva_menu:sai:o", "iva_menu:scon:o", "iva_menu:ssys:o", "iva_menu:r:o"],
  );
  assert.deepEqual(callbacks(settings.render({ role: "user" }, makeCtx())), [
    "iva_menu:scon:o",
    "iva_menu:ssys:o",
    "iva_menu:r:o",
  ]);
});

test("settings subgroups expose only their bounded existing screens", () => {
  assert.deepEqual(callbacks(screen("sai").render({}, makeCtx())), [
    "iva_menu:mdl",
    "iva_menu:thk",
    "iva_menu:srch:o",
    "iva_menu:set:o",
  ]);
  assert.deepEqual(
    callbacks(screen("scon").render({ role: "owner" }, makeCtx())),
    ["iva_menu:gws:o", "iva_menu:ub:o", "iva_menu:set:o"],
  );
  assert.deepEqual(
    callbacks(screen("scon").render({ role: "user" }, makeCtx())),
    ["iva_menu:gws:o", "iva_menu:set:o"],
  );
  assert.deepEqual(callbacks(screen("sper").render({}, makeCtx())), [
    "iva_menu:lang:o",
    "iva_menu:chr:o",
    "iva_menu:core:o",
    "iva_menu:set:o",
  ]);
  assert.deepEqual(
    callbacks(screen("ssys").render({ role: "owner" }, makeCtx())),
    ["iva_menu:st:o", "iva_menu:sk:o", "iva_menu:svc:o", "iva_menu:set:o"],
  );
  assert.deepEqual(
    callbacks(screen("ssys").render({ role: "user" }, makeCtx())),
    ["iva_menu:st:o", "iva_menu:set:o"],
  );
});
