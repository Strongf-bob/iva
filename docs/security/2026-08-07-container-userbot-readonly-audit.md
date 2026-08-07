# Containerized read-only Telegram userbot: security audit

Date: 2026-08-07  
Scope: the container runtime, MCP registry, onboarding lifecycle, deployment
contract, and the IVA-to-Telegram trust path introduced by
`strongf/container-userbot-readonly`.

## 1. Summary

The implementation has a medium residual risk and no confirmed critical or high
application finding in the reviewed path. The main attack chains are indirect
prompt injection through Telegram content, theft or misuse of the Telethon
session, and a compromised upstream MCP dependency. The hard server-side tool
allowlist, bearer authentication, internal-only Compose network, isolated
session volume, read-only root filesystem, private runtime files, and explicit
enable marker are covered by regression tests. This review does not yet include
a real Telegram QR login or live production read, which require the account
owner; those remain release evidence rather than implementation evidence.

## 2. Scope and inventory

| Component        | Implementation                                   | Data and authority                                                                    | Trust boundary                          | Evidence                                                                            |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| Model and policy | IVA agent through the configured OpenCode models | May interpret requested Telegram data; cannot add MCP tools                           | Cloud model to local agent              | `agent/connections/telegram-userbot.ts`; existing injection gate tests              |
| Runtime state    | IVA container                                    | Writes credentials, token, and enable marker; cannot read the Telethon session volume | Bot owner allowlist to local files      | `scripts/lib/userbot-container-runtime.ts` and tests                                |
| MCP proxy        | `serve.py` plus pinned `telegram-mcp`            | Reads account data and performs QR authorization                                      | Agent to bearer-protected internal HTTP | `services/telegram-userbot/serve.py`; `test_readonly_registry.py`; `test_health.py` |
| Session owner    | Telethon in the sidecar                          | MTProto session has full technical account authority                                  | Sidecar-only named volume to Telegram   | `container_supervisor.py`; production Compose contract                              |
| Orchestration    | Rootless Docker Compose                          | Starts one supervisor; fixed CPU, RAM, PID, mounts, and capabilities                  | Host deploy user to containers          | `deploy/container/compose.production.yml`; `release-contract.test.ts`               |
| Deployment       | GitHub Actions and forced exact-SHA deploy       | Can replace the runtime image after CI                                                | GitHub/GHCR to production host          | `.github/workflows/ci.yml`; `deploy/container/deploy.sh`; deploy tests              |
| Logs             | Docker rotation and IVA daily memory             | Operational messages and user conversations                                           | Host storage and model provider         | Compose logging limits; existing IVA log behavior                                   |

There is no new agent-to-agent channel, vector store, public MCP listener, or
Docker socket mount in this change.

## 3. Principal attack chains

```text
Untrusted Telegram message
-> model context
-> instruction to send/delete/join/export an invite
-> MCP registry lookup
-> blocked because the server did not register any mutating tool
```

The chain is broken at the server registry, independently of model compliance.
Confidentiality is not fully broken: the model can still disclose Telegram data
that the owner legitimately asked it to read through another available output
channel.

```text
Compromised Python dependency or sidecar process
-> access to the Telethon session volume
-> direct Telethon call outside MCP policy
-> account read or mutation
```

The blast radius is the connected Telegram account. Hash locks, image
immutability, container isolation, and the kill switch reduce likelihood and
containment time, but the MCP allowlist cannot stop code already executing
inside the trusted session owner.

```text
Unauthorized bot user or guessed MCP bearer
-> onboarding or MCP request
-> account data or session creation
```

The bot allowlist fails closed and the proxy bearer is a private random token.
The sidecar publishes no host port. Object-level authorization within the one
connected account is intentionally absent because this is a single-owner
deployment.

## 4. Findings

### AS-SC-01: a compromised sidecar retains full account capability

