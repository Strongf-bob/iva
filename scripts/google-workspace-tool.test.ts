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

void test("Google policy blocks sending, task bypasses, deletion, and attendees", () => {
  for (const args of [
    ["gmail", "+send", "--to", "x@example.com", "--body", "hi"],
    ["tasks", "tasks", "insert", "--params", '{"tasklist":"@default"}', "--json", '{"title":"x"}'],
    ["drive", "files", "delete", "--params", '{"fileId":"x"}'],
    ["calendar", "+insert", "--json", '{"summary":"x","attendees":[]}'],
  ]) {
    assert.throws(() => validateGoogleWorkspaceArgs(args), /not allowed|attendees/u);
  }
  assert.deepEqual(
    validateGoogleWorkspaceArgs(["tasks", "tasks", "list", "--params", '{"tasklist":"@default"}']),
    ["tasks", "tasks", "list", "--params", '{"tasklist":"@default"}'],
  );
});
