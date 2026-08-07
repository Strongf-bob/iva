# Containerized Read-only Telegram Userbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production owner-only Telegram onboarding flow start a containerized personal-account proxy whose effective Telegram capabilities are permanently read-only.

**Architecture:** Add a hardened internal Compose sidecar supervised by a small Python process. IVA writes private credential, bearer-token, and enable-marker files into its existing untracked data directory; the sidecar mounts that directory read-only and owns the Telethon session in a separate volume. Container mode uses marker lifecycle and an internal MCP URL, while legacy host installations keep their systemd path.

**Tech Stack:** TypeScript ESM, Node.js test runner, Python 3, Telethon/telegram-mcp, Docker/Compose, Bash deployment scripts.

## Global Constraints

- `TELEGRAM_EXPOSED_TOOLS=read-only` is fixed in production Compose and cannot be overridden by `.env`.
- TCP port `8724` is never published to the host.
- The Telethon session is mounted only into `telegram-userbot`, never into `iva` or `telegram-poll`.
- Secrets remain in untracked runtime files with mode `0600` and are never printed, committed, or copied into fixtures.
- Container mode never writes `/app/.env` and never invokes systemd or creates a runtime virtualenv.
- Legacy host/systemd behavior remains backward-compatible.
- Production security tests are bounded and non-destructive; no active red-team or Telegram write operation is authorized.

---

### Task 1: Private container runtime state

**Files:**

- Create: `scripts/lib/userbot-container-runtime.ts`
- Test: `scripts/lib/userbot-container-runtime.test.ts`

**Interfaces:**

- Produces: `userbotRuntimePaths(root: string)`, `readUserbotCredentials(root: string)`, `writeUserbotCredentials(root: string, apiId: string, apiHash: string)`, `enableContainerUserbot(root: string)`, and `disableContainerUserbot(root: string)`.
- Guarantees: atomic mode-`0600` secret writes, no secret echo, idempotent token generation, and marker lifecycle.

- [ ] **Step 1: Write failing tests**

```ts
void test("container credentials and token are private and marker lifecycle is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "iva-userbot-container-"));
  await writeUserbotCredentials(root, "12345", "abcdef123456");
  assert.deepEqual(await readUserbotCredentials(root), {
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "abcdef123456",
  });
  assert.equal(
    (await stat(userbotRuntimePaths(root).credentials)).mode & 0o777,
    0o600,
  );
  await enableContainerUserbot(root);
  const first = await readFile(userbotRuntimePaths(root).token, "utf8");
  await enableContainerUserbot(root);
  assert.equal(await readFile(userbotRuntimePaths(root).token, "utf8"), first);
  await disableContainerUserbot(root);
  await assert.rejects(stat(userbotRuntimePaths(root).enabled), {
    code: "ENOENT",
  });
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `node --test scripts/lib/userbot-container-runtime.test.ts`

Expected: FAIL because `userbot-container-runtime.ts` does not exist.

- [ ] **Step 3: Implement the minimal runtime helper**

Use `mkdir(..., { recursive: true, mode: 0o700 })`, atomic temporary files in the
same directory, `chmod(0o600)`, `rename`, `randomBytes(32).toString("base64url")`,
and `rm(..., { force: true })`. Validate `/^\d+$/` for `apiId` and `/^\S{8,}$/`
for `apiHash`. Parse only `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` through the
existing environment-file parser; do not evaluate shell.

- [ ] **Step 4: Run focused tests**

Run: `node --test scripts/lib/userbot-container-runtime.test.ts`

Expected: all tests PASS and no output contains the synthetic hash or token.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/userbot-container-runtime.ts scripts/lib/userbot-container-runtime.test.ts
git commit -m "feat(userbot): add private container runtime state" -m "Store container onboarding credentials and lifecycle state outside the immutable environment file. Atomic private writes and an idempotent bearer token let the sidecar fail closed without exposing secrets."
```

### Task 2: Container-aware menu and health probe

**Files:**

- Modify: `scripts/lib/menu/userbot.ts`
- Modify: `scripts/lib/menu/userbot.test.ts`
- Modify: `scripts/lib/userbot-health.ts`
- Modify: `scripts/lib/userbot-health.test.ts`

**Interfaces:**

- Consumes: Task 1 runtime helpers.
- Produces: container mode selected by `TELEGRAM_USERBOT_RUNTIME=container`; health URL selected by `TELEGRAM_MCP_URL`; legacy systemd fallback otherwise.

- [ ] **Step 1: Add failing menu tests**

