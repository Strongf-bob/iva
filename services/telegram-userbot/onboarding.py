"""Secret-safe phone onboarding for the single-owner Telethon sidecar.

Phone login is driven by deterministic, bearer-protected HTTP routes in
``serve.py``. Login material is never exposed as an MCP tool argument. The only
model-visible onboarding tool is the read-only ``login_status`` probe.
"""

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Callable

from telethon import errors

_FLOW_TTL_SECONDS = 300.0
_CODE_REQUEST_COOLDOWN_SECONDS = 30.0
_OPERATION_TIMEOUT_SECONDS = 15.0
_MAX_ATTEMPTS = 3
_PHONE = re.compile(r"^\+[0-9]{8,15}$")
_CODE = re.compile(r"^[0-9]{5,8}$")


def _result(state: str, reason: str) -> dict[str, str]:
    return {"state": state, "reason": reason}


@dataclass(repr=False)
class _PhoneFlow:
    phase: str = "idle"
    reason: str = "idle"
    phone: str | None = None
    phone_code_hash: str | None = None
    expires_at: float = 0.0
    code_attempts: int = 0
    password_attempts: int = 0


class PhoneLoginController:
    """One bounded in-memory login flow for one live Telethon client."""

    def __init__(
        self,
        client,
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._now = now
        self._lock = asyncio.Lock()
        self._flow = _PhoneFlow()
        self._last_code_request_at: float | None = None

    def _set_public(self, state: str, reason: str, *, wipe: bool = False) -> None:
        if wipe:
            self._flow.phone = None
            self._flow.phone_code_hash = None
            self._flow.expires_at = 0.0
            self._flow.code_attempts = 0
            self._flow.password_attempts = 0
        self._flow.phase = state
        self._flow.reason = reason

    def _expired(self) -> bool:
        return (
            self._flow.phase in {"code_sent", "password_needed"}
            and self._now() >= self._flow.expires_at
        )

    def _expire_if_needed(self) -> None:
        if self._expired():
            self._set_public("expired", "code_expired", wipe=True)

    def _public(self) -> dict[str, str]:
        return _result(self._flow.phase, self._flow.reason)

    def _safe_failure(self, reason: str) -> dict[str, str]:
        self._set_public("error", reason, wipe=True)
        return self._public()

    def _invalid_code(self) -> dict[str, str]:
        self._flow.code_attempts += 1
        if self._flow.code_attempts >= _MAX_ATTEMPTS:
            return self._safe_failure("attempt_limit")
        self._flow.reason = "code_invalid"
        return self._public()

    def _invalid_password(self) -> dict[str, str]:
        self._flow.password_attempts += 1
        if self._flow.password_attempts >= _MAX_ATTEMPTS:
            return self._safe_failure("attempt_limit")
        self._flow.reason = "password_invalid"
        return self._public()

    async def start(self, phone: str) -> dict[str, str]:
        async with self._lock:
            try:
                authorized = await asyncio.wait_for(
                    self._client.is_user_authorized(),
                    timeout=_OPERATION_TIMEOUT_SECONDS,
                )
            except Exception:  # noqa: BLE001 - fixed transport result only
                return self._safe_failure("transport_failed")
            if authorized:
                self._set_public("authorized", "ok", wipe=True)
                return self._public()
            if not _PHONE.fullmatch(phone):
                self._set_public("error", "phone_invalid", wipe=True)
                return self._public()
            now = self._now()
            if (
                self._last_code_request_at is not None
                and now - self._last_code_request_at < _CODE_REQUEST_COOLDOWN_SECONDS
            ):
                self._set_public("error", "phone_flood_wait", wipe=True)
                return self._public()
            self._last_code_request_at = now
            try:
                sent = await asyncio.wait_for(
                    self._client.send_code_request(phone),
                    timeout=_OPERATION_TIMEOUT_SECONDS,
                )
            except (
                errors.PhoneNumberInvalidError,
                errors.PhoneNumberBannedError,
                errors.PhoneNumberAppSignupForbiddenError,
            ):
                self._set_public("error", "phone_invalid", wipe=True)
                return self._public()
            except (
                errors.FloodWaitError,
                errors.PhoneNumberFloodError,
                errors.SendCodeUnavailableError,
            ):
                return self._safe_failure("phone_flood_wait")
            except Exception:  # noqa: BLE001 - raw transport details are secret-adjacent
                return self._safe_failure("transport_failed")

            phone_code_hash = getattr(sent, "phone_code_hash", None)
            if not isinstance(phone_code_hash, str) or not phone_code_hash:
                return self._safe_failure("transport_failed")
            self._flow = _PhoneFlow(
                phase="code_sent",
                reason="code_sent",
                phone=phone,
                phone_code_hash=phone_code_hash,
                expires_at=now + _FLOW_TTL_SECONDS,
            )
            return self._public()

    async def submit_code(self, code: str) -> dict[str, str]:
        async with self._lock:
            self._expire_if_needed()
            if self._flow.phase != "code_sent":
                return _result("error", "flow_missing")
            if not _CODE.fullmatch(code):
                return self._invalid_code()

            phone = self._flow.phone
            phone_code_hash = self._flow.phone_code_hash
            if phone is None or phone_code_hash is None:
                return self._safe_failure("flow_missing")
            try:
                await asyncio.wait_for(
                    self._client.sign_in(
                        phone,
                        code,
                        phone_code_hash=phone_code_hash,
                    ),
                    timeout=_OPERATION_TIMEOUT_SECONDS,
                )
            except errors.SessionPasswordNeededError:
                self._flow.phone = None
                self._flow.phone_code_hash = None
                self._flow.phase = "password_needed"
                self._flow.reason = "password_needed"
                self._flow.code_attempts = 0
                return self._public()
            except (errors.PhoneCodeInvalidError, errors.CodeInvalidError):
                return self._invalid_code()
            except (
                errors.PhoneCodeExpiredError,
                errors.PhoneCodeHashEmptyError,
                errors.PhoneHashExpiredError,
            ):
                self._set_public("expired", "code_expired", wipe=True)
                return self._public()
            except Exception:  # noqa: BLE001 - never surface provider messages
                return self._safe_failure("transport_failed")

            self._set_public("authorized", "ok", wipe=True)
            return self._public()

    async def submit_password(self, password: str) -> dict[str, str]:
        async with self._lock:
            self._expire_if_needed()
            if self._flow.phase != "password_needed":
                return _result("error", "flow_missing")
            if not 1 <= len(password) <= 256:
                return self._invalid_password()
            try:
                await asyncio.wait_for(
                    self._client.sign_in(password=password),
                    timeout=_OPERATION_TIMEOUT_SECONDS,
                )
            except (
                errors.PasswordHashInvalidError,
                errors.PasswordEmptyError,
            ):
                return self._invalid_password()
            except errors.FloodWaitError:
                return self._safe_failure("phone_flood_wait")
            except Exception:  # noqa: BLE001 - never surface provider messages
                return self._safe_failure("transport_failed")

            self._set_public("authorized", "ok", wipe=True)
            return self._public()

    async def cancel(self) -> dict[str, str]:
        async with self._lock:
            self._set_public("idle", "cancelled", wipe=True)
            return self._public()

    async def status(self) -> dict[str, str]:
        async with self._lock:
            try:
                authorized = await asyncio.wait_for(
                    self._client.is_user_authorized(),
                    timeout=_OPERATION_TIMEOUT_SECONDS,
                )
            except Exception:  # noqa: BLE001 - fixed transport result only
                return self._safe_failure("transport_failed")
            if authorized:
                self._set_public("authorized", "ok", wipe=True)
            else:
                self._expire_if_needed()
            return self._public()


def register_onboarding_tools(mcp, client, controller=None) -> PhoneLoginController:
    """Register the one model-visible read-only login probe."""
    from mcp.types import ToolAnnotations

    controller = controller or PhoneLoginController(client)

    async def login_status() -> str:
        """Подключён ли личный Telegram? Не принимает логин, код или пароль."""
        result = await controller.status()
        if result["state"] == "authorized":
            return "connected"
        return f"not_connected (state={result['state']}, reason={result['reason']})"

    mcp.add_tool(
        login_status,
        name=login_status.__name__,
        description=login_status.__doc__,
        annotations=ToolAnnotations(readOnlyHint=True),
    )
    return controller
