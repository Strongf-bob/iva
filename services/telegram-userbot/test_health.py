import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from serve import _health_payload, _seed_session_env


class FakeClient:
    def __init__(self, authorized):
        self.authorized = authorized
        self.calls = 0

    async def is_user_authorized(self):
        self.calls += 1
        return self.authorized


class HealthPayloadTest(unittest.TestCase):
    def test_uses_the_existing_client_for_unauthorized_health(self):
        client = FakeClient(False)

        payload = asyncio.run(_health_payload(client))

        self.assertEqual(payload, {"state": "unauthorized"})
        self.assertEqual(client.calls, 1)

    def test_uses_the_existing_client_for_ready_health(self):
        client = FakeClient(True)

        payload = asyncio.run(_health_payload(client))

        self.assertEqual(payload, {"state": "ready"})
        self.assertEqual(client.calls, 1)

    def test_session_path_rejects_symlinks_and_public_permissions(self):
        previous = os.environ.get("TELEGRAM_SESSION_FILE")
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                root.chmod(0o700)
                target = root / "target.session"
                target.write_text("secret", encoding="utf-8")
                target.chmod(0o600)
                session = root / "telegram-userbot.session"
                session.symlink_to(target)
                os.environ["TELEGRAM_SESSION_FILE"] = str(session)
                with self.assertRaises(SystemExit):
                    _seed_session_env()

                session.unlink()
                session.write_text("secret", encoding="utf-8")
                session.chmod(0o644)
                with self.assertRaises(SystemExit):
                    _seed_session_env()
        finally:
            if previous is None:
                os.environ.pop("TELEGRAM_SESSION_FILE", None)
            else:
                os.environ["TELEGRAM_SESSION_FILE"] = previous


if __name__ == "__main__":
    unittest.main()
