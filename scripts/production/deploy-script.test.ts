import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
    'printf "docker image=%s legacy=%s args=%s\\n" "${IVA_IMAGE:-}" "${IVA_CONTAINER_WORKERS_ALLOW_LEGACY:-}" "$*" >> "$MOCK_LOG"\n' +
      'if [ "${1:-}" = "info" ]; then printf "%s\\n" "${MOCK_DOCKER_INFO_STDERR:-}" >&2; printf \'["name=rootless"]\\n\'; exit 0; fi\n' +
      'if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then printf "%s\\n" "${SSH_ORIGINAL_COMMAND#deploy }"; exit 0; fi\n' +
      'if [ "${1:-}" = "run" ]; then if printf "%s" "$*" | grep -q -- "--entrypoint /bin/sh"; then if printf "%s" "$*" | grep -q "routing-health.ts"; then case "$*" in *"${MOCK_INCOMPATIBLE_ROUTING_IMAGE:-__none__}"*) exit 1 ;; *) exit 0 ;; esac; fi; if printf "%s" "$*" | grep -q "reminder-scheduler"; then case "$*" in *"${MOCK_UNSUPPORTED_SCHEDULER_IMAGE:-never}"*) exit 1 ;; esac; [ "${MOCK_SCHEDULER_COMPAT:-1}" = "1" ]; exit; fi; if printf "%s" "$*" | grep -q "container-runtime.ts"; then case "$*" in *"${MOCK_UNSUPPORTED_CONTAINER_IMAGE:-never}"*) exit 1 ;; esac; [ "${MOCK_CONTAINER_COMPAT:-1}" = "1" ]; exit; fi; [ "${MOCK_CANDIDATE_COMPAT:-1}" = "1" ]; exit; fi; if printf "%s" "$*" | grep -q "users.every"; then [ "${MOCK_ROUTABLE_USERS:-0}" = "0" ]; exit; fi; last=""; for arg in "$@"; do last="$arg"; done; case "$last" in */deploy.sh) cat "$MOCK_REPO_ROOT/deploy/container/deploy.sh" ;; */compose.production.yml) cat "$MOCK_REPO_ROOT/deploy/container/compose.production.yml" ;; *) exit 1 ;; esac; exit 0; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "contact-backfill-operator.ts"; then if printf "%s" "$*" | grep -q "dry-run"; then printf "%s\\n" "$MOCK_DRY_RUN_OUTPUT"; else printf "%s\\n" "$MOCK_OPERATOR_OUTPUT"; fi; printf "%s\\n" "${MOCK_OPERATOR_STDERR:-}" >&2; [ "${MOCK_OPERATOR_SUCCESS:-1}" = "1" ]; exit; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "contact-backfill-output-validator"; then "$MOCK_NODE" "$MOCK_REPO_ROOT/scripts/production/contact-backfill-output-validator.ts"; exit; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "up -d"; then printf "%s\\n" "$IVA_IMAGE" > "$MOCK_IMAGE_STATE"; if [ "${MOCK_CREATE_ROUTE:-0}" = "1" ] && printf "%s" "$*" | grep -q "telegram-poll"; then mkdir -p "$IVA_RUNTIME_ROOT/data/control"; printf "candidate route\\n" > "$IVA_RUNTIME_ROOT/data/control/legacy-owner-route.json"; fi; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q iva"; then printf "iva-container\\n"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q telegram-poll"; then printf "poller-container\\n"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q telegram-userbot"; then printf "userbot-container\\n"; fi\n' +
      'if [ "${1:-}" = "compose" ] && printf "%s" "$*" | grep -q "ps -q reminder-scheduler"; then printf "scheduler-container\\n"; fi\n' +
      'last=""; for arg in "$@"; do last="$arg"; done\n' +
      'if [ "${1:-}" = "inspect" ] && [ "$last" = "poller-container" ]; then printf "%s 0\\n" "${MOCK_POLLER_STATE:-running}"; exit 0; fi\n' +
      'if [ "${1:-}" = "inspect" ] && [ "$last" = "userbot-container" ]; then printf "%s %s\\n" "${MOCK_USERBOT_STATE:-running}" "${MOCK_USERBOT_RESTARTS:-0}"; exit 0; fi\n' +
      'if [ "${1:-}" = "exec" ] && [ "${2:-}" = "poller-container" ]; then if printf "%s" "$*" | grep -q "container-runtime.ts status --require-pristine"; then [ "${MOCK_CONTAINER_READY:-1}" = "1" ]; else [ "${MOCK_ROUTING_HEALTH:-1}" = "1" ]; fi; exit; fi\n' +
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
    'printf "flock %s\\n" "$*" >> "$MOCK_LOG"\n[ "${MOCK_FLOCK_SUCCESS:-1}" = "1" ]\n',
  );
  executable(join(mockBin, "sleep"), ":\n");
  executable(
    join(mockBin, "cp"),
    'target=""\nfor arg in "$@"; do target="$arg"; done\ncase "$target" in *deploy.sh.tmp.*) [ "${MOCK_DEPLOY_COPY_SUCCESS:-1}" = "1" ] || exit 1 ;; esac\n/bin/cp "$@"\n',
  );
  executable(
    join(mockBin, "mv"),
    'target=""\nfor arg in "$@"; do target="$arg"; done\nif [ -n "${MOCK_FAIL_MV_TARGET:-}" ] && [ "$(basename "$target")" = "$MOCK_FAIL_MV_TARGET" ] && [ ! -f "$IVA_RUNTIME_ROOT/mv-failure-used" ]; then touch "$IVA_RUNTIME_ROOT/mv-failure-used"; exit 1; fi\n/bin/mv "$@"\n',
  );

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
      MOCK_NODE: process.execPath,
      MOCK_OPERATOR_OUTPUT:
        '{"schema":"iva-contact-backfill-operator/v1","runId":"run-a","phase":"complete","backupReady":true,"backupVerified":true,"inventoryComplete":true,"incrementalHandoffComplete":true,"privateChats":1,"completedChats":1,"pendingChats":0,"failedChats":0,"processedMessages":1,"skippedMessages":0,"pendingBatches":0,"highWaterReachedChats":1,"errorCodes":[]}',
      MOCK_DRY_RUN_OUTPUT:
        '{"schema":"iva-contact-backfill-dry-run/v1","privateChats":1,"completedChats":0,"failedChats":0,"processedMessages":0,"skippedMessages":0}',
    },
  };
}

