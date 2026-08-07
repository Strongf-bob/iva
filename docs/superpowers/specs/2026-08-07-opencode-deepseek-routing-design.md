# OpenCode Go model routing design

Date: 2026-08-07
Status: implementation in progress

## Goal

Enable real model replies for the single-owner production Telegram assistant through OpenCode Go without OpenAI OAuth. Keep routing deliberately simple: DeepSeek V4 Flash owns every conversational and agentic turn; a separate multimodal model only converts images into text.

## Provider configuration

The production runtime uses these non-secret settings:

- `MODEL_PROVIDER=opencode`
- `OPENCODE_MODEL=deepseek-v4-flash`
- `OPENCODE_CONTEXT_WINDOW=131072`
- `THINKING_EFFORT=medium`

The OpenCode Go key is stored only in `/home/strongf/iva-runtime/.env`, which remains mode `0600`. The key must never be committed, copied into GitHub Actions, printed by deployment commands, included in test fixtures, or written to application logs.

## Routing

### Text and tools

DeepSeek V4 Flash handles:

- ordinary Telegram text;
- voice and audio after transcription;
- memory reads and writes;
- planning and reasoning;
- all tool selection and tool calls;
- the final user-facing answer.

There is no automatic escalation to DeepSeek V4 Pro or another premium text model. Model selection therefore stays predictable and bounded by the OpenCode Go subscription limits.

### Images and screenshots

`qwen3.7-plus` is a narrow vision preprocessor. It receives only the image and a fixed OCR/description prompt. It returns a textual description containing visible text, numbers, objects, and relevant layout details.

The description is passed to DeepSeek V4 Flash as attachment-derived context. Qwen does not receive the user's memory, does not decide the final answer, and cannot invoke tools. DeepSeek remains the only model that can propose agent actions. The current implementation does not wrap or sanitize the Qwen description separately, so instructions embedded in an image can influence DeepSeek and remain an accepted residual prompt-injection risk for this rollout.

If vision fails, the turn degrades safely: the bot explains that it could not inspect the image instead of inventing image contents. Text-only operation remains available.

## Data flow

Text flow:

`trusted Telegram owner -> ingress checks -> DeepSeek V4 Flash -> policy/tool boundary -> Telegram response`

Image flow:

`trusted Telegram owner -> size/type checks -> Qwen vision description -> DeepSeek V4 Flash -> policy/tool boundary -> Telegram response`

Both cloud models receive the minimum content required for their step. Provider errors can include a bounded response-body excerpt in server logs; secret scanning and log access controls reduce exposure, but provider-error redaction remains a follow-up.

## Security decisions

The existing Telegram owner allowlist, prompt-injection marking, outbound redaction, rootless containers, dropped capabilities, resource limits, loopback listener, immutable deployment, and VPN failover remain in place.

The operator explicitly chose direct `.env` storage instead of a credential-isolating model gateway. This leaves a material residual risk: IVA exposes a host-native shell and file tools, while the agent container receives the complete environment and a read-only `.env` mount. A successful prompt/tool injection could therefore attempt to read or exfiltrate the OpenCode key or other runtime credentials. Input filtering and the single-owner allowlist reduce likelihood but do not remove this risk.

Compensating controls for this rollout:

- keep the key only in the mode-`0600` production file;
- never expose the bot to untrusted Telegram identities;
- retain the current read-only Telegram userbot policy;
- treat image-derived instructions as untrusted operationally until a dedicated wrapper and regression test are implemented;
- keep command timeouts, process/resource limits, log rotation, and outbound secret redaction enabled;
- stop the model-enabled release if the key appears in logs, Git, container inspection output, or Telegram output;
- rotate the OpenCode key immediately if exposure is suspected.

Credential isolation and network/tool sandboxing remain a recommended follow-up, not part of this minimal routing rollout.

## Verification

Before deployment:

1. Run the existing provider, model-validation, Telegram media, security-defense, production Compose, and deployment-contract tests.
2. Confirm the configured model IDs are present in the current OpenCode Go catalog.
3. Validate Compose rendering without printing environment values.
4. Confirm no tracked file contains the production key or a credential-shaped fixture derived from it.

Bounded production postflight:

1. Validate the key with an authenticated model-list request without printing it.
2. Send one minimal DeepSeek V4 Flash completion with tools enabled and verify a non-empty response.
3. Send one synthetic, non-sensitive image to the vision path and verify OCR/description output.
4. Deploy through the protected `main` CI/CD path.
5. Confirm both containers are running, the agent is healthy, Telegram `getMe` matches the configured bot, and the active model shown by status is OpenCode Go / DeepSeek V4 Flash.
6. Send one benign owner-only Telegram text turn and one benign image turn; confirm real replies and inspect sanitized logs for credentials.

No fuzzing, broad red-team scan, destructive tool exercise, or adversarial production test is authorized by this design.

## Failure and rollback

- Invalid key or unavailable model: fail before deployment and leave the current release running.
- Text smoke failure: do not enable the new provider configuration.
- Vision failure: keep text replies available and report vision as unavailable.
- Runtime regression after deployment: restore the previous immutable image and switch `MODEL_PROVIDER` back to the previous non-model-enabled configuration, then restart through the controlled deploy path.
- Suspected credential exposure: stop model calls, revoke and rotate the OpenCode key, preserve sanitized evidence, and redeploy only after the exposure path is closed.

## Acceptance criteria

- Production text and tool turns use `deepseek-v4-flash`.
- Images and screenshots are described by `qwen3.7-plus`, then answered by DeepSeek.
- No premium text-model fallback occurs automatically.
- The real OpenCode key exists only in the protected server runtime configuration.
- CI, deployment, health, Telegram identity, text response, image response, and secret-leak checks all pass with fresh evidence.
- The direct-environment credential risk is recorded as accepted residual risk for this rollout.
