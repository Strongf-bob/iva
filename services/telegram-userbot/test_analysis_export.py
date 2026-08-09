import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from analysis_export import (
    _message_payload,
    account_payload,
    dialogs_payload,
    message_window_payload,
    messages_payload,
    parse_bounded_int,
    register_analysis_routes,
)


class FakeEntity:
    def __init__(self, entity_id, *, title=None, first_name=None, username=None, bot=False):
        self.id = entity_id
        self.title = title
        self.first_name = first_name
        self.last_name = None
        self.username = username
        self.bot = bot


class FakeDialog:
    def __init__(self, entity, *, is_user=False, is_group=False, is_channel=False):
        self.entity = entity
        self.id = entity.id
        self.name = entity.title or entity.first_name or str(entity.id)
        self.is_user = is_user
        self.is_group = is_group
        self.is_channel = is_channel


class Mention:
    def __init__(self, offset, length):
        self.offset = offset
        self.length = length


class MentionName(Mention):
    def __init__(self, offset, length, user_id):
        super().__init__(offset, length)
        self.user_id = user_id


class FakeMessage:
    def __init__(self, message_id, text, sender_id=44, entities=None, media_kind=None):
        self.id = message_id
        self.sender_id = sender_id
        self.date = datetime(2026, 8, 7, tzinfo=timezone.utc)
        self.raw_text = text
        self.reply_to_msg_id = 9
        self.entities = entities or []
        self.voice = media_kind == "voice"
        self.video_note = media_kind == "video_note"
        self.photo = media_kind == "photo"
        self.document = media_kind == "document"


class FakeClient:
    def __init__(self):
        self.me = FakeEntity(7, first_name="Owner", username="owner")
        self.dialogs = [
            FakeDialog(FakeEntity(44, first_name="Alex", username="alex"), is_user=True),
            FakeDialog(FakeEntity(55, first_name="Helper", bot=True), is_user=True),
            FakeDialog(FakeEntity(-1001, title="Team"), is_group=True),
            FakeDialog(FakeEntity(-1002, title="News"), is_channel=True),
        ]
        self.messages = [
            FakeMessage(10, "older"),
            FakeMessage(
                12,
                "hello @owner and Owner",
                entities=[Mention(6, 6), MentionName(17, 5, 7)],
                media_kind="voice",
            ),
        ]

    async def get_me(self):
        return self.me

    async def is_user_authorized(self):
        return True

    async def iter_dialogs(self, limit=None):
        for dialog in self.dialogs[:limit]:
            yield dialog

    async def get_messages(self, chat_id, min_id, limit):
        if limit != 0:
            raise AssertionError("message totals must use limit=0")
        return SimpleNamespace(
            total=len([item for item in self.messages if item.id > min_id])
        )

    async def iter_messages(self, chat_id, min_id, reverse, limit=None):
        unseen = [item for item in self.messages if item.id > min_id]
        if not reverse:
            unseen.reverse()
        for message in unseen[:limit]:
            yield message