- **AI-SAFE:** `YAISAFE.INFRA.1`, `YAISAFE.EXEC.2`.
- **Status / severity:** partial, medium.
- **Asset:** the Telethon authorization key and connected account.
- **Evidence:** the session is isolated in `telegram-userbot-state`, but the
  sidecar process necessarily owns it; Python dependencies are installed from
  `requirements.lock` with hashes.
- **Existing controls:** exact dependency locks, no host port, no broader IVA
  private mounts, read-only root filesystem, dropped capabilities, rootless
  daemon requirement, immutable image deployment, and explicit kill switch.
- **Gap:** dependency compromise can bypass the MCP registry and call Telethon
  directly. No runtime egress policy, SBOM signature, or image attestation is
  enforced on the host.
- **Minimum improvement:** add image provenance verification and automated
  dependency/image scanning; consider sidecar egress restrictions compatible
  with Telegram.
- **Verification:** a policy test must reject an unsigned/unapproved image and
  a scanner report must cover the exact deployed digest.
- **Residual risk owner:** the server/account owner.

### AS-DATA-01: Telegram content and onboarding remain sensitive model inputs

- **AI-SAFE:** `YAISAFE.DATA.2`, `YAISAFE.INPUT.1`.
- **Status / severity:** partial, medium.
- **Asset:** personal messages, peer metadata, `api_hash`, and optional 2FA
  material entered during onboarding.
- **Evidence:** IVA can request read tools and daily logs store conversations;
  the credentials file and token are private `0600` files and are not printed by
  the supervisor.
- **Existing controls:** single-owner bot allowlist, output secret redaction,
  strict credential parser, separate session volume, and no mutating MCP tools.
- **Gap:** requested personal data still crosses the model-provider boundary;
  credentials entered in ordinary chat may be retained in daily history.
- **Minimum improvement:** provide a dedicated secret-entry channel that never
  reaches the model or daily log, and document provider retention settings.
- **Verification:** insert canary credentials through the future secret channel
  and assert they appear in neither model requests nor logs.
- **Residual risk owner:** the operator who selects the model provider.

### AS-OBS-01: security decisions lack dedicated structured telemetry

- **AI-SAFE:** `YAISAFE.EXEC.4`, extended audit controls.
- **Status / severity:** partial, low.
- **Asset:** incident detection and forensic confidence.
- **Evidence:** deployment checks health and restart count; the proxy logs fixed
  lifecycle messages and avoids bearer values. There is no structured audit
  stream for tool name, owner, policy result, and target metadata.
- **Existing controls:** bounded Docker logs, health endpoint, deploy rollback,
  and marker-based containment.
- **Gap:** misuse attempts may be visible only in generic application logs.
- **Minimum improvement:** record secret-free structured MCP policy decisions
  and alert on repeated bearer failures or unexpected restarts.
- **Verification:** a denied-call integration test produces one redacted event
  and an alert fixture without message content or tokens.
- **Residual risk owner:** production operator.

## 5. AI-SAFE coverage

| Area                             | Confirmed | Partial | Absent | Unknown | N/A | Main gap                                                |
| -------------------------------- | --------: | ------: | -----: | ------: | --: | ------------------------------------------------------- |
| Input/Output                     |         0 |       3 |      0 |       0 |   0 | Content can still influence answers and consume context |
| Execution and Tools              |         2 |       2 |      0 |       0 |   0 | Trusted sidecar code has full session authority         |
| Infrastructure and Orchestration |         1 |       2 |      0 |       0 |   0 | No signed-image or runtime egress enforcement           |
| Reasoning and Planning           |         0 |       3 |      0 |       0 |   1 | Model behavior is not the primary write boundary        |
| Knowledge                        |         0 |       3 |      0 |       0 |   1 | Personal data still reaches the selected model          |

All 18 catalog statuses:

- `YAISAFE.INPUT.1` Prompt Injection: partial; the registry prevents account
  mutation, but content can still manipulate the answer.
- `YAISAFE.INPUT.2` Denial of Service: partial; probe timeouts and container
  resource limits exist, while Telegram result size remains upstream-controlled.
