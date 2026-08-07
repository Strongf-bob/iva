# Configuration

Iva is configured by one file: `.env` in the install directory. The setup wizard fills it in for you — run `iva config` any time to redo a step ([cli.md](./cli.md)). `.env.example` in the repo root is the template. This page documents every variable.

**Every change needs a restart.** Iva reads `.env` once at startup. After editing:

```bash
iva restart
```

No rebuild. Swapping a model, key or provider is edit → restart.

**One exception: the reply language.** The **🌐 Language** button in `/menu` writes `data/settings.json`, which both processes re-read live — the switch takes effect immediately, no restart. See [menu.md](./menu.md).

## Model provider

Four providers. Pick one with `MODEL_PROVIDER` and fill only that block. `ollama`/`opencode`/`openrouter` are OpenAI-compatible API keys; `codex` rides your OpenAI (ChatGPT) subscription via OAuth — no key. Prices and full model lists: [providers.md](./providers.md).

| Variable                    | Default           | Notes                                                                                                                                                                                                              |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MODEL_PROVIDER`            | `opencode`        | `ollama` (Ollama Cloud), `opencode` (OpenCode Go), `openrouter` (OpenRouter) or `codex` (OpenAI ChatGPT subscription).                                                                                             |
| `OLLAMA_API_KEY`            | —                 | Key from ollama.com.                                                                                                                                                                                               |
| `OLLAMA_MODEL`              | `deepseek-v4-pro` | Any model on your Ollama Cloud plan.                                                                                                                                                                               |
| `OLLAMA_CONTEXT_WINDOW`     | `131072`          | See warning below.                                                                                                                                                                                                 |
| `OPENCODE_API_KEY`          | —                 | Key from opencode.ai/auth.                                                                                                                                                                                         |
| `OPENCODE_MODEL`            | `deepseek-v4-pro` | Any Go model, bare ID (e.g. `kimi-k3`) — `iva config` shows the live list.                                                                                                                                         |
| `OPENCODE_CONTEXT_WINDOW`   | `131072`          | Same warning.                                                                                                                                                                                                      |
| `OPENROUTER_API_KEY`        | —                 | Key from [openrouter.ai/keys](https://openrouter.ai/keys) (starts with `sk-or-`).                                                                                                                                  |
| `OPENROUTER_MODEL`          | `openai/gpt-5.1`  | The model **slug** from [openrouter.ai/models](https://openrouter.ai/models), form `vendor/model` (e.g. `anthropic/claude-sonnet-4.5`). `iva config` sends a live test request so a wrong slug can't slip through. |
| `OPENROUTER_CONTEXT_WINDOW` | `131072`          | Same warning — set the real window of the model you picked.                                                                                                                                                        |
| `CODEX_MODEL`               | `gpt-5.5`         | Model from your OpenAI plan. `iva config` lists what your subscription actually exposes.                                                                                                                           |
| `CODEX_CONTEXT_WINDOW`      | `272000`          | Same warning — set the real window of the model you picked.                                                                                                                                                        |

For `codex` there is no API key in `.env`: run `iva login` (device code, headless-friendly) or `iva login --browser`. The OAuth token lives in `data/codex-auth.json` (chmod 600, gitignored) and is auto-refreshed before it expires. Full flow: [providers.md](./providers.md#openai-by-chatgpt-subscription-codex).

**Don't inflate the context window.** Compaction triggers at 70% of this number. Set it above the model's real window and the compactor fires too late — the request overflows before history gets trimmed. When you switch models, enter the new model's actual window, not a rounder bigger one.

## Telegram

| Variable                        | Default   | Notes                                                                                                                      |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | —         | From [@BotFather](https://t.me/BotFather).                                                                                 |
| `TELEGRAM_BOT_USERNAME`         | —         | Your bot's username. The wizard verifies the token via `getMe` and detects this itself.                                    |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | —         | Shared secret between the long-poll bridge and the local webhook. Any long random string.                                  |
| `TELEGRAM_ALLOWED_USER_IDS`     | _(empty)_ | Comma-separated numeric user IDs allowed to talk to Iva.                                                                   |
| `TELEGRAM_DIGEST_CHAT_ID`       | —         | Chat that receives the morning digest, nightly memory reports and one-time stable update offers. Usually your own chat ID. |

The allowlist is **fail-closed: empty means Iva answers nobody.** The wizard auto-discovers your ID the moment you message the bot; or ask [@userinfobot](https://t.me/userinfobot). Why fail-closed matters: [security.md](./security.md).

At 10:00 in `ASSISTANT_TIMEZONE` Iva checks Git upstream without using the model. It sends nothing unless a higher stable `MAJOR.MINOR.PATCH` version exists, and offers each version only once. If `TELEGRAM_DIGEST_CHAT_ID` is empty, the first trusted ID is used.

## Isolated multi-user mode

Iva can serve up to 10 mutually untrusted Telegram users through private chats with one bot. The operator manages users only from the server terminal; Telegram has no command for listing users, reading another person's data or changing another person's limits.

```bash
# Existing installation: copy and verify the current owner's state first.
# Omit the ID only when TELEGRAM_ALLOWED_USER_IDS contains exactly one user.
iva users migrate-owner 123456789

