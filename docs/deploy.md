# Deploy

Iva runs on one VPS either as the production Compose stack or as a host-native systemd installation. Both modes use a Telegram gateway and isolated per-user state. A legacy single-user host installation keeps `iva.service` until the owner migration is run. `install.sh` sets the base installation up ([install](./install.md)); this page is what's actually running and how to operate it.

## Transport: long polling

Telegram never connects to your server. The permanent `scripts/telegram-poll.mjs` entry shim starts the TypeScript bridge in `scripts/poller/main.ts`, which long-polls `getUpdates` and POSTs each update to the local eve webhook (`http://127.0.0.1:8723/eve/v1/telegram`) with the shared `X-Telegram-Bot-Api-Secret-Token` header. Telegram sees an ordinary bot; the channel code is unchanged. No public HTTPS, no domain, no reverse proxy.

The bridge also gives you:

- 📬 **Ordered delivery** — advances the offset (`data/telegram-offset.json`) only after eve replies 2xx, retrying with backoff up to 15s while the server boots.
- ⏱ **Per-chat pacing** — a 1.5s pause between updates to the same chat, so a burst can't start two runs on one session.
- 🛟 **Out-of-band recovery** — a handful of slash commands (`/restart` and friends) are handled by the bridge itself, so they work even when the agent is stuck. Which ones, and what they do: [cli.md](./cli.md).

On a legacy single-owner installation, polling starts only after it has a usable owner route. If the user registry is still empty and `TELEGRAM_ALLOWED_USER_IDS` contains exactly one valid ID, the bridge creates the private legacy route to the existing Eve worker automatically. Empty or ambiguous allowlists and incomplete registries fail closed before Telegram updates are consumed. Container deployments additionally probe that resolved owner route before promoting a new image.

### Webhook mode (alternative)

Polling and webhook are mutually exclusive — the bridge calls `deleteWebhook` on start. If you do have a public HTTPS endpoint, disable the bridge and register the webhook:

```bash
systemctl --user disable --now iva-telegram-poll
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-domain>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

Note: `getUpdates` — which the setup wizard uses to discover your user ID — stops working while a webhook is registered.

## Production containers

`deploy/container/compose.production.yml` runs four bounded services from the same
production image: `iva`, `telegram-poll`, `reminder-scheduler`, and the read-only
`telegram-userbot` sidecar. The scheduler is the durable runtime for user-created
one-off and recurring reminders; it shares `./data` with the gateway and sends only
through the bot to each registry user's private chat. See its stable data, tool, CLI,
retry, and recovery contracts in [scheduler.md](scheduler.md).

Set `IVA_IMAGE` and `IVA_ENV_FILE`, then render and start the stack:

```bash
IVA_IMAGE=ghcr.io/owner/iva:version \
  docker compose -f deploy/container/compose.production.yml config
IVA_IMAGE=ghcr.io/owner/iva:version \
  docker compose -f deploy/container/compose.production.yml up -d
docker compose -f deploy/container/compose.production.yml ps
```

The image pins Google Workspace CLI instead of resolving a floating release. Verify the
installed binary and scheduler heartbeat inside the deployed image:

```bash
docker compose -f deploy/container/compose.production.yml exec iva gws --version
docker compose -f deploy/container/compose.production.yml exec reminder-scheduler npm run scheduler:health
```

In container mode `/menu` stores Google OAuth files beneath the selected user's private
`HOME`, so users never share `~/.config/gws`. Maintenance runs doctor, vault cleanup,
and memory work as attached per-user processes. It does not call systemd or control the
Docker daemon. The Update screen therefore shows host-side lifecycle guidance:

```bash
docker compose -f deploy/container/compose.production.yml pull
docker compose -f deploy/container/compose.production.yml up -d
docker compose -f deploy/container/compose.production.yml ps
```

Keep exactly one `reminder-scheduler` replica for a data mount. Container health is the
authoritative scheduler status; `data/control/reminder-scheduler-status.json` is the
persisted diagnostic evidence shown by `/menu`. The forced release script requires the
candidate image to contain the scheduler and checks a healthy zero-restart scheduler
container before activation. If it must roll back to an older pre-scheduler image, it
removes the unsupported scheduler service and verifies the legacy three-service runtime
instead of claiming that the new foundation is active.

## systemd units

`scripts/cli/systemd.ts` is the single source of truth for every unit; the permanent `bin/iva.mjs` entry shim delegates to the TypeScript CLI. Any restart through the `iva` CLI regenerates the units first, so `Environment=PORT` always matches `IVA_PORT` in `.env`. Don't hand-edit `~/.config/systemd/user/iva-*` — edits get overwritten. If you write your own unit instead, bake the port literally (`Environment=PORT=8723`): systemd will not expand `$IVA_PORT` from an `EnvironmentFile`.

The unit starts eve with `--host 127.0.0.1`, and a hand-written one must do the same. Setting `HOST` in the environment is insufficient because `eve start` overwrites `HOST`/`NITRO_HOST` for the process it spawns. Iva also requires the generated `ASSISTANT_BEARER` on Eve session routes. `localDev()` is included only under `eve dev`, which sets `EVE_DEV=1`; production does not use the client-controlled `Host` header as authentication.

The two controls cover different failure modes: loopback binding removes direct network reachability, while the bearer protects against another local process, SSRF, or a reverse proxy reaching the port. `iva doctor` repairs a missing bearer, `.env` permissions, and an old process still listening beyond loopback.

For a direct smoke test, load the secret without printing it and pass the header to curl through stdin rather than the process arguments:

```bash
ASSISTANT_BEARER="$(node --env-file=.env -p 'process.env.ASSISTANT_BEARER')"
IVA_PORT="$(node --env-file=.env -p 'process.env.IVA_PORT || 8723')"
printf 'header = "Authorization: Bearer %s"\n' "$ASSISTANT_BEARER" |
  curl --fail-with-body --config - \
  -X POST "http://127.0.0.1:${IVA_PORT}/eve/v1/session" \
  -H "content-type: application/json" \
  -d '{"message":"Reply with exactly: auth ok"}'
