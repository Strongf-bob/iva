# Container multi-user runtime

## Context

Iva already has a versioned Telegram user registry, per-user layouts, quotas,
private-chat routing, worker bootstrap, and systemd lifecycle commands. The
production installation, however, runs the shared assistant and Telegram poller
in Docker Compose. `iva users add` currently delegates worker lifecycle to
systemd, which is unavailable in those containers. A registry entry alone would
therefore not provide access: the gateway would route to a loopback port with no
worker listening.

This change adds a durable container lifecycle without changing the existing
systemd behavior. Its first production use is to grant ordinary-user access to
the two owner-confirmed Telegram identities resolved for `@KNFFRT` and
`@strongf_ai`.

## Goals

- Make `iva users add`, `block`, `unblock`, and `delete` work in the supported
  Docker Compose deployment.
- Run each registered user in the existing per-user filesystem, environment,
  port, quota, and permission boundary.
- Restore active workers automatically after container or host restart.
- Keep the existing legacy owner route working while ordinary users use
  personalized workers.
- Preserve the systemd lifecycle for non-container installations.
- Prove worker readiness independently before a user becomes routable.

## Non-goals

- Automatic registration from an inbound Telegram message.
- Username-based authorization in the persistent registry; numeric Telegram ID
  remains the canonical identity.
- Giving ordinary users access to the owner's personal Telegram userbot,
  credentials, host shell, or another user's data.
- Mounting the Docker socket or allowing the model to manage containers.
- Migrating the legacy owner into a personalized worker as part of this change.
- Increasing the existing ten-user limit or changing default quotas.

## Chosen approach

The `telegram-poll` container becomes a small deterministic process supervisor.
It owns the poller child and all personalized worker children, so they share the
same loopback network namespace. The supervisor never receives model input and
does not expose a network API.

This is preferable to generated Compose overrides because user lifecycle does
not require host-side YAML generation or Docker socket access. It is preferable
to migrating production to systemd because it preserves the current immutable
image, deployment, health-check, and rollback model.

## Components

### Container supervisor

A TypeScript entrypoint under `scripts/` runs as the `telegram-poll` container's
main process. It:

1. validates the container control directory and the persisted user registry;
2. starts the existing Telegram poller as a child process;
3. starts one `scripts/worker-entry.ts` child for every `active` or
   `provisioning` personalized user;
4. reconciles registry and command changes without accepting arbitrary commands;
5. records atomic, non-secret runtime status for CLI and deployment checks;
6. forwards termination signals and waits a bounded time for children to exit.

An invalid registry prevents the poller from consuming updates. An individual
worker crash does not expose another tenant: the supervisor restarts only that
user's exact registry-derived worker with bounded exponential backoff. Repeated
failures are reported as degraded runtime state and remain externally visible;
the supervisor does not silently rewrite the durable user policy.

### Local lifecycle protocol

CLI processes started with `docker compose exec telegram-poll ...` communicate
with the supervisor through a private directory under `data/control/`. Commands
are strict, versioned JSON records written atomically with mode `0600` and a
unique operation ID. Supported actions are only:

- ensure one validated registry user is started;
- ensure one validated registry user is stopped;
- pause the Telegram poller and acknowledge that it exited;
- resume the Telegram poller.

The supervisor claims each request atomically and writes a durable receipt.
Operations are idempotent, so replay after a client timeout converges on the
requested state rather than duplicating a worker. Stale or malformed requests
fail closed. User IDs, ports, paths, and roles always come from the validated
registry; request files cannot override them.

The existing CLI transaction order remains authoritative:

- `add`: create `provisioning` record -> create and verify layout -> request
  start -> exact worker health check -> mark `active`;
- `unblock`: verify layout -> mark `provisioning` -> request start -> health ->
  mark `active`;
- `block`: mark `blocked` -> request stop, retaining data;
- `delete`: block -> stop -> pause poller -> quarantine tenant data and gateway
  state -> remove registry record -> resume poller.

If the supervisor or health check does not acknowledge within its deadline, the
existing CLI rollback leaves the user blocked and preserves the partial layout
for diagnosis.

### Lifecycle selection

The Compose service sets an explicit container-lifecycle environment variable
and the supervisor control directory. `createUsersCommandDependencies` selects
the container client only when that contract is present; otherwise the existing
systemd lifecycle is unchanged. Running the users command in the wrong container
or without a reachable supervisor fails before claiming success.

### Deployment integration

Production Compose starts the supervisor instead of invoking the poller
directly. The image and poller remain unprivileged, read-only, without additional
Linux capabilities or Docker socket access. The existing shared `data` mount is
the only new communication surface.

Deployment validation requires:

- the supervisor process is ready;
- the poller child is running;
- every `active` or `provisioning` personalized worker has the expected user ID,
  port, and successful loopback health response;
- the legacy owner route remains healthy;
- no child has restarted during candidate promotion.

The initial rollout occurs while the personalized registry is empty, so the
existing healthy image remains a valid automatic rollback target. Once
personalized users exist, rollback to an image without container-worker support
must be rejected rather than silently restoring an image that cannot serve
them. Data and blocked records remain backward-readable.

## Security and isolation

- Numeric Telegram IDs are validated canonical decimal strings and never taken
  from message text or an untrusted command field.
- Workers continue to receive a per-user `HOME`, vault, runtime data, sessions,
  integrations, usage paths, allowlist, and digest chat ID.
- Non-owner workers do not receive the userbot token, owner contact sync, host
  shell, arbitrary absolute-path tools, or another user's paths.
- The supervisor uses argument arrays, not interpolated shell commands.
- Control and status directories reject symlinks and remain mode `0700`; files
  remain mode `0600`.
- Runtime status contains IDs, ports, process state, and error classes only. It
  never contains tokens, prompts, message bodies, environment dumps, or profile
  fields discovered during username resolution.

## Verification

### Automated tests

- Pure reconciliation tests for add/start, block/stop, restart recovery, and
  removal.
- Protocol tests for strict schemas, atomic claims, duplicate operations,
  malformed/stale requests, deadlines, and receipts.
- Child-process tests for bounded restart, clean shutdown, and one user's crash
  not affecting another.
- CLI tests proving container and systemd lifecycle selection and rollback.
- Existing registry, layout, routing, quota, worker bootstrap, and deletion
  tests remain green.
- Compose and release-contract tests prove the supervisor entrypoint, shared
  private control state, absence of Docker socket, and candidate health gates.
- `npm run typecheck`, `npm run build`, formatting, and the relevant full test
  suites run before publication.

### Production acceptance

1. Merge through protected `main` only after required checks pass.
2. Verify deployed SHA, image revision, supervisor, poller, legacy owner route,
   userbot, scheduler, and zero candidate restarts.
3. Resolve the two previously confirmed usernames to the same numeric IDs again
   immediately before mutation.
4. Add each as role `user` with default limits through the container-aware CLI.
5. Verify registry status `active`, private directory modes, distinct worker
   ports, exact loopback health, and supervisor status for both users.
6. Restart the poller container once and verify both workers are restored and
   healthy before declaring access durable.
7. Do not send Telegram messages on their behalf. The users can initiate their
   own private chats with the bot after access is active.

## Rollback

Before user creation, deployment failure restores the prior healthy image using
the existing release transaction. After user creation, application rollback is
allowed only to an image advertising compatible container-worker support. To
remove access, `iva users block <id>` stops routing while retaining data;
`delete` remains the explicit quarantine operation and is not part of automatic
rollback.
