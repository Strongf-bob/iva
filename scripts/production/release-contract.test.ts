import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assertIgnored(".gitignore", ".env");
  assertIgnored(".gitignore", ".env.*");
  assertIgnored(".gitignore", "data");
  assertIgnored(".gitignore", "/vault/");
  assertIgnored(".gitignore", "/memory/");
  assertIgnored(".gitignore", "/iva-runtime/");

  for (const entry of [
    ".git",
    ".env",
    ".eve",
    ".output",
    ".iva-build",
    ".iva-update",
    "dist",
    "data",
    "memory",
    "vault",
  ]) {
    assertIgnored(".dockerignore", entry);
  }
});

void test("the production image uses Node 24 and a non-root runtime user", () => {
  const containerfile = read("Containerfile");
  assert.match(containerfile, /^FROM node:24-trixie-slim AS deps$/mu);
  assert.match(containerfile, /^FROM deps AS runtime$/mu);
  assert.match(
    containerfile,
    /^LABEL org\.opencontainers\.image\.source="https:\/\/github\.com\/Strongf-bob\/iva"$/mu,
  );
  assert.match(
    containerfile,
    /uv venv --python python3 \/opt\/iva-userbot-venv/u,
  );
  assert.match(
    containerfile,
    /uv pip sync --python \/opt\/iva-userbot-venv\/bin\/python[\s\\]*--require-hashes[\s\\]*--strict[\s\\]*services\/telegram-userbot\/requirements\.lock/u,
  );
  assert.match(
    containerfile,
    /COPY --from=build \/opt\/iva-userbot-venv \/opt\/iva-userbot-venv/u,
  );
  assert.match(containerfile, /^USER node$/mu);
});