unset ASSISTANT_BEARER IVA_PORT
```

| Unit                           | When             | Job                                                              |
| ------------------------------ | ---------------- | ---------------------------------------------------------------- |
| `iva-worker-<id>.service`      | each active user | isolated Eve worker with personal HOME, vault, data and port     |
| `iva-telegram-poll.service`    | always           | long-polling gateway, private-chat routing and per-user quotas   |
| `iva-telegram-userbot.service` | owner opt-in     | owner-only Telethon userbot proxy — see [userbot.md](userbot.md) |
| `iva-memory-doctor.timer`      | 05:00 nightly    | schema/health/decay/MOC checks + vault `git push`                |
| `iva-update-check.timer`       | 10:00 daily      | check for a newer stable Iva version; notify once per version    |

### Enabling isolated users on an existing server

Build the authored agent code before starting personalized workers, then migrate the current owner explicitly:

```bash
npm run build
iva users migrate-owner 123456789
iva users add 987654321
iva restart
iva users list
```

The migration verifies copied files by size and SHA-256 and retains its backup in `data/migration-backups/`. It registers the candidate as non-routable `provisioning`, disables the legacy `iva.service`, starts the personalized owner worker, probes that worker's exact loopback health route, then activates routing. A readiness failure removes the provisional registry entry, restores and health-checks the legacy service, and installs a private owner-only route to its old port before polling resumes, so Telegram remains usable and the same migration command can be retried. The temporary legacy route deliberately bypasses personalized quota reservations because the old worker cannot release them; it is owner-only and should exist only until the migration is retried. If any rollback step or legacy health check fails, polling stays paused instead of consuming updates without a proven destination. Do not remove the backup until the personalized owner worker, vault, Google access and schedules have been verified. Blocking a user preserves their directory and gateway state; deletion pauses the poll gateway while it moves both personal data and tenant-scoped queue, quota, run-status and reset state to a stable transaction directory under `data/quarantine/`, then resumes service. An interrupted deletion resumes that same transaction on retry; it is deliberately not an erasure operation.

The gateway accepts registered users only in one-to-one private chats and routes each update to that user's fixed loopback worker port. Worker services receive a personal `HOME`, data directory, vault and Eve session directory. The model-facing shell is disabled for every personalized worker, including the owner; server operations remain available only to someone who can log in to the host.

The doctor and update-check timers stay on systemd on purpose: they're watchdogs that must keep running even if the agent process itself is wedged. `iva-memory-doctor.timer` embeds `ASSISTANT_TIMEZONE` directly, so its 05:00 schedule remains correct even when the server clock uses UTC — as do the eve schedules below (`Environment=TZ` in `iva.service`). Setting the server's own system timezone to match is therefore optional, not required for anything in this doc to work correctly:

```bash
# Optional — the generated units and the eve schedules already carry ASSISTANT_TIMEZONE
# themselves, so this only affects OTHER things that read the system clock (log
# timestamps, cron jobs you add yourself, etc.). `node --env-file` parses .env as plain
# KEY=VALUE pairs — unlike `source`, it never shell-interprets its contents, so a stray
# `$(...)` or backtick sitting in .env can't execute anything.
ASSISTANT_TIMEZONE="$(node --env-file=.env -p 'process.env.ASSISTANT_TIMEZONE || ""')"
[ -n "$ASSISTANT_TIMEZONE" ] && sudo timedatectl set-timezone "$ASSISTANT_TIMEZONE"
```

### Memory rollups, digest, and proactive reviews: in-process eve schedules

The background cadences run as `agent/schedules/*.ts` — eve's native `defineSchedule` API — inside the `iva.service` process itself:

| Schedule            | Cron (local time)           | Job                                                                                                                       |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `memory-daily`      | `0 4 * * *` (04:00 nightly) | transcript → cards + daily summary, report to Telegram                                                                    |
| `memory-weekly`     | `15 4 * * 1` (Mon 04:15)    | 7 dailies → weekly summary, report to Telegram                                                                            |
| `memory-monthly`    | `20 4 1 * *` (1st, 04:20)   | weeklies → monthly summary (silent)                                                                                       |
| `memory-yearly`     | `25 4 1 1 *` (Jan 1, 04:25) | monthlies → yearly summary (silent)                                                                                       |
| `digest`            | `0 8 * * *` (08:00 daily)   | morning digest — **off by default**, enable via `digestSchedule.enabled` in `data/settings.json`                          |
| `proactive-reviews` | `*/5 * * * *` (every 5 min) | owner-only prepare/deliver reconciler — **off by default**, enable via `proactiveReviews.enabled` in `data/settings.json` |

Each memory row is a thin spawner (`scripts/lib/schedule-runner.ts`): it runs the exact same command the old timer did (`flock -w 900 .memory.lock node --env-file=.env scripts/memory/rollup.ts <period>`), under a hard timeout, and records the outcome to `data/rollup-status.json`. The digest and proactive reconciler use the same bounded schedule runner with their own fixed TypeScript entry points. `iva.service` sets `Environment=TZ` from `ASSISTANT_TIMEZONE` (`ivaServiceBody()` in `scripts/cli/systemd.ts`), so cron expressions above tick in the configured local time, not the host's system TZ — Nitro's schedule runner carries no timezone of its own otherwise.

The proactive reconciler is deliberately idempotent rather than a one-shot 08:00 job: it prepares immutable versions ahead of time, claims persisted delivery records at the due time, retries only definite failures, and recovers missed runs inside bounded windows. An ambiguous Telegram outcome is retained for operator inspection and never guessed or resent. Its provider boundary is documented in [configuration](./configuration.md#proactive-reviews-owner-only).

Nitro's scheduled-task runner has no `Persistent=true` equivalent, so a period missed while the server was down does **not** auto-fire on its own. `scripts/lib/schedule-migration.ts` replaces that: on every server start it compares each period's last recorded success against its most recent scheduled point and, if it's stale and still within a grace window (20h daily / 3d weekly / 7d monthly / 14d yearly), runs it once. A brand-new install seeds a baseline and runs nothing on its first boot, so installing never triggers an immediate storm of catch-up jobs. The same start-up hook also retires the old `iva-memory-{daily,weekly,monthly,yearly}.{service,timer}` units on any existing install, by exact name only — any unrelated timer you've set up yourself is left alone.

Manual runs and status:

```bash
npm run memory -- daily   # or weekly | monthly | yearly
npm run doctor
systemctl --user list-timers                             # doctor, update-check (the only two systemd timers left)
systemctl --user status iva.service iva-telegram-poll.service  # the two always-on services
cat data/rollup-status.json                               # last run per eve schedule (or: /menu → ⏰ in Telegram)
iva logs                  # agent; `iva logs poll` for the bridge
```

The update check fetches the configured Git upstream without calling the model. It stays silent when the installed stable version is current, when the same version was already offered, or when Telegram is not configured. A newer `MAJOR.MINOR.PATCH` release produces one message in `TELEGRAM_DIGEST_CHAT_ID` (falling back to the first trusted user) with **Update** and **Later** buttons. Errors are journal-only and retry on the next timer run.

Full CLI reference: [cli](./cli.md). What the rollups actually write: [memory](./memory.md).

## nginx and TLS

You need neither for Telegram - polling is outbound-only. If you expose the Telegram webhook, proxy only `/eve/v1/telegram`; that route verifies `X-Telegram-Bot-Api-Secret-Token` and the Telegram user allowlist.

Exposing the Eve HTTP channel is a separate security decision. Require HTTPS and preserve the `Authorization: Bearer ...` header so Iva can verify `ASSISTANT_BEARER`. Never remove the bearer check merely because the proxy connects to `127.0.0.1`: loopback describes the proxy-to-Iva hop, not the original caller.

## Moving servers

Your state is three things: the vault (its own git repo, pushed nightly by the doctor), `.env` (all keys), and `data/` (`tasks.json`, `usage.jsonl`).

1. Old box: `npm run doctor` to push the vault, then copy `.env` and `data/` off.
2. New box: run the installer ([install](./install.md)) with `--skip-setup`, drop in `.env`.
3. Clone the vault back — `gh repo clone <user>/iva-vault <vault-dir>` — restore `data/`, then `iva restart`.

If all you have left is the vault repo, you lose open tasks and token history. Memory survives intact.

## Vercel (advanced)

Iva is built on eve, which deploys to Vercel natively — but self-host is the intended path. If you go there anyway:

- **Schedules** — `defineSchedule` in `agent/schedules/*.ts` becomes a real Vercel Cron Job (cron times are UTC there).
- **Storage** — `./data` is ephemeral on Vercel; tasks and usage logs need a real DB or KV store.
- **Auth** - Eve routes accept Vercel OIDC or `ASSISTANT_BEARER`. `localDev()` is enabled only by `eve dev`; configure the bearer as a Vercel secret for any non-OIDC caller.
