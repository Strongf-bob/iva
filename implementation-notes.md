# Implementation notes

## Model-specific reasoning buttons

- Reimplemented the useful part of PR #34 on current `main`, while keeping its author credited in the new draft PR.
- The Telegram wizard remains the only configuration UI. A selected Codex model carries its own live reasoning levels in the in-memory flow state.
- `/models` is fetched once per screen load. No cross-process cache or generated reasoning-level file is introduced.
- Network, empty and malformed Codex catalogs fall back to `low`, `medium`, `high`. Runtime validation accepts the stable protocol set through `max`; `ultra` stays unsupported.
- Non-Codex providers skip the reasoning screen and clear the inactive global effort value when their model is saved.
- Old callbacks are rejected by both Telegram message ID and wizard step, so an earlier screen cannot mutate a later screen in the same edited message.
- Every wizard-owned network result checks object identity on both success and error; a cancelled/replaced flow cannot resurrect itself with a late response.

## Eve 0.27.8 scoped reset

- Scope: upgrade Eve to 0.27.8, preserve deterministic prompt-error terminal classification,
  and replace Telegram-wide workflow quarantine for `/new` with a reset of the exact
  Telegram continuation token.
- `/restart` must first reset the same Telegram session, then restart only `iva.service`.
  `iva reset` remains the explicit global recovery operation.
- The reset endpoint is internal to the Telegram channel and authenticates with
  `TELEGRAM_WEBHOOK_SECRET_TOKEN`; it must not use the generic `eveChannel` reset endpoint.
- The bridge already serializes Telegram updates and persists delivered update IDs. A reset
  request must not mutate run-status or queues until Eve confirms success.
- `/clear` and `/compact` are removed from bridge aliases and public docs because they have
  no distinct semantics.
- Eve 0.27.8 requires `ai ^7.0.34`; the previous 7.0.29 override was upgraded to 7.0.39
  so the framework does not run outside its declared peer contract.
- Successful resets keep an idle token tombstone. This makes a replayed group `/new`
  idempotent after a bridge crash while removing the old session id so late terminal events
  cannot mutate the new conversation state.
- Legacy private chats can reconstruct their stable token immediately. A legacy group with
  no stored event token must send `/new` as a reply to Iva's latest message once; future
  events persist the exact token automatically.