void test("production Compose requires an immutable image and narrow mounts", () => {
  const compose = read("deploy/container/compose.production.yml");
  assert.equal(
    compose.match(/image: \$\{IVA_IMAGE:\?IVA_IMAGE is required\}/gu)?.length,
    4,
  );
  assert.match(compose, /127\.0\.0\.1:8723:8723/u);
  assert.match(compose, /\/eve\/v1\/health/u);
  assert.match(compose, /condition: service_healthy/u);
  assert.equal(compose.match(/restart: unless-stopped/gu)?.length, 4);
  assert.equal(compose.match(/^\s+user: "0:0"$/gmu)?.length, 4);
  assert.equal(compose.match(/^\s+pids_limit: 512$/gmu)?.length, 2);
  assert.equal(compose.match(/^\s+mem_limit: 4g$/gmu)?.length, 2);
  assert.equal(compose.match(/^\s+cpus: "2\.0"$/gmu)?.length, 2);
  assert.equal(compose.match(/max-size: "10m"/gu)?.length, 4);
  assert.equal(compose.match(/max-file: "3"/gu)?.length, 4);
  assert.equal(
    compose.match(
      /\/app\/node_modules\/\.cache\/eve:rw,noexec,nosuid,nodev,mode=0700/gu,
    )?.length,
    2,
  );
  for (const mount of [
    "./memory:/app/memory",
    "./vault:/app/vault",
    "./.eve:/app/.eve",
  ]) {
    assert.equal(
      compose.split(mount).length - 1,
      2,
      `${mount} must be mounted twice`,
    );
  }
  assert.equal(compose.split("./.env:/app/.env:ro").length - 1, 3);
  assert.equal(compose.split("./data:/app/data\n").length - 1, 3);
  assert.equal(compose.split("./data:/app/data:ro").length - 1, 1);
  assert.equal(
    compose.match(
      /telegram-userbot-onboarding-auth:\/app\/userbot-onboarding-auth/gu,
    )?.length,
    2,
  );
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.doesNotMatch(compose, /^\s*-\s*["']?8723:8723/mu);

  const userbotStart = compose.indexOf(
    "\n  telegram-userbot:\n    image: ${IVA_IMAGE:?IVA_IMAGE is required}",
  );
  const networksStart = compose.indexOf("\nnetworks:", userbotStart);
  assert.notEqual(userbotStart, -1);
  assert.notEqual(networksStart, -1);
  const userbot = compose.slice(userbotStart, networksStart);
  const iva = compose.slice(
    compose.indexOf("\n  iva:\n"),
    compose.indexOf("\n  telegram-poll:\n"),
  );
  const poll = compose.slice(
    compose.indexOf("\n  telegram-poll:\n"),
    userbotStart,
  );
  assert.match(poll, /IVA_CONTAINER_RUNTIME: "1"/u);
  assert.match(poll, /ASSISTANT_APP_DIR: \/app/u);
  assert.match(poll, /ASSISTANT_DATA_DIR: \/app\/data/u);
  assert.match(
    poll,
    /exec node --env-file=\.env scripts\/container-runtime\.ts run/u,
  );
  assert.match(
    poll,
    /node[\s\S]*scripts\/container-runtime\.ts[\s\S]*status[\s\S]*--require-ready/u,
  );
  assert.doesNotMatch(iva, /TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE/u);
  assert.doesNotMatch(iva, /telegram-userbot-onboarding-auth/u);
  assert.match(
    poll,
    /TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE: \/app\/userbot-onboarding-auth\/token/u,
  );
  assert.match(
    poll,
    /telegram-userbot-onboarding-auth:\/app\/userbot-onboarding-auth:ro/u,
  );
  assert.match(userbot, /TELEGRAM_EXPOSED_TOOLS: "read-only"/u);
  assert.match(userbot, /if \[ -x \/opt\/iva-userbot-venv\/bin\/python \]/u);
  assert.match(userbot, /exec sleep infinity/u);
  assert.match(userbot, /TELEGRAM_USERBOT_ALLOW_INERT/u);
  assert.match(userbot, /TELEGRAM_MCP_HOST: "0\.0\.0\.0"/u);
  assert.match(
    userbot,
    /TELEGRAM_PROXY_TYPE: \$\{TELEGRAM_USERBOT_PROXY_TYPE:-\}/u,
  );
  assert.match(
    userbot,
    /TELEGRAM_PROXY_HOST: \$\{TELEGRAM_USERBOT_PROXY_HOST:-\}/u,
  );
  assert.match(
    userbot,
    /TELEGRAM_PROXY_PORT: \$\{TELEGRAM_USERBOT_PROXY_PORT:-\}/u,
  );
  assert.match(
    userbot,
    /TELEGRAM_PROXY_RDNS: \$\{TELEGRAM_USERBOT_PROXY_RDNS:-true\}/u,
  );
  assert.doesNotMatch(userbot, /TELEGRAM_USERBOT_BOT_API_PROXY/u);
  assert.doesNotMatch(userbot, /TELEGRAM_BOT_TOKEN/u);
  assert.doesNotMatch(userbot, /TELEGRAM_ALLOWED_USER_IDS/u);
  assert.match(
    userbot,
    /TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE: \/app\/userbot-onboarding-auth\/token/u,
  );
  assert.match(
    userbot,
    /telegram-userbot-onboarding-auth:\/app\/userbot-onboarding-auth(?!:ro)/u,
  );
  assert.match(userbot, /\.\/data:\/app\/data:ro/u);
  assert.match(userbot, /telegram-userbot-state:\/app\/userbot-state/u);
  assert.match(userbot, /cap_drop:\s*\n\s*- ALL/u);
  assert.match(userbot, /no-new-privileges:true/u);
  assert.match(userbot, /pids_limit: 128/u);
  assert.match(userbot, /mem_limit: 768m/u);
  assert.match(userbot, /cpus: "0\.5"/u);
  assert.doesNotMatch(userbot, /\n\s+ports:/u);
  assert.doesNotMatch(userbot, /\.\/\.env:\/app\/\.env/u);
  assert.doesNotMatch(userbot, /\.\/memory:|\.\/vault:|\.\/\.eve:/u);
  assert.equal(
    compose.match(/telegram-userbot-state:\/app\/userbot-state/gu)?.length,
    1,
  );
  assert.match(
    compose,
    /^volumes:\s*\n\s+telegram-userbot-state:\s*\n\s+telegram-userbot-onboarding-auth:$/mu,
  );
  assert.equal(
    compose.match(/TELEGRAM_USERBOT_RUNTIME: "container"/gu)?.length,
    2,
  );
  assert.equal(
    compose.match(/TELEGRAM_MCP_URL: http:\/\/telegram-userbot:8724\/mcp/gu)
      ?.length,
    2,
  );
  assert.equal(
    compose.match(
      /NO_PROXY: \$\{NO_PROXY:-iva,127\.0\.0\.1,localhost\},telegram-userbot/gu,
    )?.length,
    2,
  );

  const runtime = read("deploy/container/runtime.env.example");
  assert.match(runtime, /^TELEGRAM_USERBOT_PROXY_TYPE=$/mu);
  assert.match(runtime, /^TELEGRAM_USERBOT_PROXY_HOST=$/mu);
  assert.match(runtime, /^TELEGRAM_USERBOT_PROXY_PORT=$/mu);
  assert.match(runtime, /^TELEGRAM_USERBOT_PROXY_RDNS=true$/mu);
  assert.doesNotMatch(runtime, /^TELEGRAM_USERBOT_BOT_API_PROXY=/mu);

  const requirements = read("services/telegram-userbot/requirements.in");
  const lock = read("services/telegram-userbot/requirements.lock");
  assert.match(requirements, /^python-socks>=2\.7,<3$/mu);
  assert.match(lock, /^python-socks==/mu);

  const deployScript = read("deploy/container/deploy.sh");
  assert.match(deployScript, /docker info.*SecurityOptions/u);
  assert.match(deployScript, /rootless/u);
  assert.match(deployScript, /ps -q telegram-userbot/u);
  assert.match(deployScript, /telegram-userbot.*running 0/su);
  assert.match(
    deployScript,
    /docker exec "\$poller_id" node scripts\/production\/routing-health\.ts/u,
  );
  assert.match(deployScript, /userbot_session_ok/u);
  assert.match(deployScript, /cat \/app\/data\/telegram-userbot\.token/u);
  assert.match(
    deployScript,
    /Authorization: Bearer %s.*127\.0\.0\.1:8724\/healthz/su,
  );
  assert.match(deployScript, /org\.opencontainers\.image\.revision/u);
  assert.match(
    deployScript,
    /\/app\/deploy\/container\/compose\.production\.yml/u,
  );
  assert.match(deployScript, /IVA_DEPLOY_RELEASE_BUNDLE/u);
  assert.match(deployScript, /image_supports_userbot/u);
  assert.match(deployScript, /image_supports_container_workers/u);
  assert.match(
    deployScript,
    /docker exec "\$poller_id" node scripts\/container-runtime\.ts status --require-pristine/u,
  );
  assert.match(deployScript, /legacy_rollback_is_safe/u);
  assert.match(deployScript, /TELEGRAM_USERBOT_ALLOW_INERT/u);
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
  assert.match(workflow, /ssh-keyscan .*?-t ed25519/u);
  assert.match(
    workflow,
    /SHA256:gywKmHI7oSa5ZlF3idnKjKoWsB\+UpR4OgikvzbTooRI/u,
  );
  assert.match(workflow, /ssh-keygen -lf/u);
  assert.doesNotMatch(workflow, /DEPLOY_KNOWN_HOSTS/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);

  const ciWorkflow = read(".github/workflows/ci.yml");
  assert.match(ciWorkflow, /Validate production Compose/u);
  assert.match(ciWorkflow, /IVA_ENV_FILE=runtime\.env\.example/u);
  assert.match(ciWorkflow, /docker compose/u);
  assert.match(ciWorkflow, /-f deploy\/container\/compose\.production\.yml/u);
  assert.match(ciWorkflow, /config --quiet/u);
  assert.match(
    read("deploy/container/runtime.env.example"),
    /^TELEGRAM_BOT_ID=$/mu,
  );

  for (const line of workflow.split("\n")) {
    if (!line.trimStart().startsWith("uses:")) continue;
    assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/u);
  }
});

void test("production routes text through DeepSeek Flash and images through Qwen", () => {
  const runtime = read("deploy/container/runtime.env.example");
  assert.match(runtime, /^MODEL_PROVIDER=opencode$/mu);
  assert.match(runtime, /^OPENCODE_API_KEY=$/mu);
  assert.match(runtime, /^OPENCODE_MODEL=deepseek-v4-flash$/mu);
  assert.match(runtime, /^OPENCODE_CONTEXT_WINDOW=131072$/mu);
  assert.match(runtime, /^THINKING_EFFORT=medium$/mu);

  const provider = read("agent/provider.ts");
  assert.match(provider, /visionModel: "qwen3\.7-plus"/u);
  assert.match(provider, /process\.env\.OPENCODE_MODEL/u);

  const providerUrl = new URL("../../agent/provider.ts", import.meta.url).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const m = await import(${JSON.stringify(providerUrl)}); console.log(JSON.stringify({ providerName: m.providerName, providerConfig: m.providerConfig, thinkingEffort: m.thinkingEffort, compatibleThinkingEffort: m.compatibleThinkingEffort }));`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_PROVIDER: "opencode",
        OPENCODE_API_KEY: "test-only-key",
        OPENCODE_MODEL: "deepseek-v4-flash",
        OPENCODE_CONTEXT_WINDOW: "131072",
        THINKING_EFFORT: "medium",
      },
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    providerName: "opencode",
    providerConfig: {
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKey: "test-only-key",
      textModel: "deepseek-v4-flash",
      contextWindow: 131072,
      visionModel: "qwen3.7-plus",
    },
    thinkingEffort: "medium",
    compatibleThinkingEffort: "medium",
  });

  const vision = read("agent/vision.ts");
  assert.match(vision, /Опиши изображение детально/u);
  assert.match(vision, /max_tokens: 700/u);
});
