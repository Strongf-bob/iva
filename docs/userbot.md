# Telegram userbot (beta, opt-in)

> 🧪 **Beta — expect bugs.** This feature is new and still rough: onboarding steps or tool
> calls can misbehave. Set it up **at your own risk** and don't lean on it for anything
> critical yet. Feedback and issues welcome.

![Your secretary inside Telegram: the userbot reads group chats from your own account, collects summaries and replies as you, with a server-enforced anti-ban guardrail](../assets/iva-userbot.webp)

Iva can connect to your **personal Telegram account** (a userbot), not just the
bot. This fork's production deployment exposes only an explicit server-side
allowlist of read/search tools plus QR onboarding. It talks to a small proxy —
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

You never touch a terminal. Tell the bot **«подключи мой телеграм»** and it does everything
for you, in chat:

1. It warns you (at your own risk) and, the first time, walks you through creating an app at
   <https://my.telegram.org> → **API development tools** — you paste the `api_id` / `api_hash`
   back into the chat. In the container deployment, the bot writes them to a private runtime
   file under `data/` and flips an explicit enable marker; it never modifies the read-only
   `/app/.env` mount.
2. It renders a QR and sends it as an image into your chat. Scan it in the Telegram app of the
   account you're connecting: **Settings → Devices → Link Desktop Device**. Each attempt sends
   exactly one short-lived QR. Scan only the newest image; if its status becomes `expired`, ask
   the bot to connect again so it creates a fresh code.
3. If you have 2FA, it asks for your password (change it afterward if you'd rather it not pass
   through chat). Done — the session persists on the server, so this is one-time.

> [!WARNING]
> Whatever you type in the chat is stored verbatim in that day's `daily/` log, `api_hash` and
> 2FA password included, and it passes through the model like any other message. After
> connecting, delete those lines from the daily file — and if you sent a 2FA password, change
> it. There is no separate secure channel for this yet.

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
- QR delivery through the bot API can use the separate
  `TELEGRAM_USERBOT_BOT_API_PROXY`; this production host uses the HTTP endpoint
  `http://10.0.2.2:7890`. The sidecar ignores ambient proxy variables and receives only this
  explicit endpoint.
- `TELEGRAM_MCP_PORT` (default `8724`), `TELEGRAM_USERBOT_QR_CHAT_ID` (defaults to the first
  of `TELEGRAM_ALLOWED_USER_IDS`). The default needs no config. If you set a custom port,
  run `iva userbot setup` (restarts the proxy) **and** `iva restart` (iva reads the port from
  its env at start) so both agree.
- The proxy bearer lives in `data/telegram-userbot.token` (0600), read at runtime by both the
  proxy and iva — so the bot can provision the proxy mid-chat without restarting iva.
- In production, the sidecar alone mounts the named volume containing the Telethon session.
  It has no published port, no `.env`, memory, vault, or Eve-state mount, and its root
  filesystem is read-only. Removing `data/telegram-userbot.enabled` is the kill switch.

## How it works

- **One session owner.** Exactly one process may own a Telethon session; a second opener
  desyncs MTProto. The proxy is that owner; iva calls it over HTTP.
- **Session-less boot.** With no session yet, the proxy comes up unauthorized (onboarding
  mode) and serves only login tools until you scan the QR — then the same live client
  becomes authorized in place, no restart.
- **Enforced production read-only registry.** Upstream tools are pruned to the reviewed
  local allowlist before onboarding tools are added. CI enumerates the effective registry
  and rejects mutating tool families.
- Built on [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) `v3.2.0`
  (116 tools), pinned in `services/telegram-userbot/requirements.txt`.
