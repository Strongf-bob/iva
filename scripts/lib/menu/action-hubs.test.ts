/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalObservationId } from "../../unified-inbox/types.ts";
import { SCREENS } from "./index.ts";

type Button = { text: string; callback_data: string };
type View = { text: string; rows: Button[][] };
type State = {
  flow: "menu";
  chatId: number;
  userId: string;
  screen: string;
  page: number;
  role?: "owner" | "user";
  personalRoot?: string;
  awaitText: null | { kind: string; secret: boolean };
  data: Record<string, unknown>;
  _last?: View;
};
type Context = ReturnType<typeof makeContext>["context"];
type Screen = {
  parent: string;
  render: (state: State, context: Context) => View | Promise<View>;
  on: (
    verb: string,
    args: string[],
    state: State,
    context: Context,
  ) => Promise<void>;
  texts?: Record<
    string,
    (
      text: string,
      message: unknown,
      state: State,
      context: Context,
    ) => Promise<void>
  >;
};

function state(overrides: Partial<State> = {}): State {
  return {
    flow: "menu",
    chatId: 10,
    userId: "20",
    screen: "r",
    page: 0,
    role: "owner",
    awaitText: null,
    data: {},
    ...overrides,
  };
}

function makeContext(dataDir = mkdtempSync(join(tmpdir(), "iva-menu-hubs-"))) {
  const deliveries: Array<Record<string, unknown>> = [];
  const replies: string[] = [];
  const context = {
    deps: {
      dataDir,
      root: process.cwd(),
      deliver: (update: Record<string, unknown>) => {
        deliveries.push(update);
        return Promise.resolve();
      },
      reply: (_chatId: number, text: string) => {
        replies.push(text);
        return Promise.resolve();
      },
    },
    flows: {
      screen: (st: State, text: string, rows: Button[][]) => {
        st._last = { text, rows };
        return Promise.resolve();
      },
      end: (st: State, text: string) => {
        st._last = { text, rows: [] };
        return Promise.resolve();
      },
    },
    tr: (english: string) => english,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: (screenId: string) => [
      { text: "back", callback_data: `iva_menu:${screenId}:o` },
    ],
    show: () => Promise.resolve(),
  };
  return { context, deliveries, replies };
}

function screen(id: string): Screen {
  const value = (SCREENS as Record<string, unknown>)[id];
  assert.ok(value, `screen ${id} must be registered`);
  return value as Screen;
}

function deliveredText(delivery: Record<string, unknown>): string {
  return String(
    (delivery.message as Record<string, unknown> | undefined)?.text ?? "",
  );
}

test("Today shows the open task count and explicitly hands off brief actions", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-today-"));
  writeFileSync(
    join(dataDir, "tasks.json"),
    JSON.stringify([
      { text: "one", done: false },
      { text: "two", done: false },
      { text: "done", done: true },
    ]),
  );
  const { context, deliveries } = makeContext(dataDir);
  const st = state({ screen: "td" });
  const today = screen("td");

  const view = await today.render(st, context);
  assert.match(view.text, /Open tasks: 2/u);
  assert.deepEqual(
    view.rows.flat().map((button) => button.callback_data),
    ["iva_menu:td:brief", "iva_menu:td:weekly", "iva_menu:r:o"],
  );

  await today.on("brief", [], st, context);
  await today.on("weekly", [], st, context);
  assert.deepEqual(deliveries.map(deliveredText), ["/brief", "/weekly"]);
});

test("Inbox renders only bounded owner data and fails closed for ordinary users", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-inbox-"));
  const ownerDir = join(dataDir, "unified-inbox", "owner-20");
  mkdirSync(ownerDir, { recursive: true });
  const identity = {
    source: "gmail" as const,
    sourceAccountId: "owner@gmail.example",
    externalId: "message-1",
  };
  const observationId = canonicalObservationId(identity);
  writeFileSync(
    join(ownerDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      ownerId: "20",
      cursors: {},
      observations: {
        [observationId]: {
          schemaVersion: 1,
          id: observationId,
          ...identity,
          revision: "1",
          kind: "message",
          occurredAt: "2026-08-10T06:00:00.000Z",
          title: "Contract approval",
          excerpt: `${"A".repeat(180)} secret tail`,
          participants: [],
          evidence: {
            source: "gmail",
            externalId: "message-1",
            timestamp: "2026-08-10T06:00:00.000Z",
            locator: "gmail:message-1",
          },
        },
      },
      processedFingerprints: [],
      classifications: { [observationId]: "urgent" },
      sourceHealth: {
        gmail: {
          status: "ok",
          collected: 1,
          checkedAt: "2026-08-10T06:05:00.000Z",
          errorCode: null,
        },
      },
      lastReport: {
        generatedAt: "2026-08-10T06:06:00.000Z",
        digest: "a".repeat(64),
        urgent: 1,
        needsReply: 0,
        meetings: 0,
        partial: false,
      },
    }),
  );
  const { context } = makeContext(dataDir);
  const inbox = screen("in");

  const ownerView = await inbox.render(state({ screen: "in" }), context);
  assert.match(ownerView.text, /Urgent: 1/u);
  assert.match(ownerView.text, /Contract approval/u);
  assert.equal(ownerView.text.includes("secret tail"), false);
  assert.ok(ownerView.text.length < 1600);

  const userView = await inbox.render(
    state({ screen: "in", role: "user" }),
    context,
  );
  assert.match(userView.text, /available only to the owner/u);
  assert.equal(userView.text.includes("Contract approval"), false);
});

test("Inbox reports missing or corrupt state honestly", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-inbox-empty-"));
  const { context } = makeContext(dataDir);
  const inbox = screen("in");
  const missing = await inbox.render(state({ screen: "in" }), context);
  assert.match(missing.text, /No inbox snapshot yet/u);

  const ownerDir = join(dataDir, "unified-inbox", "owner-20");
  mkdirSync(ownerDir, { recursive: true });
  writeFileSync(join(ownerDir, "state.json"), "{broken");
  const corrupt = await inbox.render(state({ screen: "in" }), context);
  assert.match(corrupt.text, /Inbox snapshot is unavailable/u);
});

test("Tasks lists or captures one bounded task without putting it in callback data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-tasks-"));
  writeFileSync(
    join(dataDir, "tasks.json"),
    JSON.stringify([{ text: "one", done: false }]),
  );
  const { context, deliveries } = makeContext(dataDir);
  const tasks = screen("tsk");
  const st = state({ screen: "tsk" });
  const view = await tasks.render(st, context);
  assert.match(view.text, /Open tasks: 1/u);
  assert.equal(JSON.stringify(view.rows).includes("Buy milk"), false);

  await tasks.on("list", [], st, context);
  assert.equal(deliveredText(deliveries[0]), "/tasks");

  await tasks.on("add", [], st, context);
  assert.deepEqual(st.awaitText, { kind: "task_add", secret: false });
  await tasks.texts?.task_add("Buy milk", {}, st, context);
  assert.equal(deliveredText(deliveries[1]), "/task Buy milk");

  const before = deliveries.length;
  await tasks.on("add", [], st, context);
  await tasks.texts?.task_add("x".repeat(501), {}, st, context);
  assert.equal(deliveries.length, before);
  assert.match(st._last?.text ?? "", /between 1 and 500/u);
});

test("Automation links to the existing detailed timers screen", async () => {
  const { context } = makeContext();
  const view = await screen("auto").render(state({ screen: "auto" }), context);
  assert.deepEqual(
    view.rows.flat().map((button) => button.callback_data),
    ["iva_menu:cron:o", "iva_menu:r:o"],
  );
});
