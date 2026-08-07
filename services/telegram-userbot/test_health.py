import asyncio
import os
import tempfile
import unittest
from pathlib import Path

import httpx
from starlette.applications import Starlette

from serve import (
    BearerAuthMiddleware,
    _health_payload,
    _seed_session_env,
    add_phone_onboarding_routes,
)


class FakeClient:
    def __init__(self, authorized):
        self.authorized = authorized
        self.calls = 0

    async def is_user_authorized(self):
        self.calls += 1
        return self.authorized


class FakeOnboardingController:
    def __init__(self):
        self.calls = []

    async def start(self, phone):
        self.calls.append(("start", phone))
        return {"state": "code_sent", "reason": "code_sent"}

    async def submit_code(self, code):
        self.calls.append(("code", code))
        return {"state": "password_needed", "reason": "password_needed"}

    async def submit_password(self, password):
        self.calls.append(("password", password))
        return {"state": "authorized", "reason": "ok"}

    async def cancel(self):
        self.calls.append(("cancel", None))
        return {"state": "idle", "reason": "cancelled"}

    async def status(self):
        self.calls.append(("status", None))
        return {"state": "code_sent", "reason": "code_sent"}


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


class PhoneOnboardingRouteTest(unittest.TestCase):
    def setUp(self):
        self.controller = FakeOnboardingController()
        app = Starlette()
        add_phone_onboarding_routes(app, self.controller)
        app.add_middleware(BearerAuthMiddleware, token="synthetic-bearer")
        self.app = app
        self.headers = {"authorization": "Bearer synthetic-bearer"}

    def request(self, method, path, **kwargs):
        async def send():
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://testserver"
            ) as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def test_bearer_auth_rejects_before_controller_dispatch(self):
        response = self.request(
            "POST",
            "/onboarding/phone/start", json={"phone": "+79991234567"}
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})
        self.assertEqual(self.controller.calls, [])

    def test_routes_dispatch_only_the_expected_string_field(self):
        requests = (
            ("post", "/onboarding/phone/start", {"phone": "+79991234567"}),
            ("post", "/onboarding/phone/code", {"code": "12345"}),
            ("post", "/onboarding/phone/password", {"password": "canary"}),
            ("post", "/onboarding/phone/cancel", None),
            ("get", "/onboarding/phone/status", None),
        )
        for method, path, payload in requests:
            response = self.request(
                method, path, headers=self.headers, json=payload
            )
            self.assertEqual(response.status_code, 200, path)
            self.assertEqual(set(response.json()), {"state", "reason"}, path)

        self.assertEqual(
            self.controller.calls,
            [
                ("start", "+79991234567"),
                ("code", "12345"),
                ("password", "canary"),
                ("cancel", None),
                ("status", None),
            ],
        )

    def test_invalid_json_and_field_types_fail_closed(self):
        malformed = self.request(
            "POST",
            "/onboarding/phone/start",
            headers={**self.headers, "content-type": "application/json"},
            content=b"not-json",
        )
        wrong_type = self.request(
            "POST",
            "/onboarding/phone/code", headers=self.headers, json={"code": 12345}
        )

        self.assertEqual(malformed.status_code, 400)
        self.assertEqual(malformed.json(), {"state": "error", "reason": "invalid_request"})
        self.assertEqual(wrong_type.status_code, 400)
        self.assertEqual(wrong_type.json(), {"state": "error", "reason": "invalid_request"})
        self.assertEqual(self.controller.calls, [])


if __name__ == "__main__":
    unittest.main()
