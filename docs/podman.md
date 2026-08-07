# Podman deployment

This fork is intended to run on a server with rootless Podman instead of host-native systemd user units.

The Compose file keeps Iva split into two long-running processes:

- `iva`: Eve server on `127.0.0.1:8723`.
- `telegram-poll`: Telegram long-poll bridge.

Persistent local data is bind-mounted:

- `./memory` → `/app/memory`
- `./data` → `/app/data`

## Prepare

```bash
cp .env.example .env
npm ci
ASSISTANT_VAULT_DIR=memory npm run init-vault
```

Fill `.env` with real secrets only on the server:

```text
MODEL_PROVIDER=opencode
OPENCODE_API_KEY=...
OPENCODE_MODEL=deepseek-v4-pro
TELEGRAM_ALLOWED_USER_IDS=...
TELEGRAM_BOT_TOKEN=...
```

An empty `TELEGRAM_ALLOWED_USER_IDS` is fail-closed: Iva answers nobody.

## Run

```bash
podman compose build
podman compose up -d iva telegram-poll
podman compose logs -f
```

`podman-compose.yml` sets both `IVA_PORT=8723` and `PORT=8723`; `PORT` is what `eve start` binds to.

Manual memory rollup:

```bash
podman compose --profile manual run --rm memory-daily
```

## Security baseline

- Run rootless Podman under a dedicated non-root server user.
- Do not mount `/var/run/docker.sock`, SSH agent sockets, cloud credentials, or broad host paths.
- Keep `.env` mode `0600`.
- Start with `TELEGRAM_EXPOSED_TOOLS=read-only` for the personal Telegram userbot.
- Switch userbot tools to `all` only after confirming the exact approval flow you want.
