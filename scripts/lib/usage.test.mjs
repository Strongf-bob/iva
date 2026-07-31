import test from "node:test";
import assert from "node:assert/strict";
import { summarize, formatUsageReport, parseWindow } from "./usage.mjs";

const step = (over = {}) => ({
  ts: "2026-07-31T01:23:14.343Z",
  source: "channel:telegram",
  provider: "ollama",
  model: "deepseek-v4-pro",
  sessionId: "wrun_1",
  turnId: "turn_1",
  step: 0,
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  ...over,
});

test("last turn reports the current context, not the sum of steps", () => {
  // Форма из репорта #110: два шага одного хода, вход почти одинаковый (весь контекст
  // уходит заново каждым шагом). Складывать его нельзя — это не размер контекста.
  const entries = [
    step({ step: 0, in: 104_632, out: 160, total: 104_792 }),
    step({ step: 1, in: 105_537, out: 755, total: 106_292 }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.equal(last.in, 105_537);
  assert.equal(last.out, 915);
  assert.equal(last.steps, 2);
  // total остаётся суммой по шагам: это честный расход, а не размер контекста.
  assert.equal(last.total, 211_084);
});

test("last turn ignores steps of earlier turns and other sessions", () => {
  const entries = [
    step({ sessionId: "wrun_0", turnId: "turn_9", in: 999_999, out: 1, total: 1_000_000 }),
    step({ turnId: "turn_0", in: 500, out: 5, total: 505 }),
    step({ step: 0, in: 21_448, out: 160, total: 21_608 }),
    step({ step: 1, in: 25_103, out: 755, total: 25_858 }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.equal(last.in, 25_103);
  assert.equal(last.out, 915);
  assert.equal(last.steps, 2);
  assert.equal(last.model, "deepseek-v4-pro");
});

test("single-step turn keeps its own input", () => {
  const { last } = summarize([step({ in: 21_448, out: 160, total: 21_608 })], { window: "last" });
  assert.equal(last.in, 21_448);
  assert.equal(last.out, 160);
});

test("empty log has no last turn", () => {
  assert.deepEqual(summarize([], { window: "last" }), { window: "last", last: null });
  assert.equal(formatUsageReport({ window: "last", last: null }), "No usage logged yet.");
});

test("last-turn report labels the input as context", () => {
  const agg = summarize(
    [
      step({ step: 0, in: 104_632, out: 160, total: 104_792 }),
      step({ step: 1, in: 105_537, out: 755, cacheRead: 12, total: 106_292 }),
    ],
    { window: "last" },
  );
  assert.deepEqual(formatUsageReport(agg).split("\n"), [
    "Last turn: 211 084 tokens",
    "context 105 537 · out 915 · cached 12",
    "2 steps · deepseek-v4-pro · chat",
  ]);
});

test("windowed summaries still sum inputs across turns", () => {
  // Окна today/week/month считают расход, а не размер контекста — сумма здесь верна.
  const entries = [
    step({ turnId: "turn_0", in: 100, out: 10, total: 110 }),
    step({ turnId: "turn_1", in: 200, out: 20, total: 220 }),
  ];
  const agg = summarize(entries, { window: "today", now: Date.parse("2026-07-31T12:00:00Z"), tz: "UTC" });
  assert.equal(agg.totals.in, 300);
  assert.equal(agg.totals.turns, 2);
});

test("parseWindow falls back to the last turn", () => {
  assert.equal(parseWindow(), "last");
  assert.equal(parseWindow("by model"), "by-model");
  assert.equal(parseWindow("нечто"), "last");
});

test("subagent steps never masquerade as the main session's context", () => {
  // Хук пишет шаг субагента с РОДИТЕЛЬСКИМ sessionId, а turnId у субагента свой:
  // eve нумерует ходы как turn_<sequence> внутри каждой сессии, и у ребёнка счётчик
  // начинается заново. Сразу после /new оба ключа — "wrun_1:turn_0", и последняя запись
  // хода оказывается субагентской: контекст показал бы 20 100 вместо 105 537.
  const entries = [
    step({ step: 0, in: 104_632, out: 160, total: 104_792 }),
    step({ step: 1, in: 105_537, out: 300, total: 105_837 }),
    step({ step: 0, subagent: "planner", in: 19_800, out: 90, total: 19_890 }),
    step({ step: 1, subagent: "planner", in: 20_100, out: 120, total: 20_220 }),
  ];
  const { last } = summarize(entries, { window: "last" });
  assert.equal(last.in, 105_537);
  assert.equal(last.contextFromSubagent, false);
  assert.equal(last.subagent, "planner");
  // Расход по-прежнему считается по всем шагам хода, включая субагентские.
  assert.equal(last.out, 670);
  assert.equal(last.steps, 4);
});

test("main-session step after a subagent still wins the context", () => {
  const entries = [
    step({ step: 0, subagent: "planner", in: 19_800, out: 90, total: 19_890 }),
    step({ step: 1, in: 105_537, out: 300, total: 105_837 }),
  ];
  assert.equal(summarize(entries, { window: "last" }).last.in, 105_537);
});

test("a turn made only of subagent steps is reported as approximate", () => {
  const entries = [step({ step: 0, subagent: "planner", in: 19_800, out: 90, total: 19_890 })];
  const agg = summarize(entries, { window: "last" });
  assert.equal(agg.last.in, 19_800);
  assert.equal(agg.last.contextFromSubagent, true);
  assert.match(formatUsageReport(agg), /context ~19 800 \(subagent step\)/);
});
