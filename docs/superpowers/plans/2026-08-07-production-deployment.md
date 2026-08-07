# Production Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two legacy server applications with a private-owner Iva Telegram bot that is released from verified `main` commits and rolls back automatically on failed health checks.

**Architecture:** GitHub Actions builds an immutable OCI image after CI succeeds, publishes it to GHCR, and invokes a forced-command SSH deployment entrypoint. Rootless Docker Compose runs Eve and the Telegram poller from the same image while secrets, OAuth state, memory, and data remain under `/home/strongf/iva-runtime` on the server.

**Tech Stack:** Node.js 24, TypeScript, Docker/Compose, GHCR, GitHub Actions, POSIX shell, systemd user services, Telegram Bot API, OpenAI Codex OAuth.

## Global Constraints

- Preserve `/home/strongf/.config/mihomo`, `/home/strongf/.local/bin/mihomo`, `/home/strongf/.local/state/mihomo`, `mihomo.service`, `/home/strongf/.ssh`, shell profiles, and rootless Docker.
- Migrate only `TELEGRAM_BOT_TOKEN` and the numeric owner ID from the legacy applications.
- Never commit or put into the image `.env`, OAuth state, `data/`, `memory/`, or `vault/`.
- The bot must fail closed unless the sender is in `TELEGRAM_ALLOWED_USER_IDS`.
- Deployment must use the immutable successful commit SHA and automatically restore the previous healthy image on failure.
- GitHub pull-request jobs must not receive production credentials.
- Do not mount the Docker socket into application containers.
- Do not run active adversarial scans against production.

---

### Task 1: Repository and image safety contract

**Files:**
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `Containerfile`
- Create: `scripts/production/release-contract.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the existing multi-stage `Containerfile` and Node test runner.
- Produces: `npm run test:release`, a static release-safety gate used by CI.

- [x] **Step 1: Write the failing release-contract test**

Create a Node test that reads `.gitignore`, `.dockerignore`, `Containerfile`, the production Compose file, deploy script, and deployment workflow. Assert that private runtime paths are ignored; the container uses Node 24; no Docker socket is mounted; Compose references `${IVA_IMAGE:?IVA_IMAGE is required}`; workflow permissions are read-only by default; deploy waits on CI; and every `uses:` reference ends in a 40-character commit SHA.

- [x] **Step 2: Run the focused test and observe the missing-contract failure**

Run: `node --test scripts/production/release-contract.test.ts`

Expected: FAIL because `/memory/`, the production Compose file, deployment script, and workflow contract do not yet exist.

- [x] **Step 3: Harden ignore and image rules**

Add these repository-ignore entries:

```gitignore
/memory/
/iva-runtime/
```

Ensure `.dockerignore` contains exactly the sensitive build-context families `.git`, `.env`, `data`, `memory`, and `vault`. Add an OCI source label and an unprivileged runtime user to `Containerfile`; create and chown `/app/data`, `/app/memory`, and `/app/vault` before switching to that user.

- [x] **Step 4: Add the focused package command**

Add this script to `package.json`:

```json
"test:release": "node --test scripts/production/release-contract.test.ts"
```

- [x] **Step 5: Run the available subset**

Run: `npm run test:release`

Expected: remaining failures name only the production files introduced in Tasks 2 and 3.

### Task 2: Production Compose runtime and health checks

**Files:**
- Create: `deploy/container/compose.production.yml`
- Create: `deploy/container/runtime.env.example`
- Modify: `scripts/production/release-contract.test.ts`

**Interfaces:**
- Consumes: `IVA_IMAGE`, `/home/strongf/iva-runtime/.env`, and persistent runtime directories.
- Produces: services `iva` and `telegram-poll`, both on the internal `iva-internal` network; only `iva` exposes loopback port `8723`.

- [ ] **Step 1: Extend the failing test for Compose invariants**

Assert that both services use the required immutable image variable, `iva` has an HTTP health check for `/eve/v1/health`, `telegram-poll` depends on `service_healthy`, restart policy is `unless-stopped`, all mounts are narrow bind mounts, and no service publishes a non-loopback address.

- [ ] **Step 2: Run the test to verify the Compose assertions fail**

Run: `npm run test:release`

Expected: FAIL with missing `deploy/container/compose.production.yml` assertions.

- [ ] **Step 3: Implement the production Compose file**

Define the shared environment:

```yaml
environment:
  ASSISTANT_HOST: http://iva:8723
  IVA_PORT: "8723"
  PORT: "8723"
