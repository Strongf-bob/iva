# Containerized read-only Telegram userbot design

Date: 2026-08-07
Status: approved for implementation

## Problem

The production Telegram menu currently tries to save `TELEGRAM_API_ID` and
`TELEGRAM_API_HASH` into `/app/.env`. Production deliberately mounts that file
read-only, so the first `chmod` fails with `EROFS`. Even a writable mount would
not finish onboarding: the existing `iva userbot setup` command manages a host
systemd user service and a host Python virtual environment, neither of which is
available inside the application container.

Production therefore needs a container-native lifecycle for the personal
Telegram account. The existing host/systemd installation path must continue to
work for non-container installs.

## Goals

- Let the owner enter `api_id` and `api_hash` through the existing private bot
  menu without making the main `.env` writable.
- Run the Telethon/MCP proxy as a dedicated production sidecar.
- Expose only read operations to the agent. Sending, editing, deleting, joining,
  reacting, forwarding, uploading, and other mutating Telegram tools must be
  absent from the MCP registry.
- Keep the proxy unreachable from the public network and bearer-authenticate
  every internal request.
- Preserve QR login through the private owner-only bot flow.
- Keep the Telethon authorization session outside the IVA container's mounts.
- Provide a simple, reliable on/off control and safe failure behavior.
- Preserve the existing host/systemd CLI behavior.

## Non-goals

- Supporting multiple Telegram accounts or multiple IVA owners.
- Publishing TCP port `8724` on the host.
- Adding write tools or a temporary write-mode escape hatch.
- Automating `my.telegram.org` application creation.
- Running active red-team or fuzzing against production.
- Eliminating Telegram's account-restriction risk; Telethon personal-account
  automation remains an operator-accepted beta risk.

## Architecture

Production Compose gains a third long-running service named
`telegram-userbot`. It uses the same immutable IVA image but starts a dedicated
Python entrypoint. Python dependencies are installed and hash-verified during
the image build, not downloaded at runtime.

The sidecar joins only `iva-internal`, listens on `0.0.0.0:8724` inside that
network, and publishes no host port. IVA reaches it through
`http://telegram-userbot:8724/mcp`. All requests require the random bearer token
already used by the MCP proxy.

The sidecar receives a hard-coded production environment value:

```text
TELEGRAM_EXPOSED_TOOLS=read-only
```

This value is set in Compose rather than inherited from `.env`, so a menu write,
stale host configuration, or missing variable cannot widen the tool set. The
existing onboarding tools remain available only to establish and inspect the QR
login. `qr_login_start` and `qr_login_password` are accurately marked as
side-effecting onboarding exceptions; they do not expose Telegram message
mutations.

The sidecar runs with `no-new-privileges`, all Linux capabilities dropped, a
process limit, CPU/memory limits, log rotation, and the same private bridge as
IVA. It receives no Docker socket, SSH material, host project checkout, main
`.env`, IVA memory, or IVA vault.

## Runtime state and permissions

Four untracked runtime artifacts are used:

| Artifact                                  | Mounted into IVA | Mounted into sidecar | Purpose                                      |
| ----------------------------------------- | ---------------: | -------------------: | -------------------------------------------- |
| `data/telegram-userbot.env`               |       read/write |            read-only | `api_id` and `api_hash` entered by the owner |
| `data/telegram-userbot.token`             |       read/write |            read-only | bearer token shared by IVA and MCP proxy     |
| `data/telegram-userbot.enabled`           |       read/write |            read-only | explicit lifecycle marker / kill switch      |
| dedicated `telegram-userbot-state` volume |               no |           read/write | Telethon SQLite session and MTProto auth key |

Credential and token files are atomically written with mode `0600`; the marker
contains no secret. The sidecar validates credential syntax and refuses files
that are not regular files or have group/other permission bits. It reads only
the two expected keys and never evaluates the file as shell syntax.

IVA must be able to read credentials that the private menu itself writes. That
is an accepted residual risk of the current single-container agent design. The
more powerful Telethon session, which represents an already authenticated
account, is isolated in the sidecar-only volume.

No credential value, bearer token, QR payload, session content, or provider key
may be printed to logs, surfaced in diagnostics, committed, or placed in a test
fixture.

## Lifecycle

