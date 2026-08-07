import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function assertIgnored(path: string, entry: string): void {
  assert.match(
    read(path),
    new RegExp(`^${entry.replaceAll("/", "\\/")}$`, "mu"),
  );
}

void test("private runtime state is excluded from Git and the image context", () => {
  assertIgnored(".gitignore", "/memory/");
  assertIgnored(".gitignore", "/iva-runtime/");

  for (const entry of [".git", ".env", "data", "memory", "vault"]) {
    assertIgnored(".dockerignore", entry);
  }
});

void test("the production image uses Node 24 and a non-root runtime user", () => {
  const containerfile = read("Containerfile");
  assert.match(containerfile, /^FROM node:24-bookworm-slim AS runtime$/mu);
  assert.match(
    containerfile,
    /^LABEL org\.opencontainers\.image\.source="https:\/\/github\.com\/Strongf-bob\/iva"$/mu,
  );
  assert.match(containerfile, /^USER node$/mu);
});

void test("production Compose requires an immutable image and narrow mounts", () => {
  const compose = read("deploy/container/compose.production.yml");
  assert.equal(
    compose.match(/image: \$\{IVA_IMAGE:\?IVA_IMAGE is required\}/gu)?.length,
    2,
  );
  assert.match(compose, /127\.0\.0\.1:8723:8723/u);
  assert.match(compose, /\/eve\/v1\/health/u);
  assert.match(compose, /condition: service_healthy/u);
  assert.equal(compose.match(/restart: unless-stopped/gu)?.length, 2);
  for (const mount of [
    "./data:/app/data",
    "./memory:/app/memory",
    "./vault:/app/vault",
    "./.env:/app/.env:ro",
  ]) {
    assert.equal(
      compose.split(mount).length - 1,
      2,
      `${mount} must be mounted twice`,
    );
  }
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.doesNotMatch(compose, /^\s*-\s*["']?8723:8723/mu);
});

void test("deployment waits for successful main CI and keeps least privilege", () => {
  const workflow = read(".github/workflows/deploy.yml");
  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /workflows:\s*\["CI"\]/u);
  assert.match(workflow, /types:\s*\[completed\]/u);
  assert.match(
    workflow,
    /github\.event\.workflow_run\.conclusion == 'success'/u,
  );
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/u);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/u);
  assert.match(
    workflow,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/u,
  );
  assert.match(
    workflow,
    /ref:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/u,
  );
  assert.match(workflow, /^permissions:\n\s+contents: read$/mu);
  assert.match(workflow, /packages: write/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /concurrency:/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);

  for (const line of workflow.split("\n")) {
    if (!line.trimStart().startsWith("uses:")) continue;
    assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/u);
  }
});
