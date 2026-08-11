# Telegram userbot (beta, opt-in)

> 🧪 **Beta — expect bugs.** This feature is new and still rough: onboarding steps or tool
> calls can misbehave. Set it up **at your own risk** and don't lean on it for anything
> critical yet. Feedback and issues welcome.

![Your secretary inside Telegram: the userbot reads group chats from your own account, collects summaries and replies as you, with a server-enforced anti-ban guardrail](../assets/iva-userbot.webp)

Iva can connect to your **personal Telegram account** (a userbot), not just the
bot. This fork's production deployment exposes only an explicit server-side
allowlist of read/search tools plus a read-only login-status probe. It talks to a small proxy —
`services/telegram-userbot/serve.py` — that owns one Telethon session and exposes
Telegram over an internal Compose network. Iva connects to it natively
(`agent/connections/telegram-userbot.ts`).

> ⚠️ **Account-ban risk.** Automating a personal account violates Telegram's ToS and can
> get the account **banned** — especially for sending. Reading is far safer.
>
> A **built-in anti-ban guardrail is enforced server-side** (`guardrails.py`) — not just
> advice: FloodWait compliance (wait ×1.3, retry once), a randomized delay after every send
> (fixed-interval bots get flagged), and a circuit-breaker that pauses sending after 3
> FloodWaits in 24h. It wraps `send_message`, `send_file` and `forward_messages` — the agent
> cannot talk past those. Raw-API writes (joins, invites, contact imports, reactions) are not
> wrapped: their limits live in the skill file, which is a prompt, so treat them as advisory.
> Limits are still per-account, so behave like a human. Full rules: `agent/skills/telegram-userbot/safety.md`.

## Connect — just chat with the bot

You never touch a terminal. Open `/menu` → **Telegram-userbot** and complete the
private flow:

1. It warns you (at your own risk) and, the first time, walks you through creating an app at
   <https://my.telegram.org> → **API development tools** — enter the `api_id` / `api_hash`
   only in the menu's secret steps. In the container deployment, the bot writes them to a private runtime
   file under `data/` and flips an explicit enable marker; it never modifies the read-only
   `/app/.env` mount.
2. Press **Log in by phone**, then send the account phone number in international format. The
   bot deletes that message before processing it. If deletion fails, the flow stops.
3. Enter the code Telegram sends using the masked inline keypad. Digits never appear in a chat
   message. A code request has a local 30-second cooldown, the flow expires after five minutes,
   and invalid code/password attempts are capped at three.
4. If the account has 2FA, send the password only when the secret menu step asks for it. That
   message is also deleted before processing. The resulting Telethon session persists on the
   server, so successful onboarding is one-time.

> [!WARNING]
> Phone, `api_hash`, and 2FA messages still pass through Telegram's Bot API transport and can
> briefly exist in the poller's durable inbound queue before the deterministic menu handler
> deletes them. Deletion is not cryptographic erasure. They are never forwarded to the model or
> written to the daily log by the menu. Use only the private owner chat and rotate a password if
> you suspect the bot transport or host was exposed.

## Manual commands (optional — the agent runs these for you)

```bash
iva userbot creds    # store api_id + api_hash in the active runtime's private state
iva userbot setup    # enable the active runtime (idempotent)
iva userbot status   # shared service, proxy and Telegram-login health
iva userbot diagnose --json  # read-only machine-readable health
iva userbot off      # stop and disable the proxy
```

The health state is one of `off`, `starting`, `unreachable`, `unauthorized` or
`ready`. CLI and Telegram use the same 1.5-second probe. It checks the existing
proxy's `/healthz` route, which reads authorization from the proxy's one live
Telethon client and never opens another session. Diagnostics expose only fixed
state/reason values; bearer tokens and transport errors are not returned.

## Safety knobs

- Production fixes `TELEGRAM_EXPOSED_TOOLS=read-only` in Compose — the proxy uses a local
  fail-closed allowlist rather than trusting upstream annotations. Sending, editing,
  deleting, joining, inviting, reacting, and invite-link export tools are absent.
- If the host blocks direct Telegram MTProto traffic, set
  `TELEGRAM_USERBOT_PROXY_TYPE`, `TELEGRAM_USERBOT_PROXY_HOST`, and
  `TELEGRAM_USERBOT_PROXY_PORT` (plus optional `TELEGRAM_USERBOT_PROXY_RDNS`). Compose passes
  only these narrow SOCKS settings to the sidecar; it still does not mount the full runtime
  `.env`. On this rootless production host the working values are `socks5`, `10.0.2.2`, and
  `7891`; other hosts must use an address their containers can reach.
- `TELEGRAM_MCP_PORT` defaults to `8724`. If you set a custom port,
  run `iva userbot setup` (restarts the proxy) **and** `iva restart` (iva reads the port from
  its env at start) so both agree.
