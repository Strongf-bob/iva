# Telegram Userbot Phone Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace QR onboarding with a private-chat phone, keypad-code, and optional 2FA flow that never sends login material to the model or vault transcript.

**Architecture:** The deterministic Telegram menu calls a narrow internal HTTP onboarding API protected by a separate poller-only bearer in container production. The sidecar remains the sole Telethon session owner and keeps phone-login state only in memory; only the read-only `login_status` tool remains model-visible.

**Tech Stack:** TypeScript/Node 24 menu engine and native `fetch`; Python 3.12, Telethon 1.44, Starlette/FastMCP sidecar; Node test runner and `unittest`.

## Global Constraints

- Login inputs must never enter Eve, the model, `daily/`, application logs, rendered screens, or persistent onboarding state.
- Phone and 2FA messages are private-chat-only and must be deleted successfully before processing; codes use callback-keypad input.
- The sidecar is the only Telethon client/session owner.
- The public states and reasons are fixed strings from the approved specification.
- One flow, five-minute TTL, three code attempts, three password attempts, bounded HTTP timeouts, and fail-closed behavior.
- QR tools, Bot API QR delivery, and QR-only configuration/dependencies are removed.
- The personal-account MCP registry stays server-enforced read-only.
- No active red-team or fuzzing runs against production.

---

## File map

- `services/telegram-userbot/onboarding.py`: focused Telethon phone-login state machine and the sole `login_status` MCP tool.
- `services/telegram-userbot/serve.py`: separately authenticated internal onboarding routes using the existing client.
- `services/telegram-userbot/test_onboarding.py`: state-machine, secret-safety, expiry, attempt-limit, and error-mapping tests.
- `services/telegram-userbot/test_health.py`: route/auth integration assertions where the ASGI boundary is exercised.
- `scripts/lib/userbot-onboarding-client.ts`: internal HTTP client, URL derivation, token loading, timeout, and fixed response validation.
- `scripts/lib/userbot-onboarding-client.test.ts`: client boundary tests.
- `scripts/lib/menu/userbot.ts`: private phone/password prompts, code keypad, state mapping, cancel, and success UI.
- `scripts/lib/menu/userbot.test.ts`: deterministic flow tests with injected onboarding client.
- `scripts/lib/menu/index.ts` and `scripts/lib/menu/menu-index.test.ts`: fail closed when Telegram cannot delete a secret input.
- `services/telegram-userbot/test_readonly_registry.py`: exact model-visible registry contract after QR removal.
- `services/telegram-userbot/requirements.in`, `requirements.lock`, `deploy/container/compose.production.yml`, `deploy/container/runtime.env.example`: remove QR delivery dependencies and configuration.
- `docs/userbot.md`, `docs/security.md`, `README.md`: phone-login instructions and accurate secret boundary.
- `docs/security/2026-08-07-userbot-phone-login-audit.md`: final focused AI-SAFE/SHAD evidence and residual risk.

### Task 1: Phone-login state machine

**Files:**

- Modify: `services/telegram-userbot/onboarding.py`
- Modify: `services/telegram-userbot/test_onboarding.py`

**Interfaces:**

- Consumes: Telethon client methods `send_code_request(phone)` and `sign_in(phone, code, phone_code_hash=sent.phone_code_hash)` / `sign_in(password=password)`.
- Produces: `PhoneLoginController.start(phone)`, `.submit_code(code)`, `.submit_password(password)`, `.cancel()`, `.status()`, each returning `{"state": str, "reason": str}`; `register_onboarding_tools(mcp, client)` registers only `login_status`.

- [ ] **Step 1: Write failing controller tests**

Add fake Telethon clients and tests proving success, 2FA, invalid/expired code, invalid password, flow expiry, cancellation, attempt caps, concurrent restart, and canary-secret absence. The core success assertion is:

