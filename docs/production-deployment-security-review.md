# Production deployment security review

Date: 2026-08-07

Scope: `Strongf-bob/iva` production delivery and the rootless Docker runtime on the MTTech server.

## Decision

The deployment infrastructure is suitable for the single-owner bot with the residual risks below accepted for this rollout. The release path is fail-closed on CI result, commit identity, SSH command shape, runtime health, and Telegram identity. OpenCode Go is production-verified with DeepSeek V4 Flash for text/tool turns and Qwen3.7 Plus for bounded image description. No active adversarial scan was run against production; the evidence below comes from configuration, unit/security tests, workflow results, and bounded postflight checks.

## Production evidence

- Pull request CI run `31180104824` and protected-`main` CI run `31180421555` completed successfully, including the full Node suite, coverage gate, production Compose validation, replica smoke, Python security tests, and userbot guardrails.
- Deploy run `31180720033` published and deployed `ghcr.io/strongf-bob/iva:sha-0f66ca4c8915aae8dfaee5e3de0ee8422d07cb56`.
- Both production services ran that exact image with zero restarts; Eve reported `ready`, and the `iva` service was Docker-healthy.
- The server environment remained mode `0600`, contained the four expected non-secret routing values and one non-empty OpenCode credential, and contained no legacy Codex model entries.
- An authenticated request from inside the production container returned HTTP 200 from `deepseek-v4-flash` with the expected tool call. A valid 16 by 16 PNG returned HTTP 200 and non-empty content from `qwen3.7-plus`.
- An owner-only synthetic Telegram acceptance turn returned HTTP 204 with a `turn` receipt and reached Telegram in 4.976 seconds. The bounded postflight log window contained no error lines, secret-like key matches, or container restarts.
- Mihomo was active and enabled. `AUTO-NON-RU` remained a 60-second `URLTest` group with 12 members, zero Russian-named nodes, a non-Russian selected node, seven responsive candidates, and a best measured delay of 185 ms. The OpenCode model catalog returned HTTP 200 through the SOCKS listener in 0.483 seconds.

## SHAD review

| Surface                  | Control and evidence                                                                                                                                                                                                                                                                                                                         | Status                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Prompt injection         | Forwarded text, captions, and transcripts pass the Telegram sanitizer; flagged content is marked as data. Qwen image descriptions are not separately wrapped or sanitized before entering DeepSeek context, so image-borne instructions remain a known gap.                                                                                  | Partial; image-derived context remains untrusted |
| Tool-command smuggling   | The agent shell remains a powerful tool, but the container has no Docker socket, drops all capabilities, enables `no-new-privileges`, and receives only the required runtime mounts. Command deadline and descendant cleanup are covered by `scripts/bash-tool.test.ts`.                                                                     | Partial; shell and outbound network remain broad |
| Telegram identity        | `TELEGRAM_ALLOWED_USER_IDS` fails closed when empty and rejects non-owner IDs before dispatch in `agent/channels/telegram.ts`. Synthetic authorization tests run in CI.                                                                                                                                                                      | Covered                                          |
| Secret handling          | `.env`, OAuth state, data, memory, and vault are excluded from Git and the image context. The server `.env` is mode `0600`, mounted read-only, and token values are not printed by deployment checks. The operator chose direct `.env` storage for OpenCode Go; the agent process and host-native tools can still reach runtime credentials. | Partial; direct-environment risk accepted        |
| Deployment authorization | Deploy runs only after successful same-repository `main` push CI. It checks out the exact SHA, publishes an immutable SHA tag, pins the server ED25519 fingerprint, and uses a restricted forced-command SSH key accepting only `deploy <40-lowercase-hex>`.                                                                                 | Covered                                          |
| Supply chain             | Third-party GitHub Actions are pinned to full commit SHAs. The runtime image uses a verified commit tag and the server records current/previous images. Dependency locks and userbot lock checks run in CI. Commit tags can still be overwritten on a trusted workflow rerun.                                                                | Partial                                          |
| Runtime isolation        | Docker is required to be rootless. Services drop all capabilities, use `no-new-privileges`, expose Eve only on `127.0.0.1`, have no Docker socket, and use narrow mounts. Root inside the container maps to the unprivileged deploy user so private bind mounts remain `0600`/`0700`.                                                        | Covered                                          |
| Resource exhaustion      | Each service is capped at 2 CPUs, 4 GiB RAM, and 512 PIDs. JSON logs rotate at 10 MiB with three files.                                                                                                                                                                                                                                      | Covered                                          |
| Health and rollback      | Deployment requires Eve health, a stable running poller, Telegram `getMe`, and the expected public bot ID. A failing candidate restores the previous image; the rollback harness covers code rollback paths. Shared persistent state is not automatically restored.                                                                          | Partial                                          |
| Recovery and audit       | The immutable image SHA and previous image are stored with mode `0600`. GitHub retains CI/deploy logs; server logs are bounded. Private runtime data remains outside Git and therefore needs a separate backup policy.                                                                                                                       | Partial                                          |

## Residual risk

- The model can still make unsafe tool decisions after novel prompt injection. The container boundary limits impact but does not replace human review for destructive or external actions.
- Qwen image descriptions enter DeepSeek context without a dedicated untrusted-data wrapper. A malicious screenshot can influence tool selection or persisted memory; adding the wrapper and a negative regression test is a priority follow-up.
- Provider errors can place a bounded response-body excerpt in server logs. Access is restricted and logs rotate, but explicit provider-error redaction remains a follow-up.
- The operator accepted direct `.env` storage for this rollout. The unrestricted shell, file tools, agent-visible credentials, and broad outbound network mean a successful prompt/tool injection could read or exfiltrate the OpenCode key. Telegram redaction cannot prevent non-Telegram exfiltration from inside the agent container; credential isolation remains the highest-priority follow-up.
- The application and Telegram depend on the selected third-party VPN endpoint. Mihomo tests candidates every minute, excludes Russian-named nodes, and can switch automatically, but a provider-wide outage still interrupts the bot.
- `data`, `memory`, `vault`, and Codex OAuth state are not yet backed up off-host. Server loss would lose this state.
- A code rollback reuses writable persistent state. Releases that change persisted formats need an explicit compatible migration and restore procedure.
- GitHub Actions and GHCR are release dependencies. An outage blocks new releases but does not stop the already running image.
- The Telegram userbot remains read-only in this deployment. Enabling writes would expand account-ban and external-action risk and requires a separate review.