```

Mount `./data:/app/data`, `./memory:/app/memory`, `./vault:/app/vault`, and `./.env:/app/.env:ro`. Publish only `127.0.0.1:8723:8723`. The health check runs `curl --fail --silent http://127.0.0.1:8723/eve/v1/health` with a 5-second interval, 5-second timeout, 24 retries, and a 20-second start period.

- [ ] **Step 4: Document the server-only environment shape**

The example includes variable names and non-secret defaults only: `MODEL_PROVIDER=codex`, `CODEX_MODEL=gpt-5.5`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_DIGEST_CHAT_ID`, `TELEGRAM_EXPOSED_TOOLS=read-only`, `ASSISTANT_TIMEZONE=Europe/Moscow`, `ASSISTANT_VAULT_DIR=vault`, `ASSISTANT_DATA_DIR=data`, `IVA_PORT=8723`, and `ASSISTANT_HOST=http://iva:8723`. Secret variables have empty values.

- [ ] **Step 5: Validate Compose rendering without secrets**

Run: `IVA_IMAGE=ghcr.io/strongf-bob/iva:test docker compose -f deploy/container/compose.production.yml --env-file deploy/container/runtime.env.example config --quiet`

Expected: exit 0.

### Task 3: Restricted deployment with automatic rollback

**Files:**
- Create: `deploy/container/deploy.sh`
- Create: `scripts/production/deploy-script.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: a forced SSH command `deploy <40-lowercase-hex-sha>` and runtime root `/home/strongf/iva-runtime`.
- Produces: atomic `deploy/current-image`, `deploy/previous-image`, a healthy Compose stack, and non-secret deployment logs.

- [ ] **Step 1: Write failing shell-contract tests**

Test rejection of empty commands, shell metacharacters, tags other than a 40-character lowercase commit SHA, and commands other than `deploy`. With mocked `docker`, `curl`, `flock`, and `timeout`, assert that a failed candidate health check restores the prior image and that successful deployment advances `current-image` only after health passes.

- [ ] **Step 2: Run the tests and observe failure**

Run: `node --test scripts/production/deploy-script.test.ts`

Expected: FAIL because `deploy/container/deploy.sh` is absent.

- [ ] **Step 3: Implement the forced-command entrypoint**

Use `set -eu`, a fixed `PATH`, `umask 077`, and `flock`. Read `${SSH_ORIGINAL_COMMAND:-}` and accept only this regular expression:

```text
^deploy [0-9a-f]{40}$
```

Build the image as `ghcr.io/strongf-bob/iva:sha-<sha>`. Pull it, render Compose with `IVA_IMAGE`, start `iva` and `telegram-poll`, poll the container health plus `http://127.0.0.1:8723/eve/v1/health`, and query Telegram `getMe` without printing the token. On failure, restore `previous-image`, start it, re-run health checks, and exit non-zero.

- [ ] **Step 4: Add the deploy test command and pass focused tests**

Add:

```json
"test:deploy": "node --test scripts/production/deploy-script.test.ts scripts/production/release-contract.test.ts"
```

Run: `npm run test:deploy`

Expected: PASS.

### Task 4: GitHub Actions image publication and deployment

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `scripts/production/release-contract.test.ts`

**Interfaces:**
- Consumes: successful `CI` workflow runs for `main`, repository `GITHUB_TOKEN`, and secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
- Produces: GHCR tags `sha-<40-hex-sha>` and `main`, followed by the forced SSH command `deploy <sha>`.

- [ ] **Step 1: Extend static tests for workflow security**

Assert `workflow_run` references `CI` and `completed`, jobs check `conclusion == 'success'`, branch is `main`, checkout uses `head_sha`, PR-controlled code is never evaluated with deployment secrets, default permissions are `contents: read`, package publication grants only `packages: write`, and all Actions are SHA-pinned.

- [ ] **Step 2: Run the test and observe workflow failures**

Run: `npm run test:release`

Expected: FAIL because `.github/workflows/deploy.yml` is absent.

- [ ] **Step 3: Implement build and deploy jobs**