```python
controller = PhoneLoginController(client, now=lambda: 100.0)
assert await controller.start("+79991234567") == {"state": "code_sent", "reason": "code_sent"}
assert await controller.submit_code("12345") == {"state": "authorized", "reason": "ok"}
assert client.sign_in_calls == [("+79991234567", "12345", "synthetic_hash")]
assert "+79991234567" not in repr(controller.public_state())
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `.venv-userbot/bin/python services/telegram-userbot/test_onboarding.py`

Expected: failure because `PhoneLoginController` does not exist.

- [ ] **Step 3: Implement the minimal locked state machine**

Use a private dataclass with `phase`, `phone`, `phone_code_hash`, `expires_at`, `code_attempts`, and `password_attempts`. Validate phone as `^\+[0-9]{8,15}$`, code as `^[0-9]{5,8}$`, and password length as `1..256`. Catch Telethon exception classes explicitly and map only to fixed reasons. Clear all private fields on success, cancel, expiry, and terminal error; never store the password.

The concrete public contract is five async methods returning `dict[str, str]`:
`start(phone: str)`, `submit_code(code: str)`,
`submit_password(password: str)`, `cancel()`, and `status()`. The implementation
must construct responses only through this fixed helper:

```python
def _result(state: str, reason: str) -> dict[str, str]:
    return {"state": state, "reason": reason}
