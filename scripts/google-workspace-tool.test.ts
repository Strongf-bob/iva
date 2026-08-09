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
    ["calendar", "events", "delete", "--params", "{}"],
    ["calendar", "acl", "insert", "--json", '{"role":"writer"}'],
    [
      "tasks",
      "tasks",
      "insert",
      "--params",
      '{"tasklist":"@default"}',
      "--json",
      '{"title":"x"}',
    ],
    ["tasks", "tasks", "patch", "--params", "{}", "--json", "{}"],
    ["tasks", "tasks", "delete", "--params", "{}"],
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
        "calendar",
        "events",
        "insert",
        "--json",
        "{broken",
      ]),
    /valid JSON/u,
  );
});

void test("Google policy permits reads and approved artifact writes", () => {
  for (const args of [
    ["gmail", "users", "messages", "list", "--params", '{"userId":"me"}'],
    ["tasks", "tasks", "list", "--params", '{"tasklist":"@default"}'],
    ["calendar", "events", "insert", "--json", '{"summary":"Focus"}'],
    ["drive", "files", "create", "--json", '{"name":"Notes"}'],
    ["drive", "files", "copy", "--params", '{"fileId":"source"}'],
    ["docs", "documents", "create", "--json", '{"title":"Notes"}'],
    ["docs", "documents", "batchUpdate", "--json", '{"requests":[]}'],
    ["docs", "+write", "--document", "d1", "--text", "paragraph"],
    [
      "sheets",
      "spreadsheets",
      "create",
      "--json",
      '{"properties":{"title":"Plan"}}',
    ],
    ["sheets", "spreadsheets", "batchUpdate", "--json", '{"requests":[]}'],
    ["sheets", "+append", "--spreadsheet", "s1", "--values", "x"],
  ]) {
    assert.doesNotThrow(
      () => validateGoogleWorkspaceArgs(args),
      args.join(" "),
    );
  }
});

void test("Docs and Sheets batch updates reject destructive requests", () => {
  for (const args of [
    [
      "sheets",
      "spreadsheets",
      "batchUpdate",
      "--json",
      '{"requests":[{"deleteSheet":{"sheetId":7}}]}',
    ],
    [
      "docs",
      "documents",
      "batchUpdate",
      "--json",
      '{"requests":[{"deleteContentRange":{"range":{"startIndex":1,"endIndex":3}}}]}',
    ],
  ]) {
    assert.throws(
      () => validateGoogleWorkspaceArgs(args),
      /destructive Google Workspace mutation/u,
    );
  }
});
