import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleProactiveCommitmentCallback } from "./callback.ts";
import { ProactiveStore } from "./store.ts";

function fixture(t: test.TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-proactive-callback-"));
  chmodSync(dataDir, 0o700);
  const store = ProactiveStore.open(dataDir);
  const [action] = store.createCommitmentActions({
    ownerId: "101",
    reportVersionId: 1,
    suggestions: [
      {
        id: "commitment-1",
        title: "Prepare launch note",
        evidence: ["telegram:message:1:2"],
      },
    ],
    tokenSecret: "s".repeat(32),
    nowMs: 1_000,
  });
  store.close();
  t.after(() => {});
  const answers: string[] = [];
  const tenant = {
    user: { id: "101", role: "owner" as const },
    dataDir,
  };
  const callback = {
    id: "callback-1",
    data: `iva_commitment:c:${action.token}`,
    from: { id: 101 },
    message: { chat: { id: 101, type: "private" } },
  };
  return {
    action,
    answers,
    tenant,
    callback,
    answer: async (text: string) => {
      answers.push(text);
    },
  };
}

void test("non-proactive callback is left to the next bridge handler", async (t) => {
  const value = fixture(t);
  assert.equal(
    await handleProactiveCommitmentCallback({
      callback: { ...value.callback, data: "iva_menu:r" },
      tenant: value.tenant,
      answer: value.answer,
    }),
    false,
  );
  assert.deepEqual(value.answers, []);
});

void test("matching owner in a private chat can confirm once", async (t) => {
  const value = fixture(t);
  assert.equal(
    await handleProactiveCommitmentCallback({
      callback: value.callback,
      tenant: value.tenant,
      answer: value.answer,
    }),
    true,
  );
  assert.match(value.answers[0] ?? "", /confirmed|подтвержден/iu);

  await handleProactiveCommitmentCallback({
    callback: value.callback,
    tenant: value.tenant,
    answer: value.answer,
  });
  assert.match(value.answers[1] ?? "", /already|уже/iu);
});

void test("dismiss is terminal and never creates confirmed task work", async (t) => {
  const value = fixture(t);
  await handleProactiveCommitmentCallback({
    callback: {
      ...value.callback,
      data: `iva_commitment:d:${value.action.token}`,
    },
    tenant: value.tenant,
    answer: value.answer,
  });
  const store = ProactiveStore.open(value.tenant.dataDir);
  assert.equal(store.claimConfirmedCommitment(2_000), null);
  store.close();
});

void test("foreign sender, group chat, non-owner and unknown token are consumed without disclosure", async (t) => {
  const value = fixture(t);
  const cases = [
    {
      callback: { ...value.callback, from: { id: 202 } },
      tenant: value.tenant,
    },
    {
      callback: {
        ...value.callback,
        message: { chat: { id: -100, type: "group" } },
      },
      tenant: value.tenant,
    },
    {
      callback: value.callback,
      tenant: { ...value.tenant, user: { id: "101", role: "user" as const } },
    },
    {
      callback: {
        ...value.callback,
        data: `iva_commitment:c:${"x".repeat(43)}`,
      },
      tenant: value.tenant,
    },
  ];

  for (const item of cases) {
    const before = value.answers.length;
    assert.equal(
      await handleProactiveCommitmentCallback({
        ...item,
        answer: value.answer,
      }),
      true,
    );
    const answer = value.answers[before] ?? "";
    assert.doesNotMatch(answer, /Prepare|launch|commitment-1/u);
  }
});

void test("malformed matching prefix is consumed even when state cannot open", async (t) => {
  const value = fixture(t);
  let opened = false;
  assert.equal(
    await handleProactiveCommitmentCallback({
      callback: { ...value.callback, data: "iva_commitment:broken" },
      tenant: value.tenant,
      answer: value.answer,
      openStore: () => {
        opened = true;
        throw new Error("must not open");
      },
    }),
    true,
  );
  assert.equal(opened, false);
});