function run(
  command: string,
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [deployScript], {
    env: { ...env, SSH_ORIGINAL_COMMAND: command },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

void test("forced deployment exposes only bounded contact backfill operations", () => {
  const { env, log } = harness();
  assert.equal(run(`deploy ${goodSha}`, env).status, 0);
  const runId = "run-20260811-a1";
  for (const command of [
    "contact-backfill dry-run",
    `contact-backfill apply ${runId}`,
    `contact-backfill status ${runId}`,
    `contact-backfill rollback ${runId}`,
  ]) {
    const result = run(command, env);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  for (const command of [
    "contact-backfill",
    "contact-backfill shell",
    "contact-backfill dry-run extra",
    "contact-backfill apply ../escape",
    "contact-backfill status UPPERCASE",
    `contact-backfill rollback ${runId}; id`,
  ]) {
    const result = run(command, env);
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /invalid deployment command/u);
  }
  assert.match(readFileSync(log, "utf8"), /contact-backfill-operator\.ts/u);
});

void test("mutating backfill operations share the deployment lock while status stays observable", () => {
  const { env } = harness();
  assert.equal(run(`deploy ${goodSha}`, env).status, 0);
  const blocked = { ...env, MOCK_FLOCK_SUCCESS: "0" };
  for (const action of ["dry-run", "apply run-a", "rollback run-a"]) {
    const result = run(`contact-backfill ${action}`, blocked);
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /another deployment or backfill is running/u);
  }
  assert.equal(run("contact-backfill status run-a", blocked).status, 0);
});

void test("contact backfill returns only validated aggregate JSON", () => {
  const { env } = harness();
  assert.equal(run(`deploy ${goodSha}`, env).status, 0);

  const success = run("contact-backfill status run-a", {
    ...env,
    MOCK_DOCKER_INFO_STDERR: "/run/user/1000/docker.sock",
    MOCK_OPERATOR_STDERR: "/home/strongf/private docker warning",
  });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), {
    schema: "iva-contact-backfill-operator/v1",
    runId: "run-a",
    phase: "complete",
    backupReady: true,
    backupVerified: true,
    inventoryComplete: true,
    incrementalHandoffComplete: true,
    privateChats: 1,
    completedChats: 1,
    pendingChats: 0,
    failedChats: 0,
    processedMessages: 1,
    skippedMessages: 0,
    pendingBatches: 0,
    highWaterReachedChats: 1,
    errorCodes: [],
  });
  assert.doesNotMatch(success.stdout, /home\/strongf|private docker warning/u);
  assert.equal(success.stderr, "");

  const dryRun = run("contact-backfill dry-run", env);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.deepEqual(JSON.parse(dryRun.stdout), {
    schema: "iva-contact-backfill-dry-run/v1",
    privateChats: 1,
    completedChats: 0,
    failedChats: 0,
    processedMessages: 0,
    skippedMessages: 0,
  });

  for (const failureEnv of [
    { MOCK_OPERATOR_SUCCESS: "0", MOCK_OPERATOR_STDERR: "/srv/secret.sock" },
    { MOCK_OPERATOR_OUTPUT: '{"schema":"wrong","serverPath":"/srv/private"}' },
  ]) {
    const failure = run("contact-backfill status run-a", {
      ...env,
      ...failureEnv,
    });
    assert.notEqual(failure.status, 0);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /contact backfill operation failed/u);
    assert.doesNotMatch(failure.stderr, /srv|secret|private|sock/u);
  }

  const codedFailure = run("contact-backfill status run-a", {
    ...env,
    MOCK_OPERATOR_SUCCESS: "0",
    MOCK_OPERATOR_STDERR:
      "/srv/secret.sock\ncontact_backfill_operator_owner_unavailable",
  });
  assert.notEqual(codedFailure.status, 0);
  assert.equal(codedFailure.stdout, "");
  assert.match(
    codedFailure.stderr,
    /contact backfill operation failed: contact_backfill_operator_owner_unavailable/u,
  );
  assert.doesNotMatch(codedFailure.stderr, /srv|secret|sock/u);

  for (const hostileCode of [
    "contact_backfill_998877665544",
    "telegram_private_backfill_phone_79991234567",
    `contact_backfill_${"a".repeat(512)}`,
  ]) {
    const rejected = run("contact-backfill status run-a", {
      ...env,
      MOCK_OPERATOR_SUCCESS: "0",
      MOCK_OPERATOR_STDERR: hostileCode,
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, "deploy: contact backfill operation failed\n");
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
  assert.equal(
    readFileSync(join(root, "deploy/deploy.sh"), "utf8"),
    readFileSync(join(repoRoot, "deploy/container/deploy.sh"), "utf8"),
  );
});

