import asyncio
import contextlib
import io
import os
import unittest
from unittest import mock

import onboarding


class FailingClient:
    async def qr_login(self):
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        raise RuntimeError(f"POST https://api.telegram.org/bot{token}/sendPhoto failed")


class OnboardingSafetyTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
