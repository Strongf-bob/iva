# Production deployment security review

Date: 2026-08-07

Scope: `Strongf-bob/iva` production delivery and the rootless Docker runtime on the MTTech server.

## Decision

The deployment is suitable for the single-owner bot after the owner completes Codex OAuth. The release path is fail-closed on CI result, commit identity, SSH command shape, runtime health, and Telegram identity. No active adversarial scan was run against production; the evidence below comes from configuration, unit/security tests, workflow results, and bounded postflight checks.

## SHAD review

| Surface                  | Control and evidence                                                                                                                                                                                                                                                                  | Status                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Prompt injection         | Forwarded text, captions, and transcripts pass the Telegram sanitizer; flagged content is marked as data. Covered by `scripts/telegram-reply-context.test.ts` and the Python security-defense suite.                                                                                  | Covered, with residual model risk        |
| Tool-command smuggling   | The agent shell remains a powerful tool, but the container has no Docker socket, drops all capabilities, enables `no-new-privileges`, and receives only the required runtime mounts. Command deadline and descendant cleanup are covered by `scripts/bash-tool.test.ts`.              | Layered mitigation; no command allowlist |
| Telegram identity        | `TELEGRAM_ALLOWED_USER_IDS` fails closed when empty and rejects non-owner IDs before dispatch in `agent/channels/telegram.ts`. Synthetic authorization tests run in CI.                                                                                                               | Covered                                  |
| Secret handling          | `.env`, OAuth state, data, memory, and vault are excluded from Git and the image context. The server `.env` is mode `0600`, mounted read-only, and token values are not printed by deployment checks. Outbound Telegram replies pass secret redaction tests.                          | Covered                                  |
| Deployment authorization | Deploy runs only after successful same-repository `main` push CI. It checks out the exact SHA, publishes an immutable SHA tag, pins the server ED25519 fingerprint, and uses a restricted forced-command SSH key accepting only `deploy <40-lowercase-hex>`.                          | Covered                                  |
| Supply chain             | Third-party GitHub Actions are pinned to full commit SHAs. The runtime image is addressed by verified commit tag and the server records current/previous images. Dependency locks and userbot lock checks run in CI.                                                                  | Covered                                  |
| Runtime isolation        | Docker is required to be rootless. Services drop all capabilities, use `no-new-privileges`, expose Eve only on `127.0.0.1`, have no Docker socket, and use narrow mounts. Root inside the container maps to the unprivileged deploy user so private bind mounts remain `0600`/`0700`. | Covered                                  |
| Resource exhaustion      | Each service is capped at 2 CPUs, 4 GiB RAM, and 512 PIDs. JSON logs rotate at 10 MiB with three files.                                                                                                                                                                               | Covered                                  |
| Health and rollback      | Deployment requires container health, loopback Eve health, and Telegram `getMe`. A failing candidate restores the previous image; the rollback harness covers both success and failure paths.                                                                                         | Covered                                  |
| Recovery and audit       | The immutable image SHA and previous image are stored with mode `0600`. GitHub retains CI/deploy logs; server logs are bounded. Private runtime data remains outside Git and therefore needs a separate backup policy.                                                                | Partial                                  |

## Residual risk

- The model can still make unsafe tool decisions after novel prompt injection. The container boundary limits impact but does not replace human review for destructive or external actions.
- The application and Telegram depend on the selected third-party VPN endpoint. Mihomo tests candidates every minute, excludes Russian-named nodes, and can switch automatically, but a provider-wide outage still interrupts the bot.
- `data`, `memory`, `vault`, and Codex OAuth state are not yet backed up off-host. Server loss would lose this state.
- GitHub Actions and GHCR are release dependencies. An outage blocks new releases but does not stop the already running image.
- The Telegram userbot remains read-only in this deployment. Enabling writes would expand account-ban and external-action risk and requires a separate review.
