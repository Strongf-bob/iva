import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(
  new URL("../../deploy/container/deploy.sh", import.meta.url),
);
const goodSha = "a".repeat(40);
const badSha = "b".repeat(40);

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function harness(): {
  root: string;
  env: NodeJS.ProcessEnv;
  log: string;
  imageState: string;
} {
  const root = mkdtempSync(join(tmpdir(), "iva-deploy-test-"));
  const mockBin = join(root, "bin");
  const deployDir = join(root, "deploy");
  mkdirSync(mockBin);
  mkdirSync(deployDir);
  writeFileSync(join(root, "compose.yml"), "name: test\n");
  writeFileSync(
    join(root, ".env"),
    "TELEGRAM_BOT_TOKEN=123456:test-token\n" +
      "TELEGRAM_PROXY_URL=socks5h://10.0.2.2:7891\n",
    { mode: 0o600 },
  );

  const log = join(root, "commands.log");
  const imageState = join(root, "running-image");

  executable(
    join(mockBin, "docker"),
    'printf "docker image=%s args=%s\\n" "${IVA_IMAGE:-}" "$*" >> "$MOCK_LOG"\n' +
      'if [ "${1:-}" = "info" ]; then printf \'["name=rootless"]\\n\'; exit 0; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "up -d"; then printf "%s\\n" "$IVA_IMAGE" > "$MOCK_IMAGE_STATE"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q iva"; then printf "iva-container\\n"; fi\n' +
      'if [ "${1:-}" = "inspect" ]; then image=$(cat "$MOCK_IMAGE_STATE"); case "$image" in *sha-b*) printf "unhealthy\\n" ;; *) printf "healthy\\n" ;; esac; fi\n',
  );
  executable(
    join(mockBin, "curl"),
    `printf "curl args=%s\\n" "$*" >> "$MOCK_LOG"
cat >/dev/null || true
printf '{"ok":true}\\n'
`,
  );
  executable(
    join(mockBin, "flock"),
    'printf "flock %s\\n" "$*" >> "$MOCK_LOG"\n',
  );
  executable(join(mockBin, "sleep"), ":\n");

  return {
    root,
    log,
    imageState,
    env: {
      ...process.env,
      IVA_DEPLOY_TESTING: "1",
      IVA_DEPLOY_TEST_PATH: `${mockBin}:/usr/bin:/bin`,
      IVA_RUNTIME_ROOT: root,
      IVA_DEPLOY_HEALTH_ATTEMPTS: "1",
      IVA_DEPLOY_HEALTH_DELAY: "0",
      MOCK_LOG: log,
      MOCK_IMAGE_STATE: imageState,
    },
  };
}

function run(
  command: string,
  env: NodeJS.ProcessEnv,
): { status: number; stderr: string } {
  try {
    execFileSync("bash", [deployScript], {
      env: { ...env, SSH_ORIGINAL_COMMAND: command },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? -1, stderr: failure.stderr ?? "" };
  }
}

void test("forced deployment rejects commands outside the exact SHA contract", () => {
  const { env } = harness();
  for (const command of [
    "",
    "bash",
    "deploy main",
    `deploy ${goodSha}; id`,
    `deploy ${goodSha.toUpperCase()}`,
  ]) {
    const result = run(command, env);
    assert.notEqual(result.status, 0, command || "empty command");
    assert.match(result.stderr, /invalid deployment command/u);
  }
});

void test("a healthy candidate advances the current immutable image", () => {
  const { root, env, log } = harness();
  const result = run(`deploy ${goodSha}`, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, "deploy/current-image"), "utf8").trim(),
    `ghcr.io/strongf-bob/iva:sha-${goodSha}`,
  );
  assert.match(
    readFileSync(log, "utf8"),
    /curl args=--proxy socks5h:\/\/127\.0\.0\.1:7891/u,
  );
});

void test("an unhealthy candidate restores the previous healthy image", () => {
  const { root, env, log, imageState } = harness();
  const previous = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  writeFileSync(join(root, "deploy/current-image"), `${previous}\n`);
  writeFileSync(imageState, `${previous}\n`);

  const result = run(`deploy ${badSha}`, env);

  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(join(root, "deploy/current-image"), "utf8").trim(),
    previous,
  );
  assert.match(
    readFileSync(log, "utf8"),
    new RegExp(`image=${previous}.*up -d`, "u"),
  );
});