```ts
test("container menu saves credentials outside .env and toggles the marker", async () => {
  process.env.TELEGRAM_USERBOT_RUNTIME = "container";
  await userbot.texts.ubcred("abcdef123456", {}, stateWithApiId, ctx);
  assert.equal(await readFile(envPath, "utf8"), "UNCHANGED=1\n");
  assert.match(
    await readFile(join(root, "data/telegram-userbot.env"), "utf8"),
    /TELEGRAM_API_ID=12345/,
  );
  await userbot.on("do", ["setup"], state, ctx);
  await stat(join(root, "data/telegram-userbot.enabled"));
  await userbot.on("do", ["off"], state, ctx);
  await assert.rejects(stat(join(root, "data/telegram-userbot.enabled")), {
    code: "ENOENT",
  });
});
```

The test must restore environment variables in `t.after` and assert the secret is
absent from rendered text and captured logs.

- [ ] **Step 2: Add failing health tests**

```ts
void test("container health uses marker and configured internal URL without systemd", async () => {
  const health = await probeUserbotHealth({
    runtime: "container",
    mcpUrl: "http://telegram-userbot:8724/mcp",
    isContainerEnabled: () => Promise.resolve(true),
    runSystemctl: () => Promise.reject(new Error("must not call systemd")),
    readToken: () => Promise.resolve("synthetic-token"),
    fetchImpl: (url) => {
      assert.equal(url, "http://telegram-userbot:8724/healthz");
      return Promise.resolve(response(200, { state: "ready" }));
    },
  });
  assert.deepEqual(health, { state: "ready", reason: "ok" });
});
```

- [ ] **Step 3: Confirm both focused suites fail**

Run: `node --test scripts/lib/menu/userbot.test.ts scripts/lib/userbot-health.test.ts`

Expected: FAIL on missing container behavior.

- [ ] **Step 4: Implement container branches and preserve legacy branches**

The menu reads credentials from Task 1 in container mode, calls
`enableContainerUserbot` synchronously for **Turn on**, calls
`disableContainerUserbot` for **Turn off**, and retains `runSetupCommand` plus
systemd for host mode. Error messages name the credential store generically and
never include exception text that may contain a secret or path.

The health probe converts the MCP URL pathname to `/healthz` with `new URL`,
checks the marker before the token, uses the same bearer/timeout logic, and keeps
the current localhost/systemd defaults.

- [ ] **Step 5: Run focused and entrypoint regression tests**

Run: `node --test scripts/lib/menu/userbot.test.ts scripts/lib/userbot-health.test.ts scripts/lib/userbot-health-cli.test.ts scripts/cli/userbot-entrypoints.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/menu/userbot.ts scripts/lib/menu/userbot.test.ts scripts/lib/userbot-health.ts scripts/lib/userbot-health.test.ts
git commit -m "fix(userbot): support container onboarding lifecycle" -m "Route production menu credentials and lifecycle through private runtime files instead of the read-only application environment. Keep the existing systemd path for host installations and probe the configured internal MCP endpoint safely."
```

### Task 3: Sidecar credential loader and supervisor

**Files:**

- Create: `services/telegram-userbot/container_supervisor.py`
- Create: `services/telegram-userbot/test_container_supervisor.py`
- Modify: `services/telegram-userbot/serve.py`
- Modify: `services/telegram-userbot/test_health.py`

**Interfaces:**

- Consumes: `/app/data/telegram-userbot.env`, `.token`, and `.enabled` as read-only files.
- Produces: one supervised `serve.py` child; `load_credentials(path: Path) -> dict[str, str]`; sidecar exit remains controlled by Docker.

- [ ] **Step 1: Write failing Python tests**

```python
def test_credentials_reject_extra_keys_and_public_permissions(self):
    with TemporaryDirectory() as directory:
        path = Path(directory) / "telegram-userbot.env"
        path.write_text("TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\nEXTRA=x\n")
        path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "unexpected credential key"):
            load_credentials(path)
        path.write_text("TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n")
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private permissions"):
            load_credentials(path)

def test_marker_removal_stops_exactly_one_child(tmp_path):
    # Inject fake Popen and bounded poll/wait functions; assert one start,
    # terminate, wait, and no second concurrent process.
```

- [ ] **Step 2: Confirm Python tests fail**

Run: `.venv-userbot/bin/python -m unittest services/telegram-userbot/test_container_supervisor.py`

Expected: FAIL because the supervisor module does not exist.

- [ ] **Step 3: Implement strict parsing and bounded supervision**

Use Python standard library only in the supervisor. Refuse non-regular files,
symlinks, group/other permission bits, duplicate keys, unknown keys, invalid
`api_id`, and short/whitespace `api_hash`. Pass credentials to the fixed
`[sys.executable, SERVE_PATH]` argv through a copied environment. Poll once per
second; on marker removal call `terminate()`, wait up to ten seconds, then
`kill()` and wait. After an unexpected exit wait five seconds before retrying.