- `YAISAFE.INPUT.3` Improper Output Handling: partial; credentials are parsed
  without shell evaluation, but all downstream answer contexts are not covered
  by this change.
- `YAISAFE.EXEC.1` Tool Misuse: confirmed for account mutation; the live registry
  test rejects mutating families.
- `YAISAFE.EXEC.2` Privilege Escalation: partial; mounts and capabilities are
  narrow, while the trusted session owner is necessarily powerful.
- `YAISAFE.EXEC.3` Tool Poisoning: partial; versions are locked and writes are
  absent, but read results remain untrusted model input.
- `YAISAFE.EXEC.4` Auth Bypass and Impersonation: confirmed for the reviewed
  single-owner path through bot allowlisting, bearer auth, and no public port.
- `YAISAFE.INFRA.1` Supply Chain Attacks: partial; hashes and immutable tags are
  checked, but signatures and scanner evidence are absent.
- `YAISAFE.INFRA.2` Resource Overload: confirmed at the sidecar boundary through
  retry delay plus CPU, RAM, PID, log, and health time limits.
- `YAISAFE.INFRA.3` Cross-Agent Poisoning: not applicable; no agent-to-agent
  channel was added.
- `YAISAFE.LOGIC.1` Jailbreaking: partial; the model may be jailbroken, but cannot
  widen the server registry.
- `YAISAFE.LOGIC.2` Reasoning Collapse: partial; existing agent limits remain and
  the sidecar has no autonomous reasoning loop.
- `YAISAFE.LOGIC.3` Goal Manipulation: partial; account writes are unavailable,
  while misleading read summaries remain possible.
- `YAISAFE.LOGIC.4` Overwhelming HITL: not applicable; this integration exposes
  no consequential write-approval queue.
- `YAISAFE.DATA.1` Knowledge Base Poisoning: partial; Telegram content is
  untrusted input but may still influence summaries and memory.
- `YAISAFE.DATA.2` Sensitive Data Disclosure: partial; session and secrets are
  isolated, but requested personal content reaches the model.
- `YAISAFE.DATA.3` Retrieval Manipulation: partial; results are read-only, while
  ranking and completeness remain controlled by Telegram/upstream tooling.
- `YAISAFE.DATA.4` Embedding Inversion: not applicable; this change adds no
  embeddings or vector database.

## 6. Fifteen practical controls

| Control                       | Status                      | Evidence                                                    | Next action                            |
| ----------------------------- | --------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| 1.1 Input validation          | Confirmed for runtime files | strict key/token/mode parser tests                          | Add result-size limits                 |
| 1.2 Rate limiting             | Partial                     | sidecar CPU/PID and bounded restart                         | Bound MCP call/result rates            |
| 1.3 Output validation         | Partial                     | server tool allowlist; secret redaction elsewhere           | Add Telegram-result schema/size tests  |
| 2.1 System prompt hardening   | Partial                     | existing injection policy                                   | Keep server policy authoritative       |
| 2.2 Timeouts/circuit breakers | Confirmed                   | 1.5 s health probe, retry delay, deploy timeout             | Alert on repeated failures             |
| 2.3 Decision audit            | Partial                     | lifecycle/deploy logs                                       | Add structured policy events           |
| 3.1 Data RBAC                 | Confirmed for single owner  | bot allowlist and bearer middleware                         | Re-review before multi-user use        |
| 3.2 Depersonalization         | Absent                      | personal-account reading is the feature                     | Minimize data sent per request         |
| 3.3 Knowledge integrity       | Partial                     | no automatic trust widening                                 | Add provenance to summaries            |
| 4.1 Least-privilege tools     | Confirmed                   | explicit 47-tool read allowlist plus four onboarding tools  | Ratchet registry on dependency updates |
| 4.2 Sandboxing                | Confirmed                   | isolated volume, read-only root, caps dropped, no host port | Evaluate egress policy/seccomp         |
| 4.3 HITL                      | N/A                         | no account write tools                                      | Require a new review before writes     |
| 5.1 Supply chain              | Partial                     | hashes, lock reproducibility, immutable SHA image           | Add SBOM/signature/scanning            |
| 5.2 Denial of Wallet          | Partial                     | model limits plus sidecar resources                         | Add per-request budget telemetry       |
| 5.3 Multi-agent isolation     | N/A                         | no multi-agent integration                                  | Reassess if delegation is added        |

