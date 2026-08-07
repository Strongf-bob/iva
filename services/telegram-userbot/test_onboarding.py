import asyncio
import contextlib
import io
import logging
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import onboarding
from telethon import errors


class FailingClient:
    async def qr_login(self):
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        raise RuntimeError(f"POST https://api.telegram.org/bot{token}/sendPhoto failed")


class FakeQr:
    def __init__(self, outcome):
        self.url = "tg://login?token=synthetic"
        self.expires = datetime.now(timezone.utc) + timedelta(seconds=30)
        self.outcome = outcome
        self.wait_calls = 0

    async def wait(self, timeout):
        self.wait_calls += 1
        if isinstance(self.outcome, BaseException):
            raise self.outcome


class FakeQrClient:
    def __init__(self, qr):
        self.qr = qr

    async def qr_login(self):
        return self.qr


class OnboardingSafetyTest(unittest.TestCase):
    def setUp(self):
        onboarding._state = {"phase": "idle", "detail": ""}

    def test_qr_delivery_uses_only_the_explicit_bot_api_proxy(self):
        calls = {}

        class Response:
            def raise_for_status(self):
                calls["status_checked"] = True

        class Client:
            def __init__(self, **kwargs):
                calls["client"] = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, url, **kwargs):
                calls["post"] = {"url": url, **kwargs}
                return Response()

        env = {
            "TELEGRAM_BOT_TOKEN": "123456:SYNTHETIC_TOKEN",
            "TELEGRAM_ALLOWED_USER_IDS": "777",
            "TELEGRAM_USERBOT_BOT_API_PROXY": "http://10.0.2.2:7890",
            "HTTPS_PROXY": "http://ambient.invalid:9999",
        }
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(
            onboarding.httpx, "AsyncClient", Client
        ):
            asyncio.run(onboarding._send_qr_to_bot(b"png", "caption"))

        self.assertEqual(
            calls["client"],
            {
                "timeout": 30,
                "proxy": "http://10.0.2.2:7890",
                "trust_env": False,
            },
        )
        self.assertEqual(calls["post"]["data"]["chat_id"], "777")
        self.assertEqual(calls["post"]["files"]["photo"][1], b"png")
        self.assertTrue(calls["status_checked"])

    def test_qr_failure_never_retains_or_logs_the_bot_token(self):
        token = "123456:TOP_SECRET_BOT_TOKEN"
        previous = os.environ.get("TELEGRAM_BOT_TOKEN")
        os.environ["TELEGRAM_BOT_TOKEN"] = token
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr):
                asyncio.run(onboarding._run_qr_login(FailingClient()))
            rendered = f"{onboarding._state} {stderr.getvalue()}"
            self.assertNotIn(token, rendered)
            self.assertEqual(onboarding._state["phase"], "error")
            self.assertEqual(onboarding._state["detail"], "qr_transport_failed")
        finally:
            if previous is None:
                os.environ.pop("TELEGRAM_BOT_TOKEN", None)
            else:
                os.environ["TELEGRAM_BOT_TOKEN"] = previous

    def test_qr_timeout_sends_only_one_image_and_reports_expired(self):
        qr = FakeQr(asyncio.TimeoutError())
        with mock.patch.object(
            onboarding, "_send_qr_to_bot", new=mock.AsyncMock()
        ) as send:
            asyncio.run(onboarding._run_qr_login(FakeQrClient(qr)))

        self.assertEqual(send.await_count, 1)
        self.assertEqual(qr.wait_calls, 1)
        self.assertEqual(onboarding._state["phase"], "expired")
        self.assertEqual(onboarding._state["detail"], "qr_expired")

    def test_qr_protocol_errors_are_classified_without_exception_text(self):
        cases = (
            (errors.AuthTokenExpiredError(request=None), "expired", "qr_expired"),
            (
                errors.AuthTokenAlreadyAcceptedError(request=None),
                "error",
                "qr_already_used",
            ),
            (errors.AuthTokenInvalidError(request=None), "error", "qr_invalid"),
            (TypeError("secret response body"), "error", "qr_unexpected_response"),
        )
        for exception, phase, detail in cases:
            with self.subTest(exception=type(exception).__name__), mock.patch.object(
                onboarding, "_send_qr_to_bot", new=mock.AsyncMock()
            ):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    asyncio.run(
                        onboarding._run_qr_login(FakeQrClient(FakeQr(exception)))
                    )
                self.assertEqual(onboarding._state, {"phase": phase, "detail": detail})
                self.assertNotIn("secret response body", stderr.getvalue())

    def test_qr_delivery_suppresses_http_client_urls_containing_bot_token(self):
        class Response:
            def raise_for_status(self):
                return None

        class Client:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, url, **_kwargs):
                logging.getLogger("httpx").info("HTTP Request: POST %s", url)
                return Response()

        token = "123456:SYNTHETIC_LOG_SECRET"
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("httpx")
        previous_level = logger.level
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        try:
            with mock.patch.dict(
                os.environ,
                {
                    "TELEGRAM_BOT_TOKEN": token,
                    "TELEGRAM_ALLOWED_USER_IDS": "777",
                },
                clear=False,
            ), mock.patch.object(onboarding.httpx, "AsyncClient", Client):
                asyncio.run(onboarding._send_qr_to_bot(b"png", "caption"))
            self.assertNotIn(token, stream.getvalue())
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous_level)


if __name__ == "__main__":
    unittest.main()