The sidecar container is always present after deployment, but its supervisor is
idle until all three prerequisites exist: a valid credential file, a non-empty
token file, and the enabled marker.

When prerequisites appear, the supervisor starts exactly one `serve.py` child.
It monitors the marker and required files. Removing the marker terminates the
child gracefully and returns to the idle state without deleting credentials or
the Telegram session. Invalid or missing prerequisites fail closed and do not
start the proxy. Unexpected child exit is retried with a bounded delay while the
marker remains present; Docker restart policy covers supervisor failure.

The private owner-only menu behaves as follows:

1. **Enter credentials** validates numeric `api_id` plus non-empty `api_hash`,
   atomically writes `data/telegram-userbot.env`, and never touches `/app/.env`
   in container mode.
2. **Turn on** creates the bearer token if absent, then atomically creates the
   enabled marker.
3. **Connect by QR** uses the existing MCP onboarding tools after the proxy
   reports `unauthorized`; the owner scans and confirms the QR in Telegram.
4. **Turn off** removes the enabled marker. This is the operational kill switch.

Host installations without `TELEGRAM_USERBOT_RUNTIME=container` retain their
current `.env`, virtualenv, and systemd behavior.

## Health and failure handling

Container mode no longer calls `systemctl`. The shared health probe first checks
the enabled marker, then reads the bearer token and requests the configured
`TELEGRAM_MCP_URL` with a 1.5-second timeout.

State mapping remains compatible with the existing menu:

- no marker: `off`;
- marker present but prerequisites/proxy not ready: `starting`;
- authenticated request fails or response is invalid: `unreachable`;
- proxy reachable but Telethon session not authorized: `unauthorized`;
- proxy reachable and authorized: `ready`.

The agent connection reads `TELEGRAM_MCP_URL`, falling back to localhost for the
legacy host service. Missing token or an unavailable proxy fails closed; it does
not enable another transport or bypass bearer auth.

Deployment verifies that `iva` is healthy and both `telegram-poll` and the
userbot supervisor are running with zero restarts. Because account credentials
and login are operator state, deployment does not require the MCP child to be
enabled or authorized. A separate bounded postflight verifies internal network
isolation, effective read-only tool exposure, bearer rejection, and the menu
state without printing secrets.

## Security requirements and design audit

This change is a read-only R1 assistant integration under the SHAD catalogue,
with MCP/tool and container boundaries additionally in scope.

### Trust flow

```text
private allowlisted Telegram owner
-> bot menu validation
-> private runtime credential/token files
-> sidecar supervisor
-> bearer-authenticated internal MCP
-> read-only Telethon client
-> owner's Telegram data
-> untrusted tool results
-> DeepSeek and IVA response path
```

Telegram messages, peer metadata, media-derived text, and MCP results remain
untrusted data. They must not become authority to widen tools, change the
lifecycle marker, reveal credentials, or perform a Telegram mutation.

### AI-SAFE coverage for this change

| Control                                    | Design status  | Required evidence before release                                                                |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------- |
| `YAISAFE.INPUT.1` Prompt Injection         | partial        | existing injection tests plus a tool-result canary proving no Telegram write tool exists        |
| `YAISAFE.INPUT.2` Denial of Service        | partial        | health timeout and container CPU/RAM/PID limits                                                 |
| `YAISAFE.INPUT.3` Improper Output Handling | partial        | strict credential parser and no shell evaluation                                                |
| `YAISAFE.EXEC.1` Tool Misuse               | designed       | enumerate the live MCP registry and reject every mutating tool family                           |
| `YAISAFE.EXEC.2` Privilege Escalation      | designed       | Compose assertions for mounts, capabilities, ports, resources, and session isolation            |
| `YAISAFE.EXEC.3` Tool Poisoning            | partial        | MCP results remain data; bounded canary regression without downstream mutation                  |
| `YAISAFE.EXEC.4` Auth Bypass               | designed       | missing/wrong bearer negative tests and owner-only menu tests                                   |
| `YAISAFE.INFRA.1` Supply Chain             | designed       | hash-locked Python install in image and existing lock reproducibility CI                        |
| `YAISAFE.INFRA.2` Resource Overload        | designed       | bounded supervisor retry plus container limits and probe timeout                                |
| `YAISAFE.INFRA.3` Cross-Agent Poisoning    | not applicable | no new agent-to-agent channel; the sidecar is a scoped MCP tool server                          |
| `YAISAFE.LOGIC.1` Jailbreaking             | partial        | server-side read-only registry remains effective regardless of model output                     |
| `YAISAFE.LOGIC.2` Reasoning Collapse       | unchanged      | existing IVA step/tool/time limits; no autonomous sidecar loop                                  |
| `YAISAFE.LOGIC.3` Goal Manipulation        | partial        | no Telegram mutation capability and explicit user-request boundary                              |
| `YAISAFE.LOGIC.4` Overwhelming HITL        | not applicable | this integration exposes no consequential write approvals                                       |
| `YAISAFE.DATA.1` Knowledge Poisoning       | partial        | Telegram content is marked untrusted and cannot authorize tool widening                         |
| `YAISAFE.DATA.2` Sensitive Disclosure      | partial        | session isolation, secret-safe logs, owner allowlist; model still reads requested personal data |
| `YAISAFE.DATA.3` Retrieval Manipulation    | partial        | Telegram search results are untrusted and read-only; ranking remains upstream-controlled        |
| `YAISAFE.DATA.4` Embedding Inversion       | not applicable | this change adds no embeddings or vector store                                                  |