`serve.py` accepts `TELEGRAM_USERBOT_CREDENTIALS_FILE`, loads it before checking
required credentials, and lets explicit process environment values take
precedence only for legacy mode. It must not log values.

- [ ] **Step 4: Run Python tests and compilation**

Run: `.venv-userbot/bin/python -m unittest services/telegram-userbot/test_container_supervisor.py services/telegram-userbot/test_health.py && .venv-userbot/bin/python -m py_compile services/telegram-userbot/container_supervisor.py services/telegram-userbot/serve.py`

Expected: PASS with no synthetic secrets in output.

- [ ] **Step 5: Commit**

```bash
git add services/telegram-userbot/container_supervisor.py services/telegram-userbot/test_container_supervisor.py services/telegram-userbot/serve.py services/telegram-userbot/test_health.py
git commit -m "feat(userbot): supervise the container proxy" -m "Start exactly one Telethon proxy only when private credentials, token, and the enable marker are present. Strict parsing, bounded retries, and graceful shutdown provide a fail-closed container lifecycle without host systemd."
```

### Task 4: Internal MCP URL and read-only registry contract

**Files:**

- Modify: `agent/connections/telegram-userbot.ts`
- Create: `services/telegram-userbot/test_readonly_registry.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `TELEGRAM_MCP_URL` with localhost fallback.
- Produces: Eve MCP connection to the internal sidecar and a reproducible registry allow/deny test.

- [ ] **Step 1: Add failing source and registry tests**

The TypeScript/source contract asserts the connection uses
`process.env.TELEGRAM_MCP_URL ?? http://127.0.0.1:${port}/mcp`. The Python test
constructs the MCP server with `TELEGRAM_EXPOSED_TOOLS=read-only`, lists registered
tools, asserts representative read tools and QR onboarding tools exist, and
asserts known send/edit/delete/join/upload/reaction/forward tool names are absent.

- [ ] **Step 2: Confirm the tests fail**

Run: `node --test scripts/coverage-policy.test.ts && .venv-userbot/bin/python -m unittest services/telegram-userbot/test_readonly_registry.py`

Expected: connection source or registry contract FAIL before implementation.

- [ ] **Step 3: Implement configurable URL and CI registry verification**

Use a single constant:

```ts
const url = process.env.TELEGRAM_MCP_URL ?? `http://127.0.0.1:${port}/mcp`;
```

Keep bearer token loading unchanged. Add the Python registry test to the existing
userbot CI step after dependency sync.

- [ ] **Step 4: Rebuild and test authored agent output**

Run: `npm run build && npm run typecheck && node --test scripts/coverage-policy.test.ts && .venv-userbot/bin/python -m unittest services/telegram-userbot/test_readonly_registry.py`

Expected: build, typecheck, and tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/connections/telegram-userbot.ts services/telegram-userbot/test_readonly_registry.py .github/workflows/ci.yml data/custom/agent
git commit -m "feat(userbot): connect IVA to the read-only sidecar" -m "Use the configured internal MCP endpoint while preserving localhost for host installs. CI now proves that the effective registry retains reads and onboarding but excludes Telegram mutation tools."
```

### Task 5: Immutable image, Compose sidecar, and deployment contract

**Files:**

- Modify: `Containerfile`
- Modify: `deploy/container/compose.production.yml`
- Modify: `deploy/container/deploy.sh`
- Modify: `deploy/container/runtime.env.example`
- Modify: `scripts/production/release-contract.test.ts`
- Modify: `scripts/production/deploy-script.test.ts`

**Interfaces:**

- Consumes: immutable `${IVA_IMAGE}`, shared `/app/data:ro`, sidecar-only `telegram-userbot-state`, and internal network.
- Produces: always-running supervisor with no public port and deploy health/restart verification.

- [ ] **Step 1: Add failing release-contract assertions**

```ts
assert.match(compose, /telegram-userbot:/u);
assert.match(compose, /TELEGRAM_EXPOSED_TOOLS: "read-only"/u);
assert.doesNotMatch(userbotServiceBlock, /ports:/u);
assert.match(userbotServiceBlock, /\.\/data:\/app\/data:ro/u);
assert.match(
  userbotServiceBlock,
  /telegram-userbot-state:\/app\/userbot-state/u,
);
assert.doesNotMatch(ivaServiceBlock, /telegram-userbot-state/u);
assert.match(containerfile, /uv pip sync[\s\S]*requirements\.lock/u);
```

Extend the fake Compose deploy test so `ps -q telegram-userbot`, its `running`
state, and zero restart count are required, and `up -d` includes all three
services.

- [ ] **Step 2: Confirm contract tests fail**

Run: `node --test scripts/production/release-contract.test.ts scripts/production/deploy-script.test.ts`

Expected: FAIL because the image, Compose, and deploy script lack the sidecar.

