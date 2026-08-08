#!/usr/bin/env python3
"""
Persistent HTTP proxy that owns ONE Telethon userbot session and exposes the
upstream chigwell/telegram-mcp tools over MCP streamable-HTTP for the iva agent.

Why this exists (hard-won lesson, do not "simplify" away):
- Exactly ONE process may own a given Telethon session. A second opener desyncs
  the MTProto session and crashes Telethon with TypeNotFoundError. So this proxy
  is the sole session owner; iva reaches it on demand over HTTP.

Design:
- Session-less boot. If no saved session exists yet, we seed an EMPTY StringSession
  so upstream's `_discover_accounts()` builds an unauthorized-but-connectable client
  instead of `sys.exit(1)`. The private phone-login routes authorize
  that SAME live client in place, then persist the real session — no restart, no
  hot-swap of a different client.
- Bearer auth + bind 127.0.0.1 (single box; defense-in-depth on top of localhost).
- receive_updates defaults to True upstream, so Telethon's own loop auto-reconnects;
  we add a cheap EnsureConnected middleware as belt-and-suspenders.

Env:
  TELEGRAM_MCP_HOST   bind address        (default 127.0.0.1)
  TELEGRAM_MCP_PORT   bind port           (default 8724)
  TELEGRAM_MCP_TOKEN  bearer secret; every request must send `Authorization: Bearer <token>`
  TELEGRAM_API_ID / TELEGRAM_API_HASH     from my.telegram.org (required)
  TELEGRAM_SESSION_FILE  path to the SQLite session file
                         (default $ASSISTANT_DATA_DIR/telegram-userbot.session, else ./telegram-userbot.session)
"""
import hmac
import json
import os
import secrets
import stat
import sys
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Fail closed before health, MCP, or onboarding request dispatch."""

    def __init__(self, app, *, token: str, onboarding_token: str):
        super().__init__(app)
        self._mcp_expected = f"Bearer {token}"
        self._onboarding_expected = f"Bearer {onboarding_token}"

    async def dispatch(self, request, call_next):
        expected = (
            self._onboarding_expected
            if request.url.path.startswith("/onboarding/phone/")
            else self._mcp_expected
        )
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, expected):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


def add_phone_onboarding_routes(app, controller) -> None:
    """Attach the internal, non-MCP phone-login API to a Starlette app."""

    async def field(request, name: str):
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 1024:
                    raise ValueError
            payload = json.loads(body)
            value = payload.get(name) if isinstance(payload, dict) else None
            if not isinstance(value, str):
                raise ValueError
            return value
        except (TypeError, ValueError, UnicodeError):
            return None
        except Exception:  # noqa: BLE001 - malformed parsers stay a fixed 400
            return None

    async def invalid():
        return JSONResponse(
            {"state": "error", "reason": "invalid_request"}, status_code=400
        )

    async def start(request):
        phone = await field(request, "phone")
        return (
            await invalid()
            if phone is None
            else JSONResponse(await controller.start(phone))
        )

    async def code(request):
        value = await field(request, "code")
        return (
            await invalid()
            if value is None
            else JSONResponse(await controller.submit_code(value))
        )

    async def password(request):
        value = await field(request, "password")
        return (
            await invalid()
            if value is None
            else JSONResponse(await controller.submit_password(value))
        )

    async def cancel(_request):
        return JSONResponse(await controller.cancel())

    async def status(_request):
        return JSONResponse(await controller.status())

    app.add_route("/onboarding/phone/start", start, methods=["POST"])
    app.add_route("/onboarding/phone/code", code, methods=["POST"])
    app.add_route("/onboarding/phone/password", password, methods=["POST"])
    app.add_route("/onboarding/phone/cancel", cancel, methods=["POST"])
    app.add_route("/onboarding/phone/status", status, methods=["GET"])


# Explicit allowlist: upstream readOnlyHint annotations are useful but not sufficient
# as a security boundary. New or mis-annotated tools fail closed until reviewed here.
APPROVED_READ_ONLY_TOOLS = frozenset(
    {
        "export_contacts",
        "get_admins",
        "get_banned_users",
        "get_blocked_users",
        "get_bot_info",
        "get_chat",
        "get_chats",
        "get_common_chats",
        "get_contact_chats",
        "get_contact_ids",
        "get_direct_chat_by_contact",
        "get_drafts",
        "get_folder",
        "get_full_chat",
        "get_full_user",
        "get_gif_search",
        "get_history",
        "get_last_interaction",
        "get_me",
        "get_media_info",
        "get_message_context",
        "get_message_link",
        "get_message_reactions",
        "get_message_read_by",
        "get_messages",
        "get_participants",
        "get_pinned_messages",
        "get_privacy_settings",
        "get_recent_actions",
        "get_scheduled_messages",
        "get_sticker_sets",
        "get_user_photos",
        "get_user_status",
        "list_accounts",
        "list_chats",
        "list_contacts",
        "list_folders",
        "list_inline_buttons",
        "list_messages",
        "list_topics",
        "resolve_username",
        "search_contacts",
        "search_global",
        "search_messages",
        "search_public_chats",
        "wait_for_new_message",
        "wait_for_settled_message",
    }
)


def apply_exposed_tool_policy(server, *, upstream_apply, mode: str) -> list[str]:
    """Apply upstream annotations, then the local fail-closed read allowlist."""
    removed = set(upstream_apply(server, mode))
    if mode.strip().lower() == "read-only":
        for tool in list(server._tool_manager.list_tools()):
            if tool.name not in APPROVED_READ_ONLY_TOOLS:
                server._tool_manager.remove_tool(tool.name)
                removed.add(tool.name)
    return sorted(removed)


async def _health_payload(client) -> dict[str, str]:
    """Report authorization from the proxy's existing Telethon client."""
    return {"state": "ready" if await client.is_user_authorized() else "unauthorized"}


