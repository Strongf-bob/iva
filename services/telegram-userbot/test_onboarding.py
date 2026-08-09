import asyncio
import contextlib
import io
import unittest
from types import SimpleNamespace
from unittest import mock

import onboarding
from telethon import errors


PHONE = "+79991234567"
CODE = "12345"
PASSWORD = "synthetic-password-canary"


class FakeClient:
    def __init__(self, sign_in_outcomes=(), *, send_code_error=None):
        self.authorized = False
        self.sign_in_outcomes = list(sign_in_outcomes)
        self.send_code_error = send_code_error
        self.send_code_calls = []
        self.sign_in_calls = []

    async def is_user_authorized(self):
        return self.authorized

    async def send_code_request(self, phone):
        self.send_code_calls.append(phone)
        if self.send_code_error is not None:
            raise self.send_code_error
        return SimpleNamespace(phone_code_hash="synthetic_hash", timeout=120)

    async def sign_in(self, phone=None, code=None, *, password=None, phone_code_hash=None):
        self.sign_in_calls.append(
            {
                "phone": phone,
                "code": code,
                "password": password,
                "phone_code_hash": phone_code_hash,
            }
        )
        if self.sign_in_outcomes:
            outcome = self.sign_in_outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
        self.authorized = True
        return SimpleNamespace(id=1)


