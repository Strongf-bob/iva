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
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
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
      "TELEGRAM_BOT_ID=777\n" +
      "TELEGRAM_PROXY_URL=socks5h://10.0.2.2:7891\n",
    { mode: 0o600 },
  );

  const log = join(root, "commands.log");
  const imageState = join(root, "running-image");

  executable(
    join(mockBin, "docker"),
    'printf "docker image=%s args=%s\\n" "${IVA_IMAGE:-}" "$*" >> "$MOCK_LOG"\n' +
      'if [ "${1:-}" = "info" ]; then printf \'["name=rootless"]\\n\'; exit 0; fi\n' +
      'if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then printf "%s\\n" "${SSH_ORIGINAL_COMMAND#deploy }"; exit 0; fi\n' +
      'if [ "${1:-}" = "run" ]; then if printf "%s" "$*" | grep -q -- "--entrypoint /bin/sh"; then if printf "%s" "$*" | grep -q "reminder-scheduler"; then case "$*" in *"${MOCK_UNSUPPORTED_SCHEDULER_IMAGE:-never}"*) exit 1 ;; esac; [ "${MOCK_SCHEDULER_COMPAT:-1}" = "1" ]; else [ "${MOCK_CANDIDATE_COMPAT:-1}" = "1" ]; fi; exit; fi; last=""; for arg in "$@"; do last="$arg"; done; case "$last" in */deploy.sh) cat "$MOCK_REPO_ROOT/deploy/container/deploy.sh" ;; */compose.production.yml) cat "$MOCK_REPO_ROOT/deploy/container/compose.production.yml" ;; *) exit 1 ;; esac; exit 0; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "up -d"; then printf "%s\\n" "$IVA_IMAGE" > "$MOCK_IMAGE_STATE"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q iva"; then printf "iva-container\\n"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q telegram-poll"; then printf "poller-container\\n"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q telegram-userbot"; then printf "userbot-container\\n"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q reminder-scheduler"; then printf "scheduler-container\\n"; fi\n' +
      'last=""; for arg in "$@"; do last="$arg"; done\n' +
      'if [ "${1:-}" = "inspect" ] && [ "$last" = "poller-container" ]; then printf "%s 0\\n" "${MOCK_POLLER_STATE:-running}"; exit 0; fi\n' +
      'if [ "${1:-}" = "inspect" ] && [ "$last" = "userbot-container" ]; then printf "%s %s\\n" "${MOCK_USERBOT_STATE:-running}" "${MOCK_USERBOT_RESTARTS:-0}"; exit 0; fi\n' +
      'if [ "${1:-}" = "inspect" ] && [ "$last" = "scheduler-container" ]; then printf "%s %s\\n" "${MOCK_SCHEDULER_HEALTH:-healthy}" "${MOCK_SCHEDULER_RESTARTS:-0}"; exit 0; fi\n' +
      'if [ "${1:-}" = "exec" ] && [ "${2:-}" = "userbot-container" ]; then if [ "${MOCK_USERBOT_EXECUTE:-0}" = "1" ]; then /bin/sh -c "${5:-}"; else [ "${MOCK_USERBOT_HEALTH:-1}" = "1" ]; fi; exit; fi\n' +
      'if [ "${1:-}" = "inspect" ]; then image=$(/bin/cat "$MOCK_IMAGE_STATE"); case "$image" in *sha-b*) printf "unhealthy\\n" ;; *) printf "healthy\\n" ;; esac; fi\n',
  );
  executable(
    join(mockBin, "cat"),
    'if [ "$#" = "1" ] && [ "$1" = "/app/data/telegram-userbot.token" ]; then /bin/cat "$IVA_RUNTIME_ROOT/data/telegram-userbot.token"; else /bin/cat "$@"; fi\n',
  );
  executable(
    join(mockBin, "curl"),
    `printf "curl args=%s\\n" "$*" >> "$MOCK_LOG"
cat >/dev/null || true
if printf "%s" "$*" | grep -q "127.0.0.1:8724/healthz"; then
  [ "\${MOCK_USERBOT_HEALTH:-1}" = "1" ]
  exit
fi
printf '{"ok":true,"result":{"id":777}}\\n'
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
      IVA_DEPLOY_SKIP_BUNDLE: "1",
      IVA_DEPLOY_TEST_PATH: `${mockBin}:/usr/bin:/bin`,
      IVA_RUNTIME_ROOT: root,
      IVA_DEPLOY_HEALTH_ATTEMPTS: "1",
      IVA_DEPLOY_HEALTH_DELAY: "0",
      IVA_DEPLOY_POLLER_SETTLE_DELAY: "0",
      MOCK_LOG: log,
      MOCK_IMAGE_STATE: imageState,
      MOCK_REPO_ROOT: repoRoot,
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

void test("the forced command activates deployment assets from the verified image", () => {
  const { root, env, log } = harness();
  const bundleEnv = { ...env };
  delete bundleEnv.IVA_DEPLOY_SKIP_BUNDLE;

  const result = run(`deploy ${goodSha}`, bundleEnv);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, "compose.yml"), "utf8"),
    readFileSync(
      join(repoRoot, "deploy/container/compose.production.yml"),
      "utf8",
    ),
  );
  assert.match(readFileSync(log, "utf8"), /image inspect/u);
  assert.match(
    readFileSync(log, "utf8"),
    /\/app\/deploy\/container\/deploy\.sh/u,
  );
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
  assert.match(readFileSync(log, "utf8"), /ps -q telegram-poll/u);
  assert.match(readFileSync(log, "utf8"), /ps -q telegram-userbot/u);
  assert.match(readFileSync(log, "utf8"), /ps -q reminder-scheduler/u);
  assert.match(
    readFileSync(log, "utf8"),
    /up -d --remove-orphans iva telegram-poll telegram-userbot reminder-scheduler/u,
  );
});

void test("a candidate without the scheduler runtime is rejected", () => {
  const { env } = harness();
  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_SCHEDULER_COMPAT: "0",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate image lacks the reminder scheduler/u);
});

void test("a candidate without the real supervisor cannot pass via the inert fallback", () => {
  const { env } = harness();
  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_CANDIDATE_COMPAT: "0",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate image lacks the userbot runtime/u);
});

void test("a valid token for the wrong Telegram bot fails deployment", () => {
  const { root, env } = harness();
  writeFileSync(
    join(root, ".env"),
    "TELEGRAM_BOT_TOKEN=123456:test-token\n" +
      "TELEGRAM_BOT_ID=999\n" +
      "TELEGRAM_PROXY_URL=socks5h://10.0.2.2:7891\n",
    { mode: 0o600 },
  );

  const result = run(`deploy ${goodSha}`, env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate failed health checks/u);
});

void test("a stopped Telegram poller fails deployment", () => {
  const { env } = harness();
  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_POLLER_STATE: "exited",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate failed health checks/u);
});

void test("a stopped or restarted userbot supervisor fails deployment", () => {
  for (const override of [
    { MOCK_USERBOT_STATE: "exited" },
    { MOCK_USERBOT_RESTARTS: "1" },
  ]) {
    const { env } = harness();
    const result = run(`deploy ${goodSha}`, { ...env, ...override });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /candidate failed health checks/u);
  }
});

void test("an unhealthy or restarted reminder scheduler fails deployment", () => {
  for (const override of [
    { MOCK_SCHEDULER_HEALTH: "unhealthy" },
    { MOCK_SCHEDULER_RESTARTS: "1" },
  ]) {
    const { env } = harness();
    const result = run(`deploy ${goodSha}`, { ...env, ...override });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /candidate failed health checks/u);
  }
});

void test("an enabled userbot must pass its authenticated child health check", () => {
  const { root, env, log } = harness();
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data/telegram-userbot.enabled"), "enabled\n");
  writeFileSync(join(root, "data/telegram-userbot.token"), "a".repeat(64));

  const healthy = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_USERBOT_EXECUTE: "1",
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(
    readFileSync(log, "utf8"),
    /exec userbot-container \/bin\/sh -c/u,
  );
  assert.match(
    readFileSync(log, "utf8"),
    /^curl args=.*127\.0\.0\.1:8724\/healthz$/mu,
  );

  const unhealthy = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_USERBOT_EXECUTE: "1",
    MOCK_USERBOT_HEALTH: "0",
  });
  assert.notEqual(unhealthy.status, 0);
  assert.match(unhealthy.stderr, /candidate failed health checks/u);
});

void test("the userbot health probe rejects curl-config injection in its token", () => {
  const { root, env, log } = harness();
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data/telegram-userbot.enabled"), "enabled\n");
  writeFileSync(
    join(root, "data/telegram-userbot.token"),
    `${"a".repeat(40)}\nurl = "file:///etc/passwd"\nupload-file = "/etc/passwd"`,
  );

  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_USERBOT_EXECUTE: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate failed health checks/u);
  assert.doesNotMatch(
    readFileSync(log, "utf8"),
    /^curl args=.*127\.0\.0\.1:8724\/healthz$/mu,
  );
});

void test("rollback never claims restoration when the enabled userbot stays unhealthy", () => {
  const { root, env, imageState } = harness();
  const previous = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data/telegram-userbot.enabled"), "enabled\n");
  writeFileSync(join(root, "data/telegram-userbot.token"), "a".repeat(64));
  writeFileSync(join(root, "deploy/current-image"), `${previous}\n`);
  writeFileSync(imageState, `${previous}\n`);

  const result = run(`deploy ${badSha}`, {
    ...env,
    MOCK_USERBOT_HEALTH: "0",
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /previous image restored/u);
  assert.match(result.stderr, /candidate and rollback image are unhealthy/u);
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

void test("rollback restores an older image without scheduler support", () => {
  const { root, env, log, imageState } = harness();
  const previous = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  writeFileSync(join(root, "deploy/current-image"), `${previous}\n`);
  writeFileSync(imageState, `${previous}\n`);

  const result = run(`deploy ${badSha}`, {
    ...env,
    MOCK_UNSUPPORTED_SCHEDULER_IMAGE: previous,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous image restored/u);
  assert.match(
    readFileSync(log, "utf8"),
    /compose.*rm -sf reminder-scheduler/u,
  );
  assert.match(
    readFileSync(log, "utf8"),
    new RegExp(
      `image=${previous}.*up -d --remove-orphans iva telegram-poll telegram-userbot(?:\\n|$)`,
      "u",
    ),
  );
});