```

- [ ] **Step 4: Run the focused Python tests and confirm GREEN**

Run: `.venv-userbot/bin/python services/telegram-userbot/test_onboarding.py`

Expected: all onboarding tests pass with no canary values in captured output.

- [ ] **Step 5: Commit the state machine**

```bash
git add services/telegram-userbot/onboarding.py services/telegram-userbot/test_onboarding.py
git commit -m "feat(userbot): add phone login state machine" -m "Replace QR token handling with a bounded in-memory Telethon phone login controller. Map failures to fixed secret-safe states and preserve only the read-only login status tool."
```

### Task 2: Bearer-protected onboarding HTTP boundary

**Files:**

- Modify: `services/telegram-userbot/serve.py`
- Modify: `services/telegram-userbot/test_health.py`

**Interfaces:**

- Consumes: `PhoneLoginController` from Task 1.
- Produces: `create_onboarding_routes(app, controller)` registering the five exact `/onboarding/phone/*` routes.

- [ ] **Step 1: Write failing ASGI route tests**

Exercise the Starlette app with a synthetic controller. Assert the MCP bearer and wrong/missing onboarding bearer return 401 before the controller runs, malformed JSON returns fixed 400, and valid requests return only `state` and `reason`.

```python
response = client.post("/onboarding/phone/start", json={"phone": "+79991234567"})
assert response.status_code == 401
assert controller.calls == []
```

- [ ] **Step 2: Run the route tests and confirm RED**

Run: `.venv-userbot/bin/python services/telegram-userbot/test_health.py`

Expected: failure because onboarding routes are absent.

- [ ] **Step 3: Register the controller and routes**

Instantiate one controller beside the one live Telethon client. Add handlers for start/code/password/cancel/status to the FastMCP Starlette app before middleware registration. Parse only a JSON object and pass one bounded string field to the controller. Select a separate onboarding bearer in the outer auth middleware and keep reconnect inside it.

- [ ] **Step 4: Run route, controller, and compile checks**

Run:

```bash
.venv-userbot/bin/python services/telegram-userbot/test_health.py
.venv-userbot/bin/python services/telegram-userbot/test_onboarding.py
.venv-userbot/bin/python -m py_compile services/telegram-userbot/onboarding.py services/telegram-userbot/serve.py
```

Expected: all pass.

- [ ] **Step 5: Commit the HTTP boundary**

```bash
git add services/telegram-userbot/serve.py services/telegram-userbot/test_health.py
git commit -m "feat(userbot): expose private phone onboarding API" -m "Add bearer-protected internal routes that drive the sole Telethon session owner without registering login secrets as model-visible MCP tools."
```

### Task 3: Secret-safe Node onboarding client

**Files:**

- Create: `scripts/lib/userbot-onboarding-client.ts`
- Create: `scripts/lib/userbot-onboarding-client.test.ts`

**Interfaces:**

- Consumes: root path, `TELEGRAM_MCP_URL`/port, and `data/telegram-userbot.token`.
- Produces: `createUserbotOnboardingClient(options?)` with `start(phone)`, `code(code)`, `password(password)`, `cancel()`, and `status()` returning `UserbotOnboardingResult`.

- [ ] **Step 1: Write failing client tests**

Assert URL rewriting from `/mcp` to `/onboarding/phone/*`, fresh token reads, bearer header, POST JSON, GET status, timeout abort, protocol rejection, strict response schema, and no canary in errors.

```typescript
assert.deepEqual(await client.start("+79991234567"), {
  state: "code_sent",
  reason: "code_sent",
});
assert.equal(request.headers.authorization, "Bearer synthetic-token");
assert.equal(
  request.url,
  "http://telegram-userbot:8724/onboarding/phone/start",
);
```

- [ ] **Step 2: Run the client test and confirm RED**

Run: `node --test scripts/lib/userbot-onboarding-client.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the minimal client**

Use native `fetch`, an `AbortController` with a 3-second timeout, and `readFile` on every call. Accept only the six fixed states and documented reasons. Throw only `UserbotOnboardingError(reason)` with a fixed reason; never interpolate input, token, response body, or transport exception.

- [ ] **Step 4: Run client tests, typecheck, and lint**

Run:

```bash
node --test scripts/lib/userbot-onboarding-client.test.ts
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit the client**

```bash
git add scripts/lib/userbot-onboarding-client.ts scripts/lib/userbot-onboarding-client.test.ts
git commit -m "feat(userbot): add internal onboarding client" -m "Call the private phone-login routes with fresh bearer credentials, bounded timeouts, strict fixed responses, and secret-free errors."
```

### Task 4: Deterministic phone, keypad-code, and 2FA menu

**Files:**

- Modify: `scripts/lib/menu/userbot.ts`
- Modify: `scripts/lib/menu/userbot.test.ts`
- Modify: `scripts/lib/menu/index.ts`
- Modify: `scripts/lib/menu/menu-index.test.ts`

**Interfaces:**

- Consumes: the Task 3 onboarding client through injectable menu dependencies.
- Produces: menu actions `login`, `digit:<n>`, `erase`, `submit_code`, `cancel_login`; secret text handlers `ubphone` and `ubpassword`.

- [ ] **Step 1: Write failing menu-flow tests**

Cover the unauthorized login button, private-chat guard, `secret:true` phone/password states, E.164 normalization, masked keypad, erase, 5-8 digit submit, fixed error copy, cancellation, 2FA, authorized refresh, and absence of canary values from rendered/logged data.

```typescript
await userbot.on("do", ["login"], state, ctx);
assert.deepEqual(state.awaitText, {
  kind: "ubphone",
  secret: true,
  data: { step: "phone" },
});
```

- [ ] **Step 2: Write the failing delete-first security regression**

In `menu-index.test.ts`, make `deleteMessage` fail and assert the secret handler is not called, the menu still waits for input, and the reply contains no secret.

- [ ] **Step 3: Run both test files and confirm RED**

Run: `node --test scripts/lib/menu/userbot.test.ts scripts/lib/menu/menu-index.test.ts`

Expected: missing phone-login actions and current fail-open deletion behavior.

- [ ] **Step 4: Implement the menu and fail-closed secret deletion**

Extend `MenuState.data.ub` with only `codeDigits?: string`. Render keypad rows `1..9`, erase/0/submit, show only `•` count, and clear digits after every submit/cancel/expiry. For `a.secret`, return before handler dispatch when Telegram deletion is not confirmed.

- [ ] **Step 5: Run menu, client, and Telegram ingress tests**

Run:

```bash
node --test scripts/lib/menu/userbot.test.ts scripts/lib/menu/menu-index.test.ts scripts/lib/userbot-onboarding-client.test.ts scripts/telegram-reply-context.test.ts
npm run typecheck
npm run lint
npm run format:check
```

Expected: all pass.

- [ ] **Step 6: Commit the menu flow**

```bash
git add scripts/lib/menu/userbot.ts scripts/lib/menu/userbot.test.ts scripts/lib/menu/index.ts scripts/lib/menu/menu-index.test.ts
git commit -m "feat(userbot): add private phone login menu" -m "Drive phone login outside the model with delete-first secret prompts and a masked callback keypad for Telegram codes. Fail closed when a secret message cannot be deleted."
```

### Task 5: Remove QR exposure and update contracts and documentation

**Files:**

- Modify: `services/telegram-userbot/test_readonly_registry.py`
- Modify: `services/telegram-userbot/requirements.in`
- Modify: `services/telegram-userbot/requirements.lock`
- Modify: `deploy/container/compose.production.yml`
- Modify: `deploy/container/runtime.env.example`
- Modify: `docs/userbot.md`
- Modify: `docs/security.md`
- Modify: `README.md`
- Create: `docs/security/2026-08-07-userbot-phone-login-audit.md`

**Interfaces:**

- Consumes: final behavior from Tasks 1-4.
- Produces: exact registry/config/dependency/release documentation contracts.

- [x] **Step 1: Change the registry test to require only `login_status` onboarding exposure**

Assert `qr_login_start`, `qr_login_status`, and `qr_login_password` are absent and `login_status` remains read-only.

- [x] **Step 2: Remove QR-only runtime inputs and dependencies**

Remove `TELEGRAM_USERBOT_BOT_API_PROXY`, sidecar `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_USER_IDS` from the sidecar environment; remove `pypng`, explicit QR-delivery `httpx` rationale, and regenerate the hash lock with the CI-pinned `uv pip compile` command from `.github/workflows/ci.yml`.

- [x] **Step 3: Update user-facing docs and focused security evidence**

Document `/menu` phone login, keypad code entry, optional 2FA, deletion behavior, QR removal, and the residual Telegram transport risk. In the focused audit, assign status to every applicable design-checkpoint SHAD family and all 18 AI-SAFE threats, with non-applicable rationale and fresh test/file evidence.

- [x] **Step 4: Run the full relevant verification suite**

Run:

```bash
.venv-userbot/bin/python services/telegram-userbot/test_guardrails.py
.venv-userbot/bin/python services/telegram-userbot/test_health.py
.venv-userbot/bin/python services/telegram-userbot/test_onboarding.py
.venv-userbot/bin/python services/telegram-userbot/test_container_supervisor.py
.venv-userbot/bin/python services/telegram-userbot/test_readonly_registry.py
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
git diff --check
```

Expected: all Linux/CI checks pass. If the two known macOS `repair-shell.test.ts` cases still fail solely because BSD `chmod` rejects `--`, record them as the unchanged environment-specific baseline and rely on green Linux CI for that file.

- [x] **Step 5: Commit the contracts and docs**

```bash
git add services/telegram-userbot deploy/container README.md docs/userbot.md docs/security.md docs/security/2026-08-07-userbot-phone-login-audit.md
git commit -m "docs(userbot): replace QR onboarding contracts" -m "Remove QR-only dependencies and runtime inputs, ratchet the read-only registry, and document the tested phone-login security boundary and residual risk."
```

### Task 6: Review, publish, deploy, and verify the live login

**Files:**

- Review all committed feature files; modify only verified findings.

**Interfaces:**

- Consumes: verified feature branch.
- Produces: reviewed PR, exact-SHA deployment, and live `ready` evidence.

- [x] **Step 1: Run `verification-before-completion` with fresh commands**

Repeat the focused Python/Node tests, typecheck, lint, formatting, build, secret scan, and `git diff --check`; record exact results and current SHA.

- [x] **Step 2: Run `requesting-code-review` and resolve only evidence-backed findings**

Review state-machine correctness, secret lifetime, delete-first behavior, route authentication, read-only registry, compose isolation, and documentation accuracy. Re-run affected tests after any correction.

- [x] **Step 3: Audit the root README before default-branch publication**

Use `beautify-github-readme` in audit mode. Update README only if phone-vs-QR behavior is still inaccurate, then run its README audit script.

- [ ] **Step 4: Push, open a PR, and require green CI**

Push `strongf/feat-userbot-phone-login`, open an English PR with Summary/Changes/Motivation/Testing/Notes, and inspect every required check.

- [ ] **Step 5: Merge and verify immutable production deployment**

Merge only after green CI. Confirm the deploy workflow used the merge SHA; verify all production container image tags, zero restarts, userbot `unauthorized` health before login, active VPN, and absence of raw onboarding data in new logs.

- [ ] **Step 6: Complete one owner-driven live login**

Ask the owner to open `/menu`, enter the real phone, use the keypad for the received Telegram code, and enter 2FA only if prompted. Verify `/healthz` becomes `ready`, `login_status` returns `connected`, the registry remains read-only, and no raw login material appears in app/userbot logs or the daily transcript.

- [ ] **Step 7: Rotate the previously exposed bot token**

The owner creates a new token in BotFather outside Iva chat. Update the production secret through a server-side private channel, redeploy/restart the bot containers, verify Telegram `getMe` and polling, and revoke the old token. Never paste either token into the issue, PR, model prompt, or logs.