void test("entrypoint staging failure leaves release state unpromoted", () => {
  const { root, env, imageState } = harness();
  const oldImage = `ghcr.io/strongf-bob/iva:sha-${"c".repeat(40)}`;
  writeFileSync(join(root, "deploy/current-image"), `${oldImage}\n`);
  writeFileSync(join(root, "deploy/deploy.sh"), "old entrypoint\n");
  writeFileSync(join(root, "compose.yml"), "name: old\n");
  writeFileSync(imageState, `${oldImage}\n`);

  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_DEPLOY_COPY_SUCCESS: "0",
  });

  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(join(root, "deploy/current-image"), "utf8").trim(),
    oldImage,
  );
  assert.equal(
    readFileSync(join(root, "deploy/deploy.sh"), "utf8"),
    "old entrypoint\n",
  );
  assert.equal(readFileSync(join(root, "compose.yml"), "utf8"), "name: old\n");
  assert.equal(readFileSync(imageState, "utf8").trim(), oldImage);
});

void test("every release promotion failure restores controls, state, and runtime", () => {
  for (const target of [
    "deploy.sh",
    "compose.yml",
    "previous-image",
    "current-image",
  ]) {
    const { root, env, imageState } = harness();
    const oldImage = `ghcr.io/strongf-bob/iva:sha-${"c".repeat(40)}`;
    const olderImage = `ghcr.io/strongf-bob/iva:sha-${"d".repeat(40)}`;
    writeFileSync(join(root, "deploy/current-image"), `${oldImage}\n`);
    writeFileSync(join(root, "deploy/previous-image"), `${olderImage}\n`);
    writeFileSync(join(root, "deploy/deploy.sh"), "old entrypoint\n");
    writeFileSync(join(root, "compose.yml"), "name: old\n");
    const candidateCompose = join(root, "candidate-compose.yml");
    writeFileSync(candidateCompose, "name: candidate\n");
    writeFileSync(imageState, `${oldImage}\n`);

    const result = run(`deploy ${goodSha}`, {
      ...env,
      MOCK_FAIL_MV_TARGET: target,
      IVA_RELEASE_COMPOSE_FILE: candidateCompose,
    });

    assert.notEqual(result.status, 0, target);
    assert.match(result.stderr, /previous release restored/u, target);
    assert.equal(
      readFileSync(join(root, "deploy/current-image"), "utf8").trim(),
      oldImage,
      target,
    );
    assert.equal(
      readFileSync(join(root, "deploy/previous-image"), "utf8").trim(),
      olderImage,
      target,
    );
    assert.equal(
      readFileSync(join(root, "deploy/deploy.sh"), "utf8"),
      "old entrypoint\n",
      target,
    );
    assert.equal(
      readFileSync(join(root, "compose.yml"), "utf8"),
      "name: old\n",
      target,
    );
    assert.equal(readFileSync(imageState, "utf8").trim(), oldImage, target);
  }
});

