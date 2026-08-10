/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import { attemptTelegramRichDelivery } from "../agent/lib/telegram-rich-delivery.ts";

test("rich delivery reports a definitive API rejection as retryable", async () => {
  const outcome = await attemptTelegramRichDelivery(() =>
    Promise.resolve({ ok: false, status: 400, body: { description: "bad" } }),
  );
  assert.deepEqual(outcome, {
    kind: "rejected",
    status: 400,
    body: { description: "bad" },
  });
});

test("rich delivery reports a transport exception as ambiguous", async () => {
  const error = new Error("socket closed after write");
  const outcome = await attemptTelegramRichDelivery(() =>
    Promise.reject(error),
  );
  assert.deepEqual(outcome, { kind: "ambiguous", error });
});

test("rich delivery reports an accepted request as delivered", async () => {
  const outcome = await attemptTelegramRichDelivery(() =>
    Promise.resolve({ ok: true, status: 200, body: { result: true } }),
  );
  assert.deepEqual(outcome, { kind: "delivered" });
});
