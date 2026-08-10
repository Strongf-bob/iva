/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import test from "node:test";

import { SCREENS } from "./index.ts";

type Button = { text: string; callback_data: string };
type View = { text: string; rows: Button[][] };
type State = {
  chatId: number;
  userId: string;
  role?: "owner" | "user";
  awaitText: null | { kind: string; secret: boolean };
  data: Record<string, unknown>;
  _last?: View;
};
type Context = ReturnType<typeof harness>["context"];
type PeopleScreen = {
  render: (state: State, context: Context) => View;
  on: (
    verb: string,
    args: string[],
    state: State,
    context: Context,
  ) => Promise<void>;
  texts: Record<
    string,
    (
      text: string,
      message: unknown,
      state: State,
      context: Context,
    ) => Promise<void>
  >;
};

function harness() {
  const deliveries: Array<Record<string, unknown>> = [];
  const context = {
    deps: {
      deliver: (update: Record<string, unknown>) => {
        deliveries.push(update);
        return Promise.resolve(true);
      },
      reply: () => Promise.resolve(),
    },
    flows: {
      screen: (state: State, text: string, rows: Button[][]) => {
        state._last = { text, rows };
        return Promise.resolve();
      },
      end: (state: State, text: string) => {
        state._last = { text, rows: [] };
        return Promise.resolve();
      },
    },
    tr: (english: string) => english,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: (screen: string) => [
      { text: "back", callback_data: `iva_menu:${screen}:o` },
    ],
  };
  return { context, deliveries };
}

function state(overrides: Partial<State> = {}): State {
  return {
    chatId: 10,
    userId: "20",
    role: "owner",
    awaitText: null,
    data: {},
    ...overrides,
  };
}

function people(): PeopleScreen {
  const screen = (SCREENS as Record<string, unknown>).ppl;
  assert.ok(screen, "People screen must be registered");
  return screen as PeopleScreen;
}

function deliveredText(delivery: Record<string, unknown>): string {
  const value = (delivery.message as Record<string, unknown> | undefined)?.text;
  return typeof value === "string" ? value : "";
}

test("People is owner-only and callbacks never contain personal data", () => {
  const { context } = harness();
  const screen = people();
  const owner = screen.render(state(), context);
  assert.deepEqual(
    owner.rows.flat().map((button) => button.callback_data),
    [
      "iva_menu:ppl:know",
      "iva_menu:ppl:add",
      "iva_menu:ppl:brief",
      "iva_menu:r:o",
    ],
  );
  assert.equal(JSON.stringify(owner.rows).includes("Alice"), false);

  const ordinary = screen.render(state({ role: "user" }), context);
  assert.match(ordinary.text, /available only to the owner/u);
  assert.deepEqual(
    ordinary.rows.flat().map((button) => button.callback_data),
    ["iva_menu:r:o"],
  );
});

test("People hands off bounded lookup and brief requests", async () => {
  const { context, deliveries } = harness();
  const screen = people();
  const st = state();

  await screen.on("know", [], st, context);
  assert.deepEqual(st.awaitText, { kind: "person_lookup", secret: false });
  await screen.texts.person_lookup("  Alice Example  ", {}, st, context);

  await screen.on("brief", [], st, context);
  assert.deepEqual(st.awaitText, { kind: "person_brief", secret: false });
  await screen.texts.person_brief("Alice Example", {}, st, context);
  assert.deepEqual(deliveries.map(deliveredText), [
    "/person Alice Example",
    "/brief Alice Example",
  ]);

  const count = deliveries.length;
  await screen.on("know", [], st, context);
  await screen.texts.person_lookup("x".repeat(161), {}, st, context);
  assert.equal(deliveries.length, count);
  assert.match(st._last?.text ?? "", /between 1 and 160/u);
});

test("People supplements one resolved card through a structured hidden command", async () => {
  const { context, deliveries } = harness();
  const screen = people();
  const st = state();

  await screen.on("add", [], st, context);
  assert.deepEqual(st.awaitText, { kind: "person_add_name", secret: false });
  await screen.texts.person_add_name("Alice Example", {}, st, context);
  assert.equal(st.data.personName, "Alice Example");
  assert.deepEqual(st.awaitText, { kind: "person_add_note", secret: false });
  await screen.texts.person_add_note(
    "Prefers meetings after lunch",
    {},
    st,
    context,
  );

  const command = deliveredText(deliveries[0]);
  assert.match(command, /^\/person_update /u);
  assert.deepEqual(JSON.parse(command.slice("/person_update ".length)), {
    name: "Alice Example",
    note: "Prefers meetings after lunch",
  });
  assert.equal(st.data.personName, undefined);

  const count = deliveries.length;
  await screen.on("add", [], st, context);
  await screen.texts.person_add_name("Alice Example", {}, st, context);
  await screen.texts.person_add_note("x".repeat(2001), {}, st, context);
  assert.equal(deliveries.length, count);
  assert.match(st._last?.text ?? "", /between 1 and 2000/u);
});