### SHAD attack-family decisions

| Family                                                         | Status at design  | Release check                                                                            |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| IO-01/02/03/04 direct, indirect, encoded, multi-turn injection | partial           | existing policy suite plus no-write registry invariant                                   |
| IO-05 system prompt leakage                                    | unchanged partial | secrets absent from prompts and logs                                                     |
| IO-06 improper output handling                                 | designed          | malformed credential and file-syntax negative tests                                      |
| IO-07 context/resource flooding                                | partial           | container and request time limits; upstream result-size risk remains                     |
| RP-01/02/03/04 jailbreak, goal change, collapse, refusal       | partial           | hard read-only boundary independent of model compliance                                  |
| RP-05 overwhelming HITL                                        | not applicable    | no write approvals                                                                       |
| RAG-01/02/03/04/05/06                                          | not applicable    | no RAG, shared long-term memory, tenant corpus, deletion index, or vector store is added |
| TOOL-01 excessive agency                                       | designed          | only read and onboarding tools registered                                                |
| TOOL-02/03/04 poisoning, shadowing, rug pull                   | partial           | pinned dependency and registry enumeration; upstream compromise remains residual         |
| TOOL-05 parameter mutation                                     | not applicable    | no consequential write parameters                                                        |
| TOOL-06 confused deputy                                        | partial           | single owner plus bearer; requested peer reads remain broad within that account          |
| TOOL-07 result injection                                       | partial           | canary result must not trigger unavailable mutation                                      |
| TOOL-08 dangerous composition                                  | partial           | account reads can still be combined with other IVA output/tools; no Telegram write path  |
| ID-01 broad credentials                                        | partial           | session isolated, but Telethon session inherently reads the whole account                |
| ID-02 identity spoofing                                        | designed          | private allowlisted onboarding and bearer-bound MCP                                      |
| ID-03 secret/PII exfiltration                                  | partial           | requested personal Telegram data reaches the configured model; accepted owner scope      |
| ID-04 log leakage                                              | designed          | synthetic canary scan of container and application logs                                  |
| EXEC-01 code/command injection                                 | designed          | parser never evaluates shell; fixed argv entrypoint                                      |
| EXEC-02 sandbox escape                                         | partial           | hardened container and narrow mounts; shared host kernel remains residual                |
| EXEC-03 resource exhaustion                                    | designed          | cgroup/PID limits, timeout, bounded restart delay                                        |
| EXEC-04 supply chain                                           | designed          | hash-pinned Python dependencies installed during immutable build                         |
| EXEC-05 unsafe deploy                                          | unchanged partial | protected CI/CD and immutable rollback image                                             |
| A2A-01/02/03/04                                                | not applicable    | no multi-agent delegation channel is added                                               |
| MM-01/02/03/04                                                 | unchanged         | this feature adds no new media processing path                                           |
| OPS-01 observability                                           | partial           | states and failures logged without payloads or secrets                                   |
| OPS-02 kill switch                                             | designed          | removing enabled marker stops the sole Telethon process                                  |
| OPS-03 rollback/recovery                                       | designed          | immutable image rollback preserves sidecar-only session volume                           |
| OPS-04 fail-open                                               | designed          | missing files, token, auth, or proxy all fail closed                                     |
| OPS-05 incident response                                       | partial           | disable marker, stop sidecar, revoke Telegram session, rotate bearer                     |