The build job logs in to `ghcr.io` with `GITHUB_TOKEN`, builds the exact `head_sha`, runs an image smoke check, and pushes both tags. The deploy job downloads no artifacts, writes the SSH key with mode `0600`, verifies the host against `DEPLOY_KNOWN_HOSTS`, and executes exactly `deploy "$DEPLOY_SHA"`. Add a production concurrency group with `cancel-in-progress: false`.

- [ ] **Step 4: Run focused and repository checks**

Run: `npm run test:deploy && npm run lint && npm run format:check && npm run typecheck`

Expected: all commands exit 0.

### Task 5: Provision server runtime and migrate Telegram identity

**Files:**
- Server create: `/home/strongf/iva-runtime/.env`
- Server create: `/home/strongf/iva-runtime/compose.yml`
- Server create: `/home/strongf/iva-runtime/deploy/deploy.sh`
- Server create: `/home/strongf/.ssh/iva_deploy_ed25519.pub`
- Server modify: `/home/strongf/.ssh/authorized_keys`

**Interfaces:**
- Consumes: the validated legacy bot token and owner ID, repository deployment files, and a newly generated dedicated Ed25519 key.
- Produces: mode-`0600` runtime secrets, persistent directories, and a forced-command deployment identity.

- [ ] **Step 1: Validate migration inputs without exposing secrets**

Read the legacy `.env` values in-process, require a Telegram token shape and numeric owner ID, call `https://api.telegram.org/bot<TOKEN>/getMe`, and record only the returned bot ID and username. Abort cleanup if validation fails.

- [ ] **Step 2: Create runtime directories and environment atomically**

Create `data`, `memory`, `vault`, and `deploy` with mode `0700`. Generate new `TELEGRAM_WEBHOOK_SECRET_TOKEN` and `ASSISTANT_BEARER`. Write `.env` through a temporary mode-`0600` file and rename it. Set the Telegram allowlist and digest ID to the migrated owner ID.

- [ ] **Step 3: Install Compose and deploy entrypoint**

Copy the reviewed production Compose and deploy script into the runtime directory, preserve executable modes, and verify their SHA-256 hashes against local files.

- [ ] **Step 4: Configure the restricted deployment key**

Generate a dedicated Ed25519 key locally. Add its public key to `authorized_keys` with `restrict`, `command="/home/strongf/iva-runtime/deploy/deploy.sh"`, `no-agent-forwarding`, `no-port-forwarding`, `no-pty`, `no-user-rc`, and `no-X11-forwarding`. Confirm the existing administrative key remains present.

- [ ] **Step 5: Verify runtime permissions and forced-command rejection**

Run remote `stat` checks and try a harmless unsupported command using the deploy key.

Expected: `.env` is `600`, private directories are `700`, the unsupported command exits non-zero, and no interactive shell is available.

### Task 6: Remove the exact legacy resources and preserve VPN

**Files:**
- Server create: `/home/strongf/iva-runtime/deploy/legacy-cleanup-manifest.txt`

**Interfaces:**
- Consumes: the exact approved resource list from the design and a validated Telegram migration.
- Produces: a clean home directory with Mihomo and rootless Docker intact.

- [ ] **Step 1: Record a non-secret preflight manifest**

Record container IDs/names/status, network names, volume names, image IDs/tags, target directory names and sizes, user-unit states, and VPN service state. Do not record environment values.

- [ ] **Step 2: Stop and remove the legacy Compose projects**

Run each existing Compose file with `docker compose down --remove-orphans`, then explicitly verify no container label remains for projects `ai-assistant` or `ai-assistant-v2`.

- [ ] **Step 3: Remove only the approved volumes, images, units, and paths**

Resolve each exact name before removal. Disable and remove only `ai-assistant.service`; clear the stale `hermes-dashboard.service` failure state. Remove the approved paths and images referenced only by the old projects.

- [ ] **Step 4: Run the cleanup postflight**

Verify every approved target is absent, no unrelated home entry disappeared, rootless Docker responds, and `mihomo.service` is still enabled and active.

- [ ] **Step 5: Verify VPN behavior**

Confirm the selector still has no Russian node, a direct request and a proxied request both complete, their egress IPs differ, and the latest selector health result is usable. Do not print the subscription URL or credentials.

### Task 7: Publish, protect `main`, and perform the first deployment

**Files:**
- GitHub repository settings and Actions secrets for `Strongf-bob/iva`.

**Interfaces:**
- Consumes: verified branch commits, the dedicated deployment key, and server host fingerprint.
- Produces: protected `main`, a public/pullable GHCR package, and the first healthy production release.