void test("same-image promotion failure does not stop the healthy poller", () => {
  const { root, env, imageState, log } = harness();
  const candidateImage = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  writeFileSync(join(root, "deploy/current-image"), `${candidateImage}\n`);
  writeFileSync(join(root, "deploy/deploy.sh"), "old entrypoint\n");
  writeFileSync(join(root, "compose.yml"), "name: old\n");
  writeFileSync(imageState, `${candidateImage}\n`);

  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_FAIL_MV_TARGET: "current-image",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous release restored/u);
  assert.equal(readFileSync(imageState, "utf8").trim(), candidateImage);
  assert.doesNotMatch(readFileSync(log, "utf8"), /stop telegram-poll/u);
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

void test("a candidate without the container worker runtime is rejected", () => {
  const { env } = harness();
  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_CONTAINER_COMPAT: "0",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /candidate image lacks the container worker runtime/u,
  );
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

void test("an unusable Telegram owner route fails deployment", () => {
  const { env } = harness();
  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_ROUTING_HEALTH: "0",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate failed health checks/u);
});

void test("a degraded container worker supervisor fails deployment", () => {
  const { env } = harness();
  const result = run(`deploy ${goodSha}`, {
    ...env,
    MOCK_CONTAINER_READY: "0",
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

void test("an incompatible rollback keeps polling stopped and removes a candidate-created route", () => {
  const { root, env, log, imageState } = harness();
  const previous = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  writeFileSync(join(root, "deploy/current-image"), `${previous}\n`);
  writeFileSync(imageState, `${previous}\n`);

  const result = run(`deploy ${badSha}`, {
    ...env,
    MOCK_CREATE_ROUTE: "1",
    MOCK_INCOMPATIBLE_ROUTING_IMAGE: previous,
  });

  assert.notEqual(result.status, 0);
  assert.equal(
    existsSync(join(root, "data/control/legacy-owner-route.json")),
    false,
  );
  assert.match(readFileSync(log, "utf8"), /stop telegram-poll/u);
  assert.doesNotMatch(result.stderr, /previous image restored/u);
  assert.match(result.stderr, /polling remains stopped/u);
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

void test("rollback refuses an image without container workers once routable users exist", () => {
  const { root, env, log, imageState } = harness();
  const previous = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  mkdirSync(join(root, "data", "control"), { recursive: true });
  writeFileSync(
    join(root, "data", "control", "users.json"),
    '{"schema":"iva-users/v1","revision":1,"users":[{"status":"active"}]}\n',
  );
  writeFileSync(join(root, "deploy/current-image"), `${previous}\n`);
  writeFileSync(imageState, `${previous}\n`);

  const result = run(`deploy ${badSha}`, {
    ...env,
    MOCK_ROUTABLE_USERS: "1",
    MOCK_UNSUPPORTED_CONTAINER_IMAGE: previous,
  });

  assert.notEqual(result.status, 0);
  assert.match(readFileSync(log, "utf8"), /stop telegram-poll/u);
  assert.doesNotMatch(result.stderr, /previous image restored/u);
  assert.match(result.stderr, /previous image lacks container worker support/u);
});

void test("rollback uses the legacy poller only while the registry has no routable users", () => {
  const { root, env, log, imageState } = harness();
  const previous = `ghcr.io/strongf-bob/iva:sha-${goodSha}`;
  writeFileSync(join(root, "deploy/current-image"), `${previous}\n`);
  writeFileSync(imageState, `${previous}\n`);

  const result = run(`deploy ${badSha}`, {
    ...env,
    MOCK_UNSUPPORTED_CONTAINER_IMAGE: previous,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous image restored/u);
  assert.match(
    readFileSync(log, "utf8"),
    new RegExp(`image=${previous} legacy=1 .*up -d`, "u"),
  );
});
