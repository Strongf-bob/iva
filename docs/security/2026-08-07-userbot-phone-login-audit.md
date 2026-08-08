# Userbot phone-login security review

Date: 2026-08-07
Scope: deterministic owner-only phone, code, and optional 2FA onboarding for the
Telegram userbot sidecar. This is a source and test review; no active red team
was run against production.

## Decision

Recommend release after CI and production health verification. Login material is
kept out of MCP arguments, model input, rendered bot messages, and daily history.
The sidecar exposes a bearer-protected internal HTTP API while the model sees only
read-only `login_status`. QR login and Bot API delivery credentials are removed
from the sidecar.

Residual risk remains material: phone, API credentials, and 2FA text still cross
Telegram's Bot API and can briefly exist in the poller's durable inbound queue.
Delete-before-processing is not erasure. The Telethon session owner also retains
full technical account capability even though the MCP registry is read-only.

## Evidence

- Secret menu and fail-closed deletion: `scripts/lib/menu/userbot.ts`,
  `scripts/lib/menu/index.ts`, and their tests.
- Bounded controller: `services/telegram-userbot/onboarding.py` and
  `test_onboarding.py` (five-minute TTL, 30-second code cooldown, three attempts).
- Internal API: `services/telegram-userbot/serve.py` and `test_health.py`
  (separate onboarding bearer before dispatch, 1 KiB streaming body limit,
  server-side operation timeout, fixed responses).
- Model-visible registry: `test_readonly_registry.py` (only read-only login status;
  QR and mutation tools absent).
- Runtime isolation: `deploy/container/compose.production.yml` and
  `scripts/production/release-contract.test.ts` (the onboarding credential is
  mounted only into poller/sidecar, no bot token/owner IDs in sidecar, no host
  port, narrow mounts, read-only root, dropped capabilities).

## Findings

### PHONE-DATA-01: Telegram transport retains a secret-adjacent copy

- Status/severity: partial, medium.
- The deterministic handler deletes phone/API/2FA messages before using them and
  aborts if deletion fails. This prevents model and daily-log delivery.
- Telegram transport and the durable poll queue precede that handler, so deletion
  cannot prove prior copies are gone.
- Owner: deployment operator. Keep onboarding in the owner-only private chat,
  minimize queue retention, and rotate 2FA if transport compromise is suspected.

### PHONE-ID-01: previously exposed bot token still requires rotation

- Status/severity: open, high until human rotation.
- Historical HTTP client diagnostics included the production bot token. This
  change removes the token from the userbot sidecar, but cannot revoke it.
- Owner: account owner. Rotate through BotFather outside Iva/Codex chat, update
  production secret storage, redeploy, and verify the old token is rejected.

### PHONE-EXEC-01: the trusted sidecar can bypass its MCP allowlist

- Status/severity: partial, medium.
- Hash locking, immutable deployment, narrow mounts, rootless Docker, dropped
  capabilities, and a kill switch reduce likelihood and blast radius.
- A compromised Python dependency or sidecar process still owns the Telethon
  session and can call Telethon directly. Add signed-image/provenance enforcement
  and scanning for the exact deployed digest.

## AI-SAFE status (all 18 threats)

- `YAISAFE.INPUT.1` Prompt Injection: partial. Login bypasses the model, but
  Telegram read results remain untrusted model input.
- `YAISAFE.INPUT.2` Denial of Service: partial. Inputs, attempts, TTL, cooldown,
  client/server timeouts, and container resources are bounded; distributed abuse is not.
- `YAISAFE.INPUT.3` Improper Output Handling: confirmed for onboarding. Strict
  fields and fixed state/reason values cross each boundary.
- `YAISAFE.EXEC.1` Tool Misuse: confirmed for onboarding. Secrets are not tool
  arguments and QR/mutating tools are absent.
- `YAISAFE.EXEC.2` Privilege Escalation: partial. Container privilege is narrow,
  but the trusted session owner necessarily has full account authority.
- `YAISAFE.EXEC.3` Tool Poisoning: partial. The upstream commit and hashes are
  pinned; read results can still carry hostile content.
- `YAISAFE.EXEC.4` Auth Bypass and Impersonation: confirmed for the reviewed path.
  Owner allowlisting precedes the menu, and a separate bearer unavailable to the
  agent container precedes onboarding dispatch. Host-native mode is weaker.
- `YAISAFE.INFRA.1` Supply Chain Attacks: partial. Hashes and immutable images are
  required; signatures, SBOM attestation, and fresh scanner evidence are absent.
- `YAISAFE.INFRA.2` Resource Overload: partial. Request size, retries, process,
  memory, CPU, PID, and log bounds exist; upstream Telegram load is external.
- `YAISAFE.INFRA.3` Cross-Agent Poisoning: not applicable. No agent-to-agent path
  is introduced.
- `YAISAFE.LOGIC.1` Jailbreaking: partial. A jailbroken model cannot receive login
  secrets or widen the server registry, but it can mishandle read content.
- `YAISAFE.LOGIC.2` Reasoning Collapse: confirmed for onboarding. The flow is a
  deterministic bounded state machine with no autonomous loop.
- `YAISAFE.LOGIC.3` Goal Manipulation: confirmed for onboarding. Model intent
  cannot select phone/code/password operations or their values.
- `YAISAFE.LOGIC.4` Overwhelming HITL: not applicable. The feature creates no
  consequential approval queue.
- `YAISAFE.DATA.1` Knowledge Base Poisoning: not applicable to onboarding. It
  writes no memory or knowledge base.
- `YAISAFE.DATA.2` Sensitive Data Disclosure: partial. Model/daily isolation is
  tested, while Telegram transport, poll queue, host, and session remain trusted.
- `YAISAFE.DATA.3` Retrieval Manipulation: not applicable to onboarding. No
  retrieval corpus or ranking is changed.
- `YAISAFE.DATA.4` Embedding Inversion: not applicable. No embeddings or vector
  store are used.

## SHAD checklist

- `IO-01`, `IO-04`: partial. Secret values bypass the model and are masked, but
  Telegram transport retains residual exposure.
- `TOOL-01`, `TOOL-06`: confirmed. Login is outside MCP and registry tests fail
  closed on QR/mutation exposure.
- `ID-03`, `ID-04`: partial. Owner allowlist plus separate MCP/onboarding bearers
  are layered in container production. Phone onboarding is disabled in host-native
  mode because it cannot isolate the bearer from model shell tools; the leaked bot
  token still needs human rotation.
- `EXEC-03`, `EXEC-04`, `EXEC-05`: partial. Deterministic transitions, limits,
  cancellation, and isolation are tested; trusted-sidecar compromise remains.
- `OPS-02`, `OPS-03`, `OPS-04`: partial. Fixed diagnostics, health checks, rollback,
  and a kill switch exist; dedicated security telemetry and token rotation remain.
- RAG, memory poisoning, multimodal, and multi-agent SHAD families: not applicable
  to this deterministic login change.

## Release gates

1. CI passes on the exact commit and deployment uses its immutable image digest.
2. Production sidecar is healthy, unauthorized before login, exposes no host
   port or QR tools, rejects the MCP bearer on onboarding routes, and mounts the
   onboarding credential only into poller/sidecar.
3. The owner completes one real phone/code flow through `/menu`; no login material
   appears in application logs or daily history.
4. The previously exposed bot token is rotated outside chat and the old token is
   verified invalid. This is a human security checkpoint, not an automatable code
   change.