Native unit, Python, Compose, and bounded integration tests are the appropriate
evaluation method for this change. Promptfoo, Garak, PyRIT, and FuzzyAI would not
prove MCP authorization, tool-registry pruning, mount isolation, or the kill
switch and will not be run against production.

## Verification plan

Implementation follows test-first changes:

1. Characterize legacy host behavior so it cannot regress.
2. Add failing Node tests for container credential storage, marker lifecycle,
   URL-based health, secret redaction, and owner/private-chat gates.
3. Add failing Python tests for strict credential-file parsing and supervisor
   lifecycle without launching Telegram.
4. Add failing Compose contract tests for the sidecar, internal-only port,
   fixed read-only exposure, isolated session volume, security options, resource
   bounds, and immutable image.
5. Add a registry-level test proving all known mutating Telegram tools are absent
   while required read and QR onboarding tools remain.
6. Build the image and verify hash-locked dependencies import inside it.
7. Run typecheck, focused tests, security tests, production Compose rendering,
   the full relevant test suite, and a clean image build.
8. Deploy through the existing protected `main` CI/CD path.
9. On production, verify container state, restart counts, internal-only network,
   bearer rejection, read-only registry, safe logs, and menu status using
   synthetic values only.
10. The owner then enters real Telegram API credentials and scans the QR. Verify
    one bounded read-only operation, such as listing recent dialog names, without
    sending or changing anything.

No active adversarial scan, destructive Telegram action, or broad production
message-content inspection is authorized.

## Rollback and incident response

- **Immediate containment:** use **Turn off** or remove the enabled marker; if
  needed, stop the sidecar container.
- **Credential concern:** rotate the bearer token and Telegram API application
  credential where possible; terminate the Telegram session from an official
  Telegram client if the MTProto session may be exposed.
- **Code regression:** deploy the previous immutable IVA image. Release Compose
  and deploy logic are extracted from the verified candidate image. A pre-feature
  rollback image keeps only an inert sidecar placeholder, so the core bot can
  recover without attempting to open the preserved session volume.
- **Account-risk signal:** stop the sidecar immediately and use Telegram's
  official active-session controls. Do not automatically retry login or reads.
- **Evidence:** retain only sanitized state transitions, image digest, timestamps,
  and error classes. Do not retain message bodies, credentials, tokens, QR data,
  or session content in the incident report.

## Acceptance criteria

- Entering credentials in the production private menu no longer touches
  `/app/.env` and does not produce `EROFS`.
- The userbot sidecar is deployed, internal-only, bearer-protected, resource
  bounded, and has zero unexpected restarts.
- The effective MCP registry contains read and QR onboarding tools but no
  Telegram mutation tools.
- The Telethon session is stored only in the sidecar-only volume.
- **Turn on** and **Turn off** control the sole Telethon child without systemd.
- Missing/invalid credentials, token, marker, bearer, proxy, or health response
  fail closed and do not expose a fallback path.
- Legacy host/systemd installation and CLI tests still pass.
- No tracked file or inspected log contains real credentials, tokens, QR data,
  Telegram session material, or the previously supplied OpenCode key.
- CI/CD deploys the verified immutable image to production.
- Final account attachment requires the owner to scan Telegram's QR; after that,
  one benign read-only production check succeeds and no write capability exists.

## Residual risk

The personal Telegram API and Telethon session inherently have account-wide
technical capability even though the MCP registry exposes only reads. A
malicious or compromised dependency inside the sidecar could bypass the MCP
tool allowlist. The sidecar also shares the host kernel, and IVA can read the API
credential and bearer files it manages. Requested private messages may be sent
to the configured model provider for answering. These risks are reduced by
single-owner access, immutable hash-pinned builds, network and mount isolation,
session isolation, container hardening, no public port, read-only registry tests,
and the explicit kill switch, but they are not eliminated.
