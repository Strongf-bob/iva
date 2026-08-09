"""Bounded read-only projections of the proxy's existing Telethon client."""

import re
from datetime import datetime


MAX_DIALOG_LIMIT = 100
MAX_MESSAGE_LIMIT = 200


def parse_bounded_int(raw: str, *, name: str, minimum: int, maximum: int) -> int:
    if not re.fullmatch(r"-?\d+", raw):
        raise ValueError(f"{name} must be an integer")
    value = int(raw)
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} out of range")
    return value


def _display_name(entity) -> str:
    title = getattr(entity, "title", None)
    if title:
        return str(title)
    parts = [getattr(entity, "first_name", None), getattr(entity, "last_name", None)]
    name = " ".join(str(part) for part in parts if part).strip()
    return name or str(getattr(entity, "id", "unknown"))


def _username(entity):
    value = getattr(entity, "username", None)
    return str(value) if value else None


async def account_payload(client) -> dict:
    entity = await client.get_me()
    return {
        "userId": int(entity.id),
        "displayName": _display_name(entity),
        "username": _username(entity),
    }


def _dialog_kind(dialog) -> str:
    entity = dialog.entity
    if getattr(dialog, "is_user", False):
        return "bot" if getattr(entity, "bot", False) else "private"
    if getattr(dialog, "is_group", False):
        return "group"
    if getattr(dialog, "is_channel", False):
        return "channel"
    return "channel"


def _dialog_payload(dialog) -> dict:
    entity = dialog.entity
    return {
        "id": int(dialog.id),
        "kind": _dialog_kind(dialog),
        "title": str(getattr(dialog, "name", None) or _display_name(entity)),
        "username": _username(entity),
    }


async def dialogs_payload(client, *, offset: int, limit: int) -> dict:
    wanted = offset + limit + 1
    dialogs = []
    async for dialog in client.iter_dialogs(limit=wanted):
        dialogs.append(_dialog_payload(dialog))
    page = dialogs[offset : offset + limit]
    next_offset = offset + len(page) if len(dialogs) > offset + len(page) else None
    return {"dialogs": page, "nextOffset": next_offset}


def _media_kind(message):
    for attr, kind in (
        ("voice", "voice"),
        ("video_note", "video_note"),
        ("photo", "photo"),
        ("document", "document"),
    ):
        if getattr(message, attr, None):
            return kind
    return None


def _mentions(message) -> tuple[list[int], list[str]]:
    text = str(getattr(message, "raw_text", "") or "")
    user_ids = set()
    usernames = set()
    for entity in getattr(message, "entities", None) or []:
        user_id = getattr(entity, "user_id", None)
        if user_id is not None:
            user_ids.add(int(user_id))
            continue
        offset = getattr(entity, "offset", None)
        length = getattr(entity, "length", None)
        if not isinstance(offset, int) or not isinstance(length, int):
            continue
        value = text[offset : offset + length]
        if value.startswith("@") and len(value) > 1:
            usernames.add(value[1:].lower())
    return sorted(user_ids), sorted(usernames)


def _timestamp(value: datetime) -> str:
    return value.isoformat()


def _message_payload(message) -> dict:
    mentioned_user_ids, mentioned_usernames = _mentions(message)
    sender_id = getattr(message, "sender_id", None)
    return {
        "id": int(message.id),
        "senderId": int(sender_id) if sender_id is not None else None,
        "timestamp": _timestamp(message.date),
        "text": str(getattr(message, "raw_text", "") or ""),
        "replyToMessageId": getattr(message, "reply_to_msg_id", None),
        "mentionedUserIds": mentioned_user_ids,
        "mentionedUsernames": mentioned_usernames,
        "mediaKind": _media_kind(message),
    }


async def messages_payload(
    client, *, chat_id: int, after_id: int, limit: int
) -> dict:
    messages = []
    async for message in client.iter_messages(
        chat_id, min_id=after_id, reverse=True, limit=limit
    ):
        messages.append(_message_payload(message))
    next_after_id = messages[-1]["id"] if messages else after_id
    return {"messages": messages, "nextAfterId": next_after_id}


def register_analysis_routes(app, client, *, json_response_cls=None) -> None:
    """Register the pipeline's GET-only surface on the already bearer-gated app."""
    if json_response_cls is None:
        from starlette.responses import JSONResponse

        json_response_cls = JSONResponse

    async def authorized():
        return await client.is_user_authorized()

    def response(payload, status_code=200):
        return json_response_cls(payload, status_code=status_code)

    def failure(exc):
        retry_after = getattr(exc, "seconds", None)
        payload = {"error": "telegram_read_failed"}
        if isinstance(retry_after, int) and retry_after > 0:
            payload["retryAfterSeconds"] = retry_after
        return response(payload, 502)

    async def account(_request):
        if not await authorized():
            return response({"error": "telegram_unauthorized"}, 409)
        try:
            return response(await account_payload(client))
        except Exception as exc:  # noqa: BLE001 - sanitized transport boundary
            return failure(exc)

    async def dialogs(request):
        if not await authorized():
            return response({"error": "telegram_unauthorized"}, 409)
        try:
            offset = parse_bounded_int(
                request.query_params.get("offset", "0"),
                name="offset",
                minimum=0,
                maximum=1_000_000,
            )
            limit = parse_bounded_int(
                request.query_params.get("limit", str(MAX_DIALOG_LIMIT)),
                name="limit",
                minimum=1,
                maximum=MAX_DIALOG_LIMIT,
            )
        except ValueError:
            return response({"error": "invalid_parameters"}, 400)
        try:
            return response(await dialogs_payload(client, offset=offset, limit=limit))
        except Exception as exc:  # noqa: BLE001 - sanitized transport boundary
            return failure(exc)

    async def messages(request):
        if not await authorized():
            return response({"error": "telegram_unauthorized"}, 409)
        try:
            chat_id = parse_bounded_int(
                request.query_params.get("chat_id", ""),
                name="chat_id",
                minimum=-(2**63) + 1,
                maximum=2**63 - 1,
            )
            after_id = parse_bounded_int(
                request.query_params.get("after_id", "0"),
                name="after_id",
                minimum=0,
                maximum=2**63 - 1,
            )
            limit = parse_bounded_int(
                request.query_params.get("limit", str(MAX_MESSAGE_LIMIT)),
                name="limit",
                minimum=1,
                maximum=MAX_MESSAGE_LIMIT,
            )
        except ValueError:
            return response({"error": "invalid_parameters"}, 400)
        try:
            return response(
                await messages_payload(
                    client, chat_id=chat_id, after_id=after_id, limit=limit
                )
            )
        except Exception as exc:  # noqa: BLE001 - sanitized transport boundary
            return failure(exc)

    app.add_route("/analysis/v1/account", account, methods=["GET"])
    app.add_route("/analysis/v1/dialogs", dialogs, methods=["GET"])
    app.add_route("/analysis/v1/messages", messages, methods=["GET"])
