# Telegram Owner Routing Recovery Design

**Status:** design approved; written specification pending final review

## Problem

The production poller introduced registry-routed private workers while the
existing single-owner deployment still runs one legacy Eve worker on port
`8723`. Production has one configured `TELEGRAM_ALLOWED_USER_IDS` value but no
`data/control/users.json` or `data/control/legacy-owner-route.json`. The poller
therefore consumes private Telegram updates, resolves no active tenant, and
silently drops them. Container, Eve, Telegram identity, and userbot health
checks remain green because they do not verify an owner route.

## Scope

Restore service for the configured owner and every explicitly registered user.
Do not make the bot public and do not auto-enroll unknown Telegram accounts.
Preserve the existing isolation model: the owner may use the legacy worker
during migration, while users added through `iva users add` use dedicated
personal workers.

## Design

### Fail-safe legacy owner bootstrap

Before polling begins, reconcile routing state:

1. Read the strict persisted user registry and optional legacy owner route.
2. If either already contains an owner, preserve it without mutation.
3. If the registry is empty, the legacy route is absent, and the Telegram
   allowlist contains exactly one canonical numeric ID, create an active owner
   legacy route on port `8723` using the existing private atomic writer.
4. If the allowlist is empty, contains multiple IDs, contains an invalid ID, or
   the registry contains users without an owner, fail closed with a diagnostic
   error. Never guess which account is the owner.

This reconciliation is idempotent. It creates only routing control metadata and
does not move or copy vault, memory, session, integration, or userbot data. The
explicit `iva users migrate-owner` flow remains responsible for moving the
owner to a personalized worker.

### Registered users

Existing active registry records continue to route to their fixed loopback
worker ports. Blocked, provisioning, unknown, non-private, and sender/chat-ID
mismatched updates remain rejected. No behavior widens Telegram authorization.

The temporary legacy owner is the one exception to fixed loopback worker URLs.
Its routes use the trusted configured `ASSISTANT_HOST`: systemd deployments may
use loopback, while production Compose uses `http://iva:8723` across the private
container network. Dedicated personalized workers keep their registry-derived
loopback URLs. Route selection never uses Telegram message content.

### Deployment health contract

Production health must additionally prove that routing is usable:

- the effective routing registry contains exactly one active owner;
- the owner's resolved webhook and acceptance URLs use the trusted legacy
  `ASSISTANT_HOST` or the registered dedicated loopback worker port;
- the target worker health endpoint answers successfully;
- the poller stays running with zero restarts after reconciliation.

The deployment check must not send a real user message or consume Telegram
updates. A bounded production postflight will separately confirm that a fresh
owner command advances the offset, reaches a worker run, and produces a reply.

### Diagnostics

Rejected known-owner updates must no longer disappear without evidence. Startup
logs report whether routing was preserved or a legacy owner route was created,
without printing Telegram IDs, tokens, message text, or personal paths. A
configuration ambiguity stops the poller instead of consuming updates.

## Testing

Use test-driven development:

- RED: an empty registry plus one canonical allowlisted ID produces no effective
  route under the current implementation.
- GREEN: reconciliation creates one private active legacy owner route and is
  idempotent.
- Reject zero, multiple, or invalid allowlist IDs and inconsistent registries.
- Preserve an existing personalized owner and existing legacy owner route.
- Verify active registered users still resolve to their dedicated workers while
  unknown and blocked users remain rejected.
- Extend the release/deploy contract tests so a release cannot omit routing
  readiness.
- Run focused tests, the full Node suite, coverage, typecheck, lint, formatting,
  build, production contract tests, and relevant Python userbot tests.

## Production rollout

1. Apply the same idempotent reconciliation to the current production state and
   restart only the poller after validating the generated route.
2. Confirm `/menu` and `/tasks` through a fresh owner round trip.
3. Publish the tested code through the protected-main PR and required `verify`
   check.
4. Wait for CI and deployment, then confirm local `HEAD`, `origin/main`, active
   image SHA, service health, zero restarts, routing readiness, and a second
   owner round trip.

Rollback removes only the generated legacy route if it was created by this
recovery and restores the previous image through the existing deployment path.
Persistent owner data is never deleted or overwritten.

## Definition of done

- The current owner receives responses to `/menu` and `/tasks` in production.
- Every active explicitly registered user resolves to their own healthy worker.
- Unknown and blocked users cannot invoke the assistant.
- Empty single-owner legacy deployments self-reconcile without manual JSON.
- Ambiguous routing fails before Telegram updates are consumed.
- Tests and required repository checks pass from a clean worktree.
- Protected `main`, the deployed image SHA, runtime health, and round-trip
  evidence agree.
