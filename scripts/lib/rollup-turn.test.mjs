import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TURN_TIMEOUT_MS, RollupTurnTimeoutError, withTurnTimeout } from "./rollup-turn.mjs";

test("a turn that finishes in time returns its result", async () => {
  const result = await withTurnTimeout(async () => "report", { timeoutMs: 50, label: "main-turn" });
  assert.equal(result, "report");
});

test("a hung turn rejects with a labelled timeout error", async () => {
  await assert.rejects(
    withTurnTimeout(() => new Promise(() => {}), { timeoutMs: 20, label: "main-turn" }),
    (e) => {
      assert.ok(e instanceof RollupTurnTimeoutError);
      assert.equal(e.code, "ROLLUP_TURN_TIMEOUT");
      assert.equal(e.label, "main-turn");
      return true;
    },
  );
});

test("the timer is cleared, so the next turn runs right after a win", async () => {
  assert.equal(await withTurnTimeout(async () => 1, { timeoutMs: DEFAULT_TURN_TIMEOUT_MS, label: "first" }), 1);
  assert.equal(await withTurnTimeout(async () => 2, { timeoutMs: DEFAULT_TURN_TIMEOUT_MS, label: "second" }), 2);
  // Файл теста завершается сам: незачищенный 10-минутный таймер держал бы event loop.
});