- [ ] **Step 3: Install dependencies during image build**

Create `/opt/iva-userbot-venv` with `uv venv --python python3`, sync
`services/telegram-userbot/requirements.lock` using `--require-hashes --no-deps`,
and set the sidecar command to that venv's Python. Do not download at container
startup.

- [ ] **Step 4: Add the hardened Compose service**

The service uses the same image and digest, command
`["/opt/iva-userbot-venv/bin/python", "/app/services/telegram-userbot/container_supervisor.py"]`,
`TELEGRAM_USERBOT_CREDENTIALS_FILE=/app/data/telegram-userbot.env`,
`TELEGRAM_SESSION_FILE=/app/userbot-state/telegram-userbot.session`,
`TELEGRAM_MCP_HOST=0.0.0.0`, `TELEGRAM_MCP_PORT=8724`, fixed read-only mode,
`./data:/app/data:ro`, and `telegram-userbot-state:/app/userbot-state`. Apply
`no-new-privileges`, `cap_drop: [ALL]`, `pids_limit`, CPU/memory bounds, log
rotation, restart policy, and only `iva-internal`. Add
`TELEGRAM_USERBOT_RUNTIME=container` and internal `TELEGRAM_MCP_URL` to IVA and
poller environment.

- [ ] **Step 5: Update deployment checks and run contracts**

Run: `node --test scripts/production/release-contract.test.ts scripts/production/deploy-script.test.ts && IVA_IMAGE=ghcr.io/strongf-bob/iva:test docker compose -f deploy/container/compose.production.yml config --quiet`

Expected: PASS without printing environment values.

- [ ] **Step 6: Build the production image and inspect dependency imports**

Run: `docker build -f Containerfile -t iva:userbot-readonly . && docker run --rm --entrypoint /opt/iva-userbot-venv/bin/python iva:userbot-readonly -c "import telethon, telegram_mcp, uvicorn"`

Expected: image build and imports PASS.

- [ ] **Step 7: Commit**

```bash
git add Containerfile deploy/container/compose.production.yml deploy/container/deploy.sh deploy/container/runtime.env.example scripts/production/release-contract.test.ts scripts/production/deploy-script.test.ts
git commit -m "ci(userbot): deploy the hardened read-only sidecar" -m "Bake hash-locked userbot dependencies into the immutable image and run the proxy supervisor on the private Compose network. Deployment now verifies the sidecar is running without restarts while account onboarding remains optional operator state."
```

### Task 6: Full verification, documentation audit, review, and production rollout

**Files:**

- Modify if required by finished behavior: `README.md`
- Create: `docs/security/2026-08-07-container-userbot-readonly-audit.md`

**Interfaces:**

- Consumes: all prior tasks and the approved design.
- Produces: fresh local/CI evidence, final security recommendation, merged release, production verification, and owner QR checkpoint.

- [ ] **Step 1: Run repository verification**

Run the focused suites above, then:

```bash
npm run build
npm run typecheck
npm test
npm run test:security
git diff --check
git status --short
```

Expected: every command PASS; only intended tracked changes remain.

- [ ] **Step 2: Perform final AI-SAFE/SHAD audit**

Write `docs/security/2026-08-07-container-userbot-readonly-audit.md` using the
required audit template. Assign a status to all 18 `YAISAFE.*`, the 15 practical
controls, and every applicable SHAD family. Cite exact files/tests and record the
residual account-wide Telethon/dependency risk. Do not include secret values or
private Telegram content.

- [ ] **Step 3: Audit README accuracy**

Use `beautify-github-readme` in audit mode because the default branch will change.
Update README only if setup, architecture, commands, or security claims are now
inaccurate; otherwise record that no README edit is warranted.

- [ ] **Step 4: Request focused code review and fix verified findings**

Use `requesting-code-review`; a review subagent may inspect the final diff but may
not implement functionality. Re-run affected tests after any fix.

- [ ] **Step 5: Push, open PR, and wait for CI**

Push `strongf/container-userbot-readonly`, create an English ready-for-review PR
with Summary, Changes, Motivation, Testing, and Notes, and confirm every required
GitHub check succeeds before merge.

- [ ] **Step 6: Merge and verify protected deployment**

Merge only after green checks. Confirm the exact `origin/main` SHA, successful
deployment workflow, immutable image digest, three running containers, IVA
health, zero restart counts, no host-published `8724`, bearer rejection, fixed
read-only registry, and sanitized logs.

- [ ] **Step 7: Complete owner checkpoint**

Ask the owner to enter the real `api_id` and `api_hash` through the private bot
menu and scan the generated QR in Telegram. Then perform one bounded read-only
check such as dialog-name listing. Confirm no send/edit/delete/join/upload/
reaction/forward tool is available. This human QR step is the only expected
external completion checkpoint.