def _fail(msg: str) -> None:
    print(f"telegram-userbot: {msg}", file=sys.stderr)
    sys.exit(1)


def _session_file() -> Path:
    explicit = os.getenv("TELEGRAM_SESSION_FILE")
    if explicit:
        return Path(explicit)
    data_dir = os.getenv("ASSISTANT_DATA_DIR")
    base = Path(data_dir) if data_dir else Path.cwd()
    return base / "telegram-userbot.session"


def _token_file() -> Path:
    # Anchored at <iva_root>/data so iva's connection (cwd = iva root) and this proxy
    # (cwd = services/telegram-userbot) resolve the SAME file: services/telegram-userbot/
    # serve.py → parents[2] = iva root. `iva userbot setup` writes it (0600).
    return Path(__file__).resolve().parents[2] / "data" / "telegram-userbot.token"


def _onboarding_token_file() -> Path:
    explicit = os.getenv("TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE")
    if explicit:
        return Path(explicit)
    _fail("onboarding token file must be explicitly configured")


def _resolve_token() -> str:
    env = os.getenv("TELEGRAM_MCP_TOKEN")
    if env:
        return env.strip()
    f = _token_file()
    return f.read_text().strip() if f.exists() else ""


def _resolve_onboarding_token() -> str:
    """Load/create the menu-only bearer outside the model container in production."""
    configured = os.getenv("TELEGRAM_USERBOT_ONBOARDING_TOKEN")
    if configured:
        token = configured.strip()
        if len(token) < 32:
            _fail("onboarding token is invalid")
        return token

    path = _onboarding_token_file()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid():
        _fail("onboarding token directory must be an owned regular directory")
    path.parent.chmod(0o700)

    if not path.exists() and not path.is_symlink():
        token = secrets.token_hex(32)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags, 0o600)
        except FileExistsError:
            pass
        else:
            try:
                os.write(fd, f"{token}\n".encode())
                os.fsync(fd)
            finally:
                os.close(fd)

    try:
        metadata = path.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
        ):
            _fail("onboarding token file must be private and owned")
        token = path.read_text().strip()
    except OSError:
        _fail("onboarding token file is unavailable")
    if len(token) < 32:
        _fail("onboarding token is invalid")
    return token


def _load_credentials_file() -> None:
    """Load the strict container credential file while preserving legacy env use."""
    path = os.getenv("TELEGRAM_USERBOT_CREDENTIALS_FILE")
    if not path or (os.getenv("TELEGRAM_API_ID") and os.getenv("TELEGRAM_API_HASH")):
        return
    from container_supervisor import load_credentials

    os.environ.update(load_credentials(Path(path)))


def _seed_session_env() -> Path:
    """Point upstream at our SQLite session file (created empty if absent = onboarding).

    Must run BEFORE importing telegram_mcp.runtime, whose module-level
    `_discover_accounts()` reads the session env and `sys.exit(1)`s if unset.

    We use a FILE session (not a string): an unauthorized session can't be
    serialized to a non-empty StringSession, but a missing SQLite file is a valid
    empty unauthorized session, and Telethon persists the auth to it automatically
    on phone login — no manual save. Single owner ⇒ no "database is locked".
    """
    path = _session_file()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid():
        _fail("session directory must be an owned regular directory")
    path.parent.chmod(0o700)
    if path.exists() or path.is_symlink():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid():
            _fail("session file must be an owned regular file")
        if metadata.st_mode & 0o077:
            _fail("session file must have private permissions")
    # Telethon appends ".session" to the name; strip it so we don't get ".session.session".
    name = str(path)
    if name.endswith(".session"):
        name = name[: -len(".session")]
    os.environ["TELEGRAM_SESSION_NAME"] = name
    return path


