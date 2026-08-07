# Запуск в Podman

Этот fork рассчитан на серверный запуск через rootless Podman, а не напрямую через host-native systemd user units.

Compose-файл разделяет Iva на два постоянных процесса:

- `iva`: Eve-сервер на `127.0.0.1:8723`.
- `telegram-poll`: Telegram long-poll bridge.

Постоянные данные подключаются bind mount:

- `./memory` → `/app/memory`
- `./data` → `/app/data`

## Подготовка

```bash
cp .env.example .env
npm ci
ASSISTANT_VAULT_DIR=memory npm run init-vault
```

Реальные секреты заполняются только на сервере:

```text
MODEL_PROVIDER=opencode
OPENCODE_API_KEY=...
OPENCODE_MODEL=deepseek-v4-pro
TELEGRAM_ALLOWED_USER_IDS=...
TELEGRAM_BOT_TOKEN=...
```

Пустой `TELEGRAM_ALLOWED_USER_IDS` работает fail-closed: Iva никому не отвечает.

## Запуск

```bash
podman compose build
podman compose up -d iva telegram-poll
podman compose logs -f
```

`podman-compose.yml` задаёт и `IVA_PORT=8723`, и `PORT=8723`; именно `PORT` использует `eve start` для bind.

Ручной rollup памяти:

```bash
podman compose --profile manual run --rm memory-daily
```

## Базовая безопасность

- Запускать rootless Podman под отдельным non-root пользователем сервера.
- Не монтировать `/var/run/docker.sock`, SSH agent sockets, cloud credentials и широкие host paths.
- Держать `.env` с правами `0600`.
- Для Telegram userbot начинать с `TELEGRAM_EXPOSED_TOOLS=read-only`.
- Переключать userbot tools в `all` только после согласования точного approval flow.