## 7. Action plan

| Priority | Action                                                      | Owner                  | Done when                                                       | Verification                         |
| -------- | ----------------------------------------------------------- | ---------------------- | --------------------------------------------------------------- | ------------------------------------ |
| P0       | Keep writes absent and require a separate review to add any | Maintainer             | Registry ratchet rejects all write families in CI               | `test_readonly_registry.py`          |
| P1       | Complete owner QR login and one bounded production read     | Account owner/operator | Sidecar is authorized and lists dialogs without a write tool    | Live health plus registry/read smoke |
| P1       | Add structured, redacted policy telemetry                   | Maintainer             | Denials/restarts are attributable without content or secrets    | Integration and alert tests          |
| P2       | Add signed image/SBOM/scanner verification                  | Release owner          | Exact deployed digest has verified provenance and scan evidence | Release-policy test                  |
| P2       | Replace chat-based credential entry                         | Maintainer             | Secrets bypass model and daily log                              | Canary non-retention test            |

## 8. Incident readiness

- **Detect:** deployment requires a running zero-restart supervisor; health
  distinguishes off, unavailable, unauthorized, and ready.
- **Contain:** remove `data/telegram-userbot.enabled` through the owner-only menu;
  the supervisor terminates the child.
- **Investigate:** preserve bounded container/application logs and inspect the
  exact image digest without printing credentials or session material.
- **Eradicate:** disable the integration, revoke the Telegram device session,
  rotate `api_hash`/bot token as applicable, and replace the image.
- **Recover:** redeploy the last verified immutable image, recreate private
  runtime files, and perform a fresh QR login.
- **Lessons learned:** add a regression for the observed attack/failure before
  re-enabling.
- **Kill switch:** the private enable marker; Telegram's Devices screen is the
  account-level revocation backstop.
- **Safe fallback:** IVA and the normal bot remain usable with the userbot off.
- **Rollback:** forced deployment keeps the previous healthy image reference.
- **Last rehearsal:** automated marker removal and deployment rollback paths are
  tested; live Telegram revocation has not yet been rehearsed.

## 9. Unknown areas

- A real QR login and read are unavailable until the owner supplies Telegram app
  credentials and scans the QR. This affects operational evidence, not the
  static read-only registry. Obtain it with one owner-observed bounded read.
- Telegram and the selected model provider are external trust domains. Their
  current retention, abuse detection, and account-limitation decisions were not
  independently verified in this code review. The operator must accept or review
  those policies before connecting a critical account.
- No active adversarial scan was run against production because the owner did
  not authorize production red teaming. The safe next step is a local/staging
  prompt-injection regression corpus with canary data and no real account writes.

## 10. Residual risk

| Risk                                          | Why it remains                                     | Compensating control                                             | Owner / review                         |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Dependency compromise gains account authority | Session owner must possess the auth key            | locked dependencies, isolation, kill switch, Telegram revocation | Operator; each dependency update       |
| Personal data reaches a cloud model           | Reading and summarization require model context    | single owner, data minimization, provider selection              | Operator; before login                 |
| Telegram limits or bans the account           | Personal-account automation is externally governed | read-only tools, opt-in beta, immediate disable/revoke           | Account owner; continuous              |
| Misleading summary from poisoned content      | Read-only does not make content truthful           | injection tagging and no account mutation                        | User; verify consequential conclusions |

This audit is advisory, reflects the evidence reviewed on 2026-08-07, and does
not replace a complete threat model, penetration test, red team exercise, or
legal and regulatory assessment.