def main() -> None:
    import asyncio

    # The SQLite session file holds the MTProto auth key (= full account access). Force
    # private perms on everything we create (0600 files / 0700 dirs) so a co-tenant on
    # the host can't read it — systemd's default umask is 022 (world-readable 0644).
    os.umask(0o077)

    host = os.getenv("TELEGRAM_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("TELEGRAM_MCP_PORT", "8724"))
    token = _resolve_token()
    if not token:
        _fail("no proxy token — run `iva userbot setup` (writes data/telegram-userbot.token)")
    onboarding_enabled = bool(
        os.getenv("TELEGRAM_USERBOT_ONBOARDING_TOKEN_FILE")
        or os.getenv("TELEGRAM_USERBOT_ONBOARDING_TOKEN")
    )
    onboarding_token = (
        _resolve_onboarding_token() if onboarding_enabled else secrets.token_hex(32)
    )
    _load_credentials_file()
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        _fail("TELEGRAM_API_ID and TELEGRAM_API_HASH are required (create an app at my.telegram.org)")

    session_path = _seed_session_env()

    # Import AFTER seeding the session env — runtime builds `mcp` + the single
    # Telethon client; importing the tools package fires every @mcp.tool decorator.
    from telegram_mcp.runtime import mcp, get_client, _apply_exposed_tools_mode
    import telegram_mcp.tools  # noqa: F401 — registers all tools with `mcp`

    # Honor TELEGRAM_EXPOSED_TOOLS (e.g. "read-only"); upstream normally does this in
    # its runner, which we bypass. Default "all".
    exposed_mode = os.getenv("TELEGRAM_EXPOSED_TOOLS", "all")
    removed = apply_exposed_tool_policy(
        mcp,
        upstream_apply=_apply_exposed_tools_mode,
        mode=exposed_mode,
    )
    if removed:
        print(
            f"telegram-userbot: read-only mode, pruned {len(removed)} non-approved tools",
            file=sys.stderr,
        )

    client = get_client()

    # Register only the model-visible read-only status probe. Phone/code/password
    # travel through private HTTP routes below and never become MCP tool arguments.
    from onboarding import register_onboarding_tools

    onboarding = register_onboarding_tools(mcp, client)

    # Enforce the anti-ban safety guide as server behavior (FloodWait compliance,
    # pacing, circuit-breaker) by wrapping the client's outbound methods in place.
    from guardrails import install_guardrails

    install_guardrails(client)

    import uvicorn
    class EnsureConnectedMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            try:
                if not client.is_connected():
                    await client.connect()
            except Exception as exc:  # noqa: BLE001
                print(f"telegram-userbot: reconnect failed: {exc}", file=sys.stderr)
            return await call_next(request)

    async def health(_request):
        return JSONResponse(await _health_payload(client))

    async def amain() -> None:
        await client.connect()  # NOT .start() — that would prompt for interactive login
        authorized = await client.is_user_authorized()
        print(
            f"telegram-userbot: session {'authorized' if authorized else 'NOT authorized (onboarding mode)'}"
            f" [{session_path}]",
            file=sys.stderr,
        )

        mcp.settings.host = host
        mcp.settings.port = port
        # Bound to localhost + bearer-gated; the DNS-rebinding validator only adds
        # 421s for the loopback/host aliases iva uses, so disable it here.
        from mcp.server.transport_security import TransportSecuritySettings

        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )

        app = mcp.streamable_http_app()
        app.add_route("/healthz", health, methods=["GET"])
        if onboarding_enabled:
            add_phone_onboarding_routes(app, onboarding)
        # add_middleware stacks outermost-last: BearerAuth runs first (reject before
        # we bother reconnecting), then EnsureConnected.
        app.add_middleware(EnsureConnectedMiddleware)
        app.add_middleware(
            BearerAuthMiddleware,
            token=token,
            onboarding_token=onboarding_token,
        )

        print(f"telegram-userbot: listening on http://{host}:{port}/mcp", file=sys.stderr)
        config = uvicorn.Config(app, host=host, port=port, log_level="warning", lifespan="on")
        await uvicorn.Server(config).serve()

    import nest_asyncio

    nest_asyncio.apply()
    asyncio.run(amain())


if __name__ == "__main__":
    main()
