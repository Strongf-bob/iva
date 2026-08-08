# Telegram userbot phone login design

## Goal

Replace the unreliable QR onboarding path with a deterministic private-chat flow:
phone number, Telegram login code, and an optional 2FA password. None of those
values may reach the model, Eve turns, the vault transcript, application logs, or
persistent onboarding state.

The existing server-enforced read-only userbot tool allowlist remains unchanged.
Only the onboarding mechanism changes.

## Chosen approach

Iva will use the existing deterministic `/menu` engine and a narrow bearer-protected
HTTP onboarding API on the userbot sidecar.

Alternatives considered:

1. **Dedicated onboarding API plus menu flow (chosen).** The menu talks directly to
   the sole Telethon session owner. Login secrets never become model-visible MCP tool
   arguments. This preserves the single-session invariant and provides the smallest
   security boundary.
2. **Phone-login MCP tools called by the agent.** This reuses the MCP transport, but
   exposes code/password-shaped tool schemas to the model and makes accidental tool
   invocation or argument retention more likely. Rejected.
3. **Interactive server CLI.** Standard Telethon login would be simple, but it requires
   SSH and does not meet the chat-only product requirement. Rejected.

## User experience

The user opens `/menu` -> `Telegram-userbot`. When the sidecar is enabled but the
account is unauthorized, the screen displays a `Войти по номеру` button.

1. The bot asks for the phone number in a private chat. The menu engine marks the
   input as `secret:true`, deletes the Telegram message before processing it, validates
   an E.164-style value, and sends it directly to the onboarding API.
2. Telegram sends a login code to the user's official Telegram application. Iva shows
   an inline numeric keypad. Digits are callback inputs, not chat messages. The current
   masked length is shown; the code itself is never rendered. `Готово` submits a code
   of 5-8 digits, and `Стереть` clears the in-memory keypad buffer.
3. If Telegram requires 2FA, the menu asks for the password using `secret:true`; the
   message is deleted before the password is sent directly to the sidecar.
4. On success, the same live Telethon client becomes authorized and its existing
   private SQLite session persists the login. The screen changes to `готов` without a
   service restart.
5. `Отмена` clears transient state in both processes. A flow also expires after five
   minutes and requires a new code request.

The UI never asks the user to send a code or password in ordinary conversation. If
Telegram message deletion fails, Iva warns the user to delete it manually but does not
forward the value to Eve or the model.

## Architecture and data flow

### Menu process

`scripts/lib/menu/userbot.ts` owns the deterministic UI state. It gains injected
onboarding-client methods for start, submit-code, submit-password, cancel, and status.
The default implementation lives in a focused module under `scripts/lib/` and:

- reads the existing `data/telegram-userbot.token` for every request;
- derives the onboarding URL from `TELEGRAM_MCP_URL` or the local MCP port;
- accepts only `http:` or `https:` URLs;
- applies short request timeouts;
- returns fixed state/reason values and never includes response bodies in thrown errors.

The Node menu state may transiently hold keypad digits and the current phase. It does
not retain the phone number or password after forwarding them, and the flow TTL clears
any abandoned keypad buffer.

### Userbot sidecar

The sidecar remains the only owner of the Telethon client and SQLite session. It adds
bearer-authenticated internal routes alongside `/mcp` and `/healthz`:

- `POST /onboarding/phone/start` with `{phone}`;
- `POST /onboarding/phone/code` with `{code}`;
- `POST /onboarding/phone/password` with `{password}`;
- `POST /onboarding/phone/cancel`;
- `GET /onboarding/phone/status`.

The routes use the same middleware and internal-only network exposure as MCP, but a
separate onboarding bearer. In container production its named volume is mounted only
into the deterministic poller and sidecar, not the model/agent container. The routes
are not registered as MCP tools. Phone onboarding is disabled in host-native mode,
which cannot provide the same process-level credential isolation; an existing
authorized session remains usable there.

The sidecar holds one in-memory onboarding record containing phase, normalized phone,
`phone_code_hash`, expiry, and attempt counters. It uses:

- `client.send_code_request(phone)` to request a code;
- `client.sign_in(phone, code, phone_code_hash=...)` to verify it;
- `client.sign_in(password=password)` only after
  `SessionPasswordNeededError`.

All state mutations are protected by one async lock. Starting a new flow atomically
invalidates the old flow. Success, cancellation, expiry, and terminal failure wipe the
phone, code hash, counters, and password references. The password is never assigned to
persistent state.

### Removal of the QR path

QR start/password tools and Bot API QR delivery are removed from the onboarding
registry. `login_status` remains a read-only MCP tool so the agent can detect whether
personal Telegram is connected. QR-only dependencies and configuration are removed
when no longer referenced.

## State machine

The public states are fixed strings:

- `idle`
- `code_sent`
- `password_needed`
- `authorized`
- `expired`
- `error`

Fixed reason codes distinguish user-actionable failures without exposing Telethon
messages:

- `phone_invalid`
- `phone_flood_wait`
- `code_invalid`
- `code_expired`
- `password_invalid`
- `attempt_limit`
- `flow_missing`
- `transport_failed`

The UI maps these codes to Russian/English guidance. Raw exceptions, phone numbers,
code hashes, login codes, passwords, bearer tokens, and session contents are never
returned or logged.

## Validation, abuse limits, and recovery

- Phone input is normalized to `+` followed by 8-15 digits; other characters are
  rejected before the sidecar call.
- Login codes accept only 5-8 digits and are entered through callback buttons.
- Password input is non-empty and capped at 256 Unicode characters.
- Only one flow may exist. A maximum of three invalid-code attempts and three invalid
  2FA attempts are allowed per flow.
- A new code request is rate-limited locally; Telegram `FloodWaitError` is mapped to a
  fixed retry-later state without sleeping inside the poll loop.
- Client and server Telethon operations have bounded timeouts and fail closed.
- The existing `telegram-userbot.enabled` marker remains the operational kill switch;
  turning the feature off stops access to the session and onboarding endpoints.
- Code rollback reuses the existing private session volume; no data migration is
  required.

## Security design checkpoint

The applicable AI-SAFE/SHAD requirements for this change are:

| Surface                                            | Design control                                                                          | Required verification                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `YAISAFE.INPUT.1`, SHAD-IO-01/04                   | Onboarding is a deterministic menu flow and bypasses the model                          | Ordinary chat input cannot invoke a secret handler without active owner-bound menu state                   |
| `YAISAFE.EXEC.1/4`, SHAD-TOOL-01/06                | Routes are not MCP tools; Telegram owner allowlist plus a poller-only onboarding bearer | Foreign user/callback, MCP bearer, and missing/wrong onboarding bearer are denied                          |
| `YAISAFE.DATA.2`, SHAD-ID-03/04                    | Delete-before-process, keypad code entry, fixed errors, no raw-value logs               | Canary phone/code/password absent from Eve input, daily transcript, stdout/stderr, errors, and rendered UI |
| `YAISAFE.INPUT.2`, `YAISAFE.INFRA.2`, SHAD-EXEC-03 | Single flow, TTL, attempt caps, cooldown, request timeouts                              | Repeated starts/codes reach a bounded fixed denial without spawning work                                   |
| `YAISAFE.INFRA.1`, SHAD-EXEC-04/05                 | Locked dependencies, immutable image, CI and verified deploy                            | Existing dependency-lock and release-contract checks remain green                                          |
| SHAD-OPS-02/03/04                                  | Enable marker kill switch, fail-closed client, existing rollback                        | Disabled/missing-token/unreachable sidecar cannot accept login material                                    |

No active red-team or fuzzing against production is part of this feature. Native unit
and integration tests are the minimal sufficient evaluation method because the risks
are authorization, secret handling, state transitions, and transport boundaries rather
than model refusal behavior.

Residual risk: Telegram necessarily transports the bot message containing the phone or
2FA password before deletion, and deletion is not equivalent to end-to-end secret
erasure from Telegram infrastructure. The login code avoids this extra chat-message
exposure through the keypad, but the safest possible alternative remains an operator-run
CLI over SSH. This trade-off is explicit for the requested chat-only experience.

## Testing

### Python sidecar tests

- successful phone -> code -> authorized flow on one fake client;
- code -> `password_needed` -> authorized flow;
- invalid/expired code and invalid password map to fixed reason codes;
- flow expiry, cancellation, attempt caps, and concurrent starts wipe old state;
- bearer middleware protects every onboarding route;
- canary secrets never appear in state responses or captured logs;
- QR tools are absent and `login_status` remains read-only.

### TypeScript menu/client tests

- unauthorized screen exposes `Войти по номеру`;
- phone and password waits are `secret:true` and private-chat-only;
- phone validation, masked keypad, erase, submit, cancel, expiry, 2FA, and success;
- client uses the internal onboarding route, fresh bearer token, strict URL handling,
  timeout, and fixed error mapping;
- canary values are absent from rendered screens and logged errors;
- menu index still deletes secret text before dispatch and never sends it to Eve.

### Release verification

- focused tests, full userbot suite, typecheck, lint, formatting, and production
  release-contract tests;
- CI and immutable-image deploy for the exact merge SHA;
- production container SHA, health, restart count, read-only registry, and log scan;
- one live owner-driven login attempt, with the user entering the real Telegram code,
  ending in `ready` or a precise fixed failure state.

## Definition of done

- The owner can connect the personal Telegram account through `/menu` using phone and
  code, plus 2FA when required.
- No onboarding value reaches the model or vault transcript.
- QR onboarding is no longer exposed.
- The resulting personal-account MCP registry remains read-only.
- Tests and security checks pass, the verified merge SHA is deployed, and production
  reports `ready` after the user's live login.
