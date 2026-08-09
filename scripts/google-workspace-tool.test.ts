import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-google-tool-"));
mkdirSync(join(root, "vault"));
process.env.ASSISTANT_MULTI_USER = "1";
process.env.ASSISTANT_PERSONAL_ROOT = root;

const { validateGoogleWorkspaceArgs } =
  await import("../agent/tools/google_workspace.ts");

void test("Google tool accepts structured gws calls without a shell", () => {
  assert.deepEqual(
    validateGoogleWorkspaceArgs([
      "calendar",
      "events",
      "list",
      "--params",
      '{"calendarId":"primary"}',
    ]),
    ["calendar", "events", "list", "--params", '{"calendarId":"primary"}'],
  );
  assert.deepEqual(
    validateGoogleWorkspaceArgs([
      "gmail",
      "users",
      "drafts",
      "create",
      "--params",
      '{"userId":"me"}',
      "--json",
      '{"message":{"raw":"encoded"}}',
    ]),
    [
      "gmail",
      "users",
      "drafts",
      "create",
      "--params",
      '{"userId":"me"}',
      "--json",
      '{"message":{"raw":"encoded"}}',
    ],
  );
  assert.deepEqual(
    validateGoogleWorkspaceArgs([
      "calendar",
      "+insert",
      "--json",
      '{"summary":"Focus","start":{"date":"2026-08-10"},"end":{"date":"2026-08-11"}}',
    ]),
    [
      "calendar",
      "+insert",
      "--json",
      '{"summary":"Focus","start":{"date":"2026-08-10"},"end":{"date":"2026-08-11"}}',
    ],
  );
});

void test("Google tool rejects auth/config flags and host path escapes", () => {
  assert.throws(
    () => validateGoogleWorkspaceArgs(["auth", "login"]),
    /service is not allowed/u,
  );
  assert.throws(
    () =>
      validateGoogleWorkspaceArgs(["gmail", "+triage", "--output", "/tmp/x"]),
    /flag is not allowed/u,
  );
  assert.throws(
    () => validateGoogleWorkspaceArgs(["drive", "+upload", "../../.env"]),
    /escaped personal root/u,
  );
});

void test("Google tool enforces the owner-safe mutation policy", () => {
  for (const args of [
    ["gmail", "+send", "--to", "a@example.com", "--body", "hello"],
    ["gmail", "+reply", "--message-id", "m1", "--body", "hello"],
    ["gmail", "users", "messages", "send", "--json", "{}"],
    ["gmail", "users", "messages", "delete", "--params", "{}"],
    ["calendar", "events", "delete", "--params", "{}"],
    ["tasks", "tasks", "patch", "--params", "{}", "--json", "{}"],
    ["tasks", "tasks", "delete", "--params", "{}"],
    ["sheets", "+append", "--spreadsheet", "s1", "--values", "x"],
    ["docs", "+write", "--document", "d1", "--text", "x"],
  ]) {
    assert.throws(
      () => validateGoogleWorkspaceArgs(args),
      /operation is not allowed/u,
      args.join(" "),
    );
  }
});

void test("Calendar creation rejects attendees in every JSON payload", () => {
  for (const body of [
    '{"summary":"Meeting","attendees":[{"email":"a@example.com"}]}',
    '{"extendedProperties":{"private":{"attendees":"hidden"}}}',
  ]) {
    assert.throws(
      () =>
        validateGoogleWorkspaceArgs([
          "calendar",
          "events",
          "insert",
          "--params",
          '{"calendarId":"primary"}',
          "--json",
          body,
        ]),
      /attendees are not allowed/u,
    );
  }
});

void test("Google tool only accepts valid JSON for structured flags", () => {
  assert.throws(
    () =>
      validateGoogleWorkspaceArgs([
        "tasks",
        "tasks",
        "insert",
        "--params",
        '{"tasklist":"@default"}',
        "--json",
        "{broken",
      ]),
    /valid JSON/u,
  );
});