- The MCP bearer lives in `data/telegram-userbot.token` (0600). Phone onboarding uses a
  different bearer. In container production that credential lives in a named volume mounted
  read-only into `telegram-poll` and read-write into the sidecar; it is not mounted into the
  model/agent container. Phone onboarding is disabled in host-native systemd mode because it
  cannot provide the same process isolation; an already-authorized session remains usable.
- In production, the sidecar alone mounts the named volume containing the Telethon session.
  It has no published port, no `.env`, memory, vault, or Eve-state mount, and its root
  filesystem is read-only. Removing `data/telegram-userbot.enabled` is the kill switch.

## Automatic contact graph

When the personal account becomes authorized, Iva starts a full read-only import of every accessible
private chat, group and channel. It processes at most three chats in parallel and makes at most one
model request per chat in each sync. If all unseen messages do not fit the configured model context,
the userbot keeps the newest complete messages, restores chronological order for analysis and reports
how many older unseen messages were skipped. The account-scoped cursor advances only after durable
graph and question-workbook writes, so the 15-minute schedule performs incremental syncs safely.

The pipeline creates Markdown contact, chat and project cards in the normal vault. A numeric Telegram
user ID is the identity key, so the same person in a direct message and several groups links to one
card. Every material observation keeps message-level provenance and confidence. Mentions and claims
about the account owner build the owner's contact card too, but group-derived claims never update
`CORE.md` automatically. Voice messages and video notes are counted and marked as unsupported media;
their contents are not interpreted by this pipeline.

The same model response can include evidence-bound clarification questions. Iva deduplicates and
groups them by chat in `vault/inbox/contact-analysis-questions.md`, with an `**Answer:**` area under
each question. Later syncs preserve text written in those answer areas. Answer ingestion is not part
of this pipeline yet.

Contact analysis is available only with `TELEGRAM_EXPOSED_TOOLS=read-only`. The agent normally runs
these commands for you, but they are useful for diagnosis:

```bash
node --env-file-if-exists=.env scripts/contact-analysis.ts sync
node --env-file-if-exists=.env scripts/contact-analysis.ts status --json
```

`status` reads local checkpoints only; it does not call Telegram or a model. Runtime state lives under
`data/contact-analysis/` and never stores message bodies.

The ordinary sync is intentionally optimized for recent changes and does not prove complete historical
coverage. For a one-time rebuild of human-readable private-chat profiles, first run a model-free dry run,
then apply with a new private backup directory outside both the vault and application checkout:

```bash
node --env-file-if-exists=.env scripts/contact-analysis.ts rebuild-private --dry-run --json
node --env-file-if-exists=.env scripts/contact-analysis.ts rebuild-private --backup-dir /absolute/private/backup/run-1 --run-id run-1 --json
node --env-file-if-exists=.env scripts/contact-analysis.ts rebuild-status --json
```

The applying command is resumable and processes only one-to-one human chats, oldest first, through a
fixed per-chat high-water mark. It verifies and expands the backup before every exact write set, hands
the high-water to incremental sync only after completion, and retains the backup. A rollback is
conflict-aware and requires the exact account run reported by status:

```bash
node --env-file-if-exists=.env scripts/contact-analysis.ts rebuild-rollback --backup-dir /absolute/private/backup/run-1 --run-id run-1
```

Relationship intelligence does not widen this boundary. It consumes only already validated
GET-export observations and adds no personal-account Telegram operation. CRM rendering, dossiers,
reply suggestions, commitment confirmation, and bot-delivered owner reports do not expose send,
reaction, delete, join, invite, or mark-read capabilities through the userbot.

## How it works

- **One session owner.** Exactly one process may own a Telethon session; a second opener
  desyncs MTProto. The proxy is that owner; iva calls it over HTTP.
- **Separate onboarding authority.** Read-only MCP and phone-login routes use different
  bearers. Only the deterministic poller/menu process receives the onboarding bearer in
  container production, so shell tools in the model container cannot call phone/code/2FA routes.
- **Session-less boot.** With no session yet, the proxy comes up unauthorized. Private,
  bearer-protected HTTP routes authorize the same live client in place by phone, code, and
  optional 2FA; the model-visible MCP registry exposes only read-only `login_status`.
- **Enforced production read-only registry.** Upstream tools are pruned to the reviewed
  local allowlist before onboarding tools are added. CI enumerates the effective registry
  and rejects mutating tool families.
- **Bounded analysis export.** Four bearer-protected, GET-only internal routes expose normalized
  account, dialog, chronological-message and newest-window projections to the contact pipeline
  without opening a second Telethon client.
- Built on [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) `v3.2.0`
  (116 tools), pinned in `services/telegram-userbot/requirements.txt`.