# Add and operate ordinary users.
iva users add 987654321
iva users list
iva users block 987654321
iva users unblock 987654321
iva users delete 987654321 --confirm 987654321
```

`migrate-owner` is explicit, idempotent and keeps a timestamped rollback backup. It copies and verifies the legacy vault, runtime data, sessions and Google configuration, stages a non-routable worker, and activates the owner only after its exact loopback health check passes. `block` stops access but retains data. `delete` first blocks the worker, pauses the shared gateway, moves the personal directory and tenant-scoped gateway state to `data/quarantine/`, removes the registry entry, then resumes the gateway; it does not erase the quarantine automatically.

Each user has independent memory, history, personal settings files, persona, schedules, Google credentials and quota accounting under `data/users/<telegram-id>/`. The model provider, model selection, Telegram bot, Deepgram account and server are shared infrastructure configured and paid by the operator. The personal Telegram userbot remains owner-only.

New users receive these limits:

| Resource         |          Default |
| ---------------- | ---------------: |
| Concurrent turns |                1 |
| Requests         | 30/hour, 100/day |
| Model tokens     |      500,000/day |
| Audio            |   30 minutes/day |
| One attachment   |            20 MB |
| Personal storage |             1 GB |

Override one or more values locally:

```bash
iva users limits 987654321 \
  --concurrent-turns 1 \
  --requests-hour 30 \
  --requests-day 100 \
  --tokens-day 500000 \
  --audio-minutes-day 30 \
  --attachment-mb 20 \
  --storage-mb 1024
```

All counters use UTC hour/day boundaries. Telegram turns and background schedules share request, token and concurrency admission. Before every provider step, the remaining daily token budget also caps model output; exact provider-reported input usage is recorded after the step and closes later calls when the ceiling is reached. `/usage` shows only the caller's ledger. An ordinary user's `/menu` exposes only that user's Google setup. In personalized owner mode, `/menu` retains shared model/search/maintenance controls, owner-only userbot and personal Google; legacy-path language/persona/core/timer screens are hidden so they cannot mutate pre-migration state.

## Voice

| Variable            | Default | Notes                                                                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEEPGRAM_API_KEY`  | —       | From console.deepgram.com. Transcribes voice notes, video circles and audio files. Free tier: [providers.md](./providers.md).              |
| `DEEPGRAM_LANGUAGE` | `multi` | `multi` auto-detects the language per message (ru/uz/en and others). Pin a single code like `en` only if auto-detection trips on your mix. |

## Search

| Variable                                                          | Default  | Notes                                                                                  |
| ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `SEARCH_PROVIDER`                                                 | `tavily` | `tavily`, `exa`, `parallel` or `brave`.                                                |
| `TAVILY_API_KEY` `EXA_API_KEY` `PARALLEL_API_KEY` `BRAVE_API_KEY` | —        | Key for the matching provider. Keys can coexist; switching providers is just the flag. |

No key for the active provider means `web_search` returns a clear error — nothing crashes. Free tiers and the comparison table: [providers.md](./providers.md).

## Memory

| Variable                | Default              | Notes                                                                                                                                                                 |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMORY_SEARCH_MODE`    | `grep`               | `grep` = BM25 over Node's built-in SQLite FTS5 plus graph rerank. Zero external deps, zero keys, runs on a $4 box. `hybrid` adds dense embeddings — one external key. |
| `JINA_API_KEY`          | —                    | For hybrid. Jina `jina-embeddings-v3`: no-train policy, EU hosting.                                                                                                   |
| `DEEPINFRA_API_KEY`     | —                    | For hybrid. Cheaper, serves `BAAI/bge-m3`. One of the two keys is enough.                                                                                             |
| `MEMORY_EMBED_PROVIDER` | _(auto)_             | Override auto-pick: `jina` or `deepinfra`.                                                                                                                            |
| `MEMORY_EMBED_MODEL`    | `jina-embeddings-v3` | Embedding model name.                                                                                                                                                 |
| `MEMORY_EMBED_URL`      | —                    | Any OpenAI-compatible embeddings endpoint, e.g. a local Ollama at `http://127.0.0.1:11434/v1/embeddings` — then no external key at all.                               |

The nightly doctor builds the hybrid index; to build it now, run `node --env-file=.env scripts/memory/embed-index.ts`. How search actually works: [memory.md](./memory.md).

## System

| Variable                   | Default                        | Notes                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_LANGUAGE`           | `ru`                           | `en` or `ru`. Sets Iva's reply language, date locale, and which CORE.md seed `init-vault` uses. The **🌐 Language** button in `/menu` overrides it at runtime via `data/settings.json` (read fresh every turn) and mirrors the choice back here, so the switch is instant — no restart ([menu.md](./menu.md)). |
| `ASSISTANT_TIMEZONE`       | `Europe/Moscow`                | IANA name. Sets daily-transcript dates, two systemd watchdog timers, five in-process eve schedules, and the date/time Iva sees each turn. Exported as `TZ`.                                                                                                                                                    |
| `ASSISTANT_VAULT_DIR`      | `memory`                       | The live memory: a separate private git repo, opens in Obsidian.                                                                                                                                                                                                                                               |
| `ASSISTANT_DATA_DIR`       | `data`                         | Runtime data: `tasks.json`, token log `usage.jsonl`.                                                                                                                                                                                                                                                           |
| `IVA_PORT`                 | `8723`                         | Local eve server port. Deliberately unfashionable — 3000/8000/8080 are usually taken on a stock VPS by docker and friends. Change it via `iva config`, not by hand: the systemd unit pins the port literally and must match ([deploy.md](./deploy.md)).                                                        |
| `ASSISTANT_HOST`           | `http://127.0.0.1:${IVA_PORT}` | Where the poll bridge and memory scripts reach the server. Change only if the agent runs on another host.                                                                                                                                                                                                      |
| `ASSISTANT_BEARER`         | _(generated)_                  | Shared secret required by Eve session routes. Setup/upgrades create it; local clients read it automatically. Keep it private.                                                                                                                                                                                  |
| `AGENT_BROWSER_MAX_OUTPUT` | `24000`                        | Character cap on agent-browser output, so one page dump can't eat the context window.                                                                                                                                                                                                                          |
