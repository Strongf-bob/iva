import asyncio
import contextlib
import io
import os
import unittest

import onboarding


class FailingClient:
    async def qr_login(self):
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        raise RuntimeError(f"POST https://api.telegram.org/bot{token}/sendPhoto failed")


class OnboardingSafetyTest(unittest.TestCase):
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