- [ ] **Step 1: Run the full local verification suite**

Run: `npm run lint && npm run format:check && npm test && npm run test:coverage && npm run typecheck && npm run build && npm run replica && python3 scripts/autograph/tests/test_autograph.py && python3 agent/skills/security-defense/scripts/test_security.py`

Expected: all commands exit 0.

- [ ] **Step 2: Audit the staged publication boundary**

Run tracked-file and diff scans for `.env`, Telegram token shapes, authorization headers, private keys, `codex-auth.json`, and files under `memory`, `data`, or `vault`. Inspect the complete staged diff before commit.

- [ ] **Step 3: Commit and push the implementation branch**

Create Conventional Commits with detailed bodies, push `strongf/production-deploy`, open a ready PR, and wait for CI to succeed.

- [ ] **Step 4: Merge and protect `main`**

Require the `verify` status check, at least one pull-request approval where GitHub permits it, conversation resolution, and no force pushes or deletions. Merge only after CI is green.

- [ ] **Step 5: Configure deployment secrets and GHCR visibility**

Set `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and `DEPLOY_KNOWN_HOSTS` through authenticated GitHub CLI input without echoing values. Make the image package pullable by the production server without placing a broad GitHub token in runtime state.

- [ ] **Step 6: Observe the first deployment**

Wait for the Deploy workflow, record its commit SHA, then verify the running image label/tag matches that SHA, both containers are healthy, and only port `127.0.0.1:8723` is published.

- [ ] **Step 7: Prove rollback**

Invoke the deploy script in its test harness with a deliberately unhealthy candidate, not against the live production image. Verify the harness restores its previous tag and returns non-zero.

### Task 8: Authorize Codex and verify the live bot

**Files:**
- Server create: `/home/strongf/iva-runtime/data/codex-auth.json`

**Interfaces:**
- Consumes: the running Iva image and an interactive OpenAI device-code confirmation by the user.
- Produces: a mode-`0600` OAuth token and a successful owner-only Telegram conversation.

- [ ] **Step 1: Start the device-code login inside the production image**

Run `docker compose run --rm iva node bin/iva.mjs login` with the production runtime mounts and relay only the public verification URL and one-time device code to the user.

- [ ] **Step 2: Wait for the user confirmation and verify token permissions**

Expected: the command reports successful login; `codex-auth.json` exists in `data`, is owned by `strongf`, has mode `0600`, and is absent from container layers and Git.

- [ ] **Step 3: Restart and test the owner flow**

Restart the two services, send a benign message from the configured owner account, and verify a real model response arrives. Confirm logs contain update IDs and status but not message text or credentials.

- [ ] **Step 4: Verify fail-closed behavior without contacting another person**

Run the Telegram authorization unit/integration test with a synthetic non-owner ID and confirm it receives no agent turn. Do not message an unrelated Telegram account.

### Task 9: Final security and operations verification

**Files:**
- Create: `docs/security/production-deployment-review.md`
- Modify: `README.md` only if the finished default-branch behavior changes documented setup or operation.
- Modify: `README.ru.md` only if the same documentation update is needed in Russian.

**Interfaces:**
- Consumes: fresh repository, GitHub Actions, server, bot, and VPN evidence.
- Produces: an evidence-backed SHAD review and final operator handoff.

- [ ] **Step 1: Run the focused SHAD review**

Record evidence for prompt-injection handling, tool-command smuggling, Telegram identity enforcement, secret boundaries, deployment authorization, dependency pinning, resource limits, log redaction, incident rollback, and recovery. Classify remaining risks and do not claim coverage without a test or configuration reference.

- [ ] **Step 2: Audit README accuracy**

Use the README audit workflow because `main` changes. Update only setup, deployment, architecture, command, or proof statements that became inaccurate; otherwise record that no README change is required.

- [ ] **Step 3: Run fresh postflight checks**

Verify GitHub CI and Deploy conclusions, exact running image SHA, Docker health, Eve health, Telegram `getMe`, owner bot round trip, OAuth file permissions, VPN service and egress, home cleanup boundary, no tracked secrets, and rollback-harness result.

- [ ] **Step 4: Commit any final documentation and report residual risks**

The final report states what was removed, whether it is recoverable, what is running, the deployed SHA, bot username, GitHub workflow links, VPN status, remaining manual account dependencies, and any residual security limitations.