class AnalysisExportTest(unittest.IsolatedAsyncioTestCase):
    async def test_account_payload_uses_numeric_identity(self):
        payload = await account_payload(FakeClient())
        self.assertEqual(
            payload,
            {"userId": 7, "displayName": "Owner", "username": "owner"},
        )

    async def test_dialogs_are_paginated_and_classified(self):
        first = await dialogs_payload(FakeClient(), offset=0, limit=2)
        second = await dialogs_payload(FakeClient(), offset=2, limit=2)

        self.assertEqual([item["kind"] for item in first["dialogs"]], ["private", "bot"])
        self.assertEqual(first["nextOffset"], 2)
        self.assertEqual([item["kind"] for item in second["dialogs"]], ["group", "channel"])
        self.assertIsNone(second["nextOffset"])

    async def test_messages_are_oldest_first_and_keep_provenance_fields(self):
        payload = await messages_payload(FakeClient(), chat_id=-1001, after_id=10, limit=10)

        self.assertEqual(
            payload["messages"],
            [
                {
                    "id": 12,
                    "senderId": 44,
                    "timestamp": "2026-08-07T00:00:00+00:00",
                    "text": "hello @owner and Owner",
                    "replyToMessageId": 9,
                    "mentionedUserIds": [7],
                    "mentionedUsernames": ["owner"],
                    "mediaKind": "voice",
                }
            ],
        )
        self.assertEqual(payload["nextAfterId"], 12)

    async def test_message_window_keeps_newest_complete_messages_in_chronological_order(self):
        client = FakeClient()
        client.messages = [FakeMessage(message_id, "x" * 100) for message_id in range(11, 16)]
        max_chars = sum(
            len(json.dumps(_message_payload(message), ensure_ascii=False, separators=(",", ":")))
            for message in client.messages[-2:]
        )

        payload = await message_window_payload(
            client,
            chat_id=-1001,
            after_id=10,
            max_chars=max_chars,
        )

        self.assertEqual([item["id"] for item in payload["messages"]], [14, 15])
        self.assertEqual(payload["latestMessageId"], 15)
        self.assertEqual(payload["skippedMessages"], 3)

    async def test_message_window_uses_javascript_utf16_character_units(self):
        client = FakeClient()
        client.messages = [
            FakeMessage(message_id, "😀" * 1000) for message_id in range(11, 16)
        ]
        newest_sizes = [
            len(
                json.dumps(
                    _message_payload(message),
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-16-le")
            )
            // 2
            for message in client.messages[-2:]
        ]

        payload = await message_window_payload(
            client,
            chat_id=-1001,
            after_id=10,
            max_chars=sum(newest_sizes),
        )

        self.assertEqual([item["id"] for item in payload["messages"]], [14, 15])
        self.assertEqual(payload["skippedMessages"], 3)


class BoundedIntTest(unittest.TestCase):
    def test_rejects_non_integer_and_out_of_range_values(self):
        self.assertEqual(parse_bounded_int("10", name="limit", minimum=1, maximum=100), 10)
        with self.assertRaisesRegex(ValueError, "must be an integer"):
            parse_bounded_int("1.5", name="limit", minimum=1, maximum=100)
        with self.assertRaisesRegex(ValueError, "out of range"):
            parse_bounded_int("101", name="limit", minimum=1, maximum=100)


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code


class FakeApp:
    def __init__(self):
        self.routes = {}

    def add_route(self, path, handler, methods):
        self.routes[(path, tuple(methods))] = handler


class FakeRequest:
    def __init__(self, query_params=None):
        self.query_params = query_params or {}


class AnalysisRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def test_registers_only_bounded_get_routes(self):
        app = FakeApp()
        register_analysis_routes(app, FakeClient(), json_response_cls=FakeResponse)

        self.assertEqual(
            set(app.routes),
            {
                ("/analysis/v1/account", ("GET",)),
                ("/analysis/v1/dialogs", ("GET",)),
                ("/analysis/v1/messages", ("GET",)),
                ("/analysis/v1/message-window", ("GET",)),
            },
        )
        handler = app.routes[("/analysis/v1/dialogs", ("GET",))]
        response = await handler(FakeRequest({"offset": "0", "limit": "2"}))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.payload["dialogs"]), 2)

    async def test_invalid_parameters_return_sanitized_400(self):
        app = FakeApp()
        register_analysis_routes(app, FakeClient(), json_response_cls=FakeResponse)
        handler = app.routes[("/analysis/v1/messages", ("GET",))]

        response = await handler(
            FakeRequest({"chat_id": "oops", "after_id": "0", "limit": "200"})
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.payload, {"error": "invalid_parameters"})

        window = app.routes[("/analysis/v1/message-window", ("GET",))]
        for max_chars in ("0", "500001"):
            response = await window(
                FakeRequest(
                    {
                        "chat_id": "-1001",
                        "after_id": "0",
                        "max_chars": max_chars,
                    }
                )
            )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.payload, {"error": "invalid_parameters"})


if __name__ == "__main__":
    unittest.main()