class PhoneLoginControllerTest(unittest.TestCase):
    def test_phone_code_authorizes_and_clears_private_flow_state(self):
        async def scenario():
            client = FakeClient()
            controller = onboarding.PhoneLoginController(client, now=lambda: 100.0)

            self.assertEqual(
                await controller.start(PHONE),
                {"state": "code_sent", "reason": "code_sent"},
            )
            self.assertEqual(
                await controller.submit_code(CODE),
                {"state": "authorized", "reason": "ok"},
            )
            self.assertEqual(
                client.sign_in_calls,
                [
                    {
                        "phone": PHONE,
                        "code": CODE,
                        "password": None,
                        "phone_code_hash": "synthetic_hash",
                    }
                ],
            )
            self.assertEqual(await controller.status(), {"state": "authorized", "reason": "ok"})
            self.assertNotIn(PHONE, repr(controller))
            self.assertNotIn("synthetic_hash", repr(controller))

        asyncio.run(scenario())

    def test_code_can_transition_to_2fa_without_retaining_password(self):
        async def scenario():
            client = FakeClient([errors.SessionPasswordNeededError(request=None)])
            controller = onboarding.PhoneLoginController(client, now=lambda: 100.0)

            await controller.start(PHONE)
            self.assertEqual(
                await controller.submit_code(CODE),
                {"state": "password_needed", "reason": "password_needed"},
            )
            self.assertEqual(
                await controller.submit_password(PASSWORD),
                {"state": "authorized", "reason": "ok"},
            )
            self.assertEqual(client.sign_in_calls[-1]["password"], PASSWORD)
            self.assertNotIn(PASSWORD, repr(controller))

        asyncio.run(scenario())

    def test_2fa_keeps_the_original_absolute_flow_deadline(self):
        async def scenario():
            clock = [100.0]
            client = FakeClient([errors.SessionPasswordNeededError(request=None)])
            controller = onboarding.PhoneLoginController(client, now=lambda: clock[0])

            await controller.start(PHONE)
            clock[0] = 399.0
            self.assertEqual(
                await controller.submit_code(CODE),
                {"state": "password_needed", "reason": "password_needed"},
            )
            clock[0] = 400.0
            self.assertEqual(
                await controller.submit_password(PASSWORD),
                {"state": "error", "reason": "flow_missing"},
            )
            self.assertEqual(len(client.sign_in_calls), 1)

        asyncio.run(scenario())

    def test_invalid_code_is_bounded_to_three_attempts(self):
        async def scenario():
            invalid = [errors.PhoneCodeInvalidError(request=None) for _ in range(3)]
            controller = onboarding.PhoneLoginController(
                FakeClient(invalid), now=lambda: 100.0
            )
            await controller.start(PHONE)

            for _ in range(2):
                self.assertEqual(
                    await controller.submit_code("54321"),
                    {"state": "code_sent", "reason": "code_invalid"},
                )
            self.assertEqual(
                await controller.submit_code("54321"),
                {"state": "error", "reason": "attempt_limit"},
            )
            self.assertEqual(
                await controller.submit_code("54321"),
                {"state": "error", "reason": "flow_missing"},
            )

        asyncio.run(scenario())

    def test_invalid_password_is_bounded_to_three_attempts(self):
        async def scenario():
            outcomes = [errors.SessionPasswordNeededError(request=None)] + [
                errors.PasswordHashInvalidError(request=None) for _ in range(3)
            ]
            controller = onboarding.PhoneLoginController(
                FakeClient(outcomes), now=lambda: 100.0
            )
            await controller.start(PHONE)
            await controller.submit_code(CODE)

            for _ in range(2):
                self.assertEqual(
                    await controller.submit_password("wrong-password"),
                    {"state": "password_needed", "reason": "password_invalid"},
                )
            self.assertEqual(
                await controller.submit_password("wrong-password"),
                {"state": "error", "reason": "attempt_limit"},
            )

        asyncio.run(scenario())

    def test_expiry_cancel_and_restart_wipe_the_previous_flow(self):
        async def scenario():
            clock = [100.0]
            first = FakeClient()
            controller = onboarding.PhoneLoginController(first, now=lambda: clock[0])
            await controller.start(PHONE)
            clock[0] = 401.0
            self.assertEqual(
                await controller.status(),
                {"state": "expired", "reason": "code_expired"},
            )
            self.assertEqual(
                await controller.submit_code(CODE),
                {"state": "error", "reason": "flow_missing"},
            )

            clock[0] = 500.0
            await controller.start(PHONE)
            self.assertEqual(
                await controller.cancel(), {"state": "idle", "reason": "cancelled"}
            )
            self.assertNotIn(PHONE, repr(controller))

            clock[0] = 531.0
            await controller.start(PHONE)
            clock[0] = 562.0
            await controller.start("+447700900123")
            self.assertEqual(first.send_code_calls[-1], "+447700900123")
            self.assertNotIn(PHONE, repr(controller))

        asyncio.run(scenario())

    def test_repeated_code_requests_are_locally_rate_limited(self):
        async def scenario():
            clock = [100.0]
            client = FakeClient()
            controller = onboarding.PhoneLoginController(client, now=lambda: clock[0])

            self.assertEqual(
                await controller.start(PHONE),
                {"state": "code_sent", "reason": "code_sent"},
            )
            clock[0] = 101.0
            self.assertEqual(
                await controller.start("+447700900123"),
                {"state": "error", "reason": "phone_flood_wait"},
            )
            self.assertEqual(client.send_code_calls, [PHONE])

            clock[0] = 131.0
            self.assertEqual(
                await controller.start("+447700900123"),
                {"state": "code_sent", "reason": "code_sent"},
            )
            self.assertEqual(client.send_code_calls, [PHONE, "+447700900123"])

        asyncio.run(scenario())

    def test_hung_telethon_operation_times_out_and_releases_the_lock(self):
        class HangingClient(FakeClient):
            async def send_code_request(self, phone):
                self.send_code_calls.append(phone)
                await asyncio.Event().wait()

        async def scenario():
            clock = [100.0]
            client = HangingClient()
            controller = onboarding.PhoneLoginController(client, now=lambda: clock[0])

            with mock.patch.object(onboarding, "_OPERATION_TIMEOUT_SECONDS", 0.01):
                self.assertEqual(
                    await asyncio.wait_for(controller.start(PHONE), timeout=0.2),
                    {"state": "error", "reason": "transport_failed"},
                )
                clock[0] = 131.0
                client.send_code_request = FakeClient.send_code_request.__get__(client)
                self.assertEqual(
                    await asyncio.wait_for(controller.start(PHONE), timeout=0.2),
                    {"state": "code_sent", "reason": "code_sent"},
                )

        asyncio.run(scenario())

    def test_validation_and_telethon_failures_return_fixed_secret_free_reasons(self):
        async def scenario():
            cases = (
                ("invalid", {"state": "error", "reason": "phone_invalid"}),
                (
                    "+1234567",
                    {"state": "error", "reason": "phone_invalid"},
                ),
            )
            controller = onboarding.PhoneLoginController(FakeClient(), now=lambda: 100.0)
            for phone, expected in cases:
                self.assertEqual(await controller.start(phone), expected)

            banned = onboarding.PhoneLoginController(
                FakeClient(send_code_error=errors.PhoneNumberBannedError(request=None)),
                now=lambda: 100.0,
            )
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = await banned.start(PHONE)
            self.assertEqual(result, {"state": "error", "reason": "phone_invalid"})
            self.assertNotIn(PHONE, stderr.getvalue())

            transport = onboarding.PhoneLoginController(
                FakeClient(send_code_error=RuntimeError(f"transport failed for {PHONE}")),
                now=lambda: 100.0,
            )
            with contextlib.redirect_stderr(stderr):
                result = await transport.start(PHONE)
            self.assertEqual(
                result, {"state": "error", "reason": "transport_failed"}
            )
            self.assertNotIn(PHONE, stderr.getvalue())

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
