# Production deployment design

Date: 2026-08-07

## Goal

Run Iva as the only application project in `/home/strongf` on `student-vm-big`, keep the existing Mihomo VPN intact, make the Telegram bot usable only by its owner, and deploy every verified `main` commit automatically with a safe rollback path.

## Selected approach

GitHub Actions verifies the repository, builds an immutable OCI image for the exact commit, publishes it to GHCR, and deploys it over a dedicated restricted SSH identity. The server keeps runtime secrets and persistent data outside the checkout. Deployment changes the image reference, starts the stack, waits for health checks, and restores the previous image if verification fails.

This is preferred over building from a Git checkout on the server because releases are reproducible and rollback does not depend on rebuilding old source. A self-hosted GitHub runner is rejected because it would give pull-request or workflow code excessive access to the production host.

## Server cleanup boundary

Remove only the verified legacy application resources:

- Compose projects `ai-assistant` and `ai-assistant-v2`, including their containers and project networks.
- Volumes `ai-assistant_postgres_data`, `ai-assistant-v2_neo4j_data`, `ai-assistant-v2_neo4j_logs`, `ai-assistant-v2_postgres_data`, and `ai-assistant-v2_redis_data`.
- Directories `/home/strongf/ai-assistant`, `/home/strongf/ai-assistant-v2`, and `/home/strongf/ai-assistant.backup-20260513-181906`.
- Archives `/home/strongf/ai-assistant-v2.tar.gz` and `/home/strongf/topsha-deploy.tar.gz`.
- Scripts `/home/strongf/setup_ai_assistant_v2.sh`, `/home/strongf/tmp_fix_env.sh`, `/home/strongf/tmp_remote_fix.sh`, and `/home/strongf/wait_v2_infra.sh`.
- The legacy `ai-assistant.service` user unit and stale `hermes-dashboard.service` state.
- Images that are referenced only by those two legacy Compose projects.

Before deletion, migrate only the existing Telegram bot token and numeric owner ID into the new runtime environment. Do not copy old database passwords, encryption keys, NeuralDeep credentials, Telegram userbot credentials, databases, or application state.

Preserve:

- `/home/strongf/.config/mihomo`, `/home/strongf/.local/bin/mihomo`, `/home/strongf/.local/state/mihomo`, and `mihomo.service`.
- `/home/strongf/.ssh`, shell profiles, rootless Docker configuration and runtime.
- Any unrelated hidden user directories.

Deletion begins only after a non-secret manifest is recorded and the Telegram credentials pass a metadata-only validation against Telegram `getMe`.

## Runtime layout

The production runtime lives under `/home/strongf/iva-runtime`:

- `compose.yml`: production service definition.
- `.env`: mode `0600`, owned by `strongf`, never copied into an image or repository.
- `data/`: application state and Codex OAuth token.
- `memory/`: private assistant memory, outside the application repository.
- `vault/`: private user content, outside the application repository.
- `deploy/`: current and previous image references plus deployment logs without secrets.

The bot bridge uses long polling, so no public inbound application port is required. Containers may use Mihomo through the verified host proxy path when configured. Docker restart policies restore services after a host reboot.

## Telegram and model access

The migrated bot token is used only by the bot bridge. `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_DIGEST_CHAT_ID` are set to the migrated owner ID; an empty or mismatched allowlist must fail closed. A new random webhook secret is generated on the server.

The initial model provider is `codex`. After deployment, `iva login` starts the device-code flow. The user opens the displayed OpenAI URL and confirms the code. The resulting refreshable token is stored only in `/home/strongf/iva-runtime/data/codex-auth.json` with mode `0600`. Until this one-time step succeeds, infrastructure and Telegram transport may be healthy but the bot cannot produce model answers.

Personal Telegram userbot credentials are not enabled in the first release. They can be added later as a separate, least-privilege change starting in read-only mode.

## CI/CD flow

Pull requests and pushes run the existing pinned CI checks. Deployment is a separate workflow triggered only after CI succeeds for `main`:

1. Check out the exact successful commit.
2. Build the OCI image without production secrets.
3. Run an image smoke test.
4. Publish both the immutable commit tag and a convenience `main` tag to GHCR.
5. Connect with a dedicated deployment SSH key whose server-side command is restricted to the deploy script.
6. Ask the server to deploy the immutable commit tag.
7. Wait for container health, the local HTTP health endpoint, and Telegram `getMe` identity verification.
8. If any check fails, restore the previous image reference and verify the restored service.

Production secrets remain on the server. GitHub stores only the deployment host, deployment user, host fingerprint, and dedicated private key. Workflow permissions default to read-only and grant package write only to the image-publishing job.

The `main` branch must require the CI workflow before merge. GitHub Actions references remain pinned to full commit SHAs.

## Repository safety

Before any push, add `/memory/` to `.gitignore`; the current local `memory/` directory is a separate private repository and must never enter the public fork. Build context exclusions must cover `.git`, `.env`, `data`, `memory`, and `vault`. A CI secret-pattern check and explicit tracked-file audit guard against accidental credential publication.

## Security requirements

- Telegram authorization is enforced before an agent turn begins.
- The application and deploy identity run without root.
- The deploy key cannot open a general shell and cannot read runtime secrets.
- No untrusted pull-request workflow receives production credentials.
- Container mounts are limited to required runtime directories; the Docker socket is not mounted.
- Tool exposure defaults to the repository's conservative policy; personal Telegram userbot tools remain disabled.
- Logs redact tokens, authorization headers, OAuth device credentials, and user message contents where not needed operationally.
- Dependencies and Actions are pinned through the lockfile or immutable commit SHA.

The pre-release SHAD review covers prompt injection through Telegram messages and attachments, tool-command smuggling, identity spoofing, secret exfiltration, unauthorized deployment, dependency compromise, resource exhaustion, and rollback/recovery behavior. Active adversarial testing is limited to a controlled local or staging-style invocation; no production fuzzing is performed.

## Failure handling and rollback

The deploy script serializes releases with a lock, records the previous immutable image tag, and never removes the running image before the replacement passes checks. A failed deployment automatically restores the previous tag. Persistent directories are not deleted by deployment or rollback. Cleanup of old release images occurs only after at least one known-good previous release remains available.

The legacy project cleanup has a separate preflight manifest. Once its named volumes and directories are removed, their databases are intentionally unrecoverable; only the Telegram identity values are migrated.

## Acceptance criteria

- The exact legacy resource list is gone and no unrelated home-directory entries were removed.
- `mihomo.service` remains enabled and active; direct and proxied egress checks still succeed, and the health selector contains no Russian endpoint.
- The new stack survives a restart and reports healthy without a public inbound port.
- A non-owner Telegram ID receives no agent access; the configured owner receives an acknowledgement and, after Codex login, a real model response.
- Pull-request CI has no production secrets and blocks a failing change.
- A successful `main` run deploys its exact commit image automatically.
- A deliberately unhealthy candidate is rejected and the previous healthy image is restored.
- No `.env`, token, OAuth file, `memory/`, `data/`, or `vault/` content is tracked or present in the image.
- Final checks include container status, health endpoint, Telegram identity, bot round trip, VPN status, deployment logs, GitHub workflow status, and a focused AI-agent security report with residual risks.
