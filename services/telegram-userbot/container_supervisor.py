#!/usr/bin/env python3
"""Container lifecycle for the Telegram userbot proxy.

The supervisor stays idle until private credentials, a bearer token, and the
explicit enable marker exist. It owns exactly one ``serve.py`` child and stops
that child when any prerequisite disappears or becomes invalid.
"""

import os
import re
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


EXPECTED_CREDENTIAL_KEYS = frozenset(
    {"TELEGRAM_API_ID", "TELEGRAM_API_HASH"}
)
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{40,}$")


@dataclass(frozen=True)
class RuntimePaths:
    credentials: Path
    token: Path
    enabled: Path


def read_private_file(path: Path) -> str:
    """Read one owner-private file through no-follow descriptors."""
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | nofollow)
    try:
        directory = os.fstat(directory_fd)
        if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.geteuid():
            raise ValueError(f"{path.parent.name} must be an owned directory")
        if stat.S_IMODE(directory.st_mode) & 0o077:
            raise ValueError(f"{path.parent.name} must have private permissions")
        try:
            file_fd = os.open(path.name, os.O_RDONLY | nofollow, dir_fd=directory_fd)
        except OSError as exc:
            if path.is_symlink():
                raise ValueError(f"{path.name} must be a regular file") from exc
            raise
        try:
            metadata = os.fstat(file_fd)
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError(f"{path.name} must be a regular file")
            if metadata.st_uid != os.geteuid():
                raise ValueError(f"{path.name} must be owned by the runtime user")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise ValueError(f"{path.name} must have private permissions")
            with os.fdopen(file_fd, "r", encoding="utf-8") as handle:
                file_fd = -1
                return handle.read()
        finally:
            if file_fd >= 0:
                os.close(file_fd)
    finally:
        os.close(directory_fd)


def load_credentials(path: Path) -> dict[str, str]:
    """Load the two expected values without evaluating shell syntax."""

    values: dict[str, str] = {}
    for raw_line in read_private_file(path).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if "=" not in line:
            raise ValueError("invalid credential line")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key not in EXPECTED_CREDENTIAL_KEYS:
            raise ValueError("unexpected credential key")
        if key in values:
            raise ValueError("duplicate credential key")
        values[key] = value

    if set(values) != EXPECTED_CREDENTIAL_KEYS:
        raise ValueError("both Telegram credentials are required")
    if not values["TELEGRAM_API_ID"].isdigit():
        raise ValueError("invalid TELEGRAM_API_ID")
    if not re.fullmatch(r"\S{8,}", values["TELEGRAM_API_HASH"]):
        raise ValueError("invalid TELEGRAM_API_HASH")
    return values


def _load_token(path: Path) -> str:
    token = read_private_file(path).strip()
    if not TOKEN_RE.fullmatch(token):
        raise ValueError("invalid proxy token")
    return token


def _require_enabled(path: Path) -> None:
    if read_private_file(path).strip() != "enabled":
        raise ValueError("invalid enable marker")


class Supervisor:
    def __init__(
        self,
        *,
        paths: RuntimePaths,
        serve_path: Path,
        python_path: Path = Path(sys.executable),
        popen: Callable = subprocess.Popen,
        retry_delay: float = 5.0,
    ) -> None:
        self.paths = paths
        self.serve_path = serve_path
        self.python_path = python_path
        self.popen = popen
        self.retry_delay = retry_delay
        self.child = None
        self.next_start = 0.0

    def _runtime_environment(self) -> dict[str, str]:
        _require_enabled(self.paths.enabled)
        credentials = load_credentials(self.paths.credentials)
        token = _load_token(self.paths.token)
        return {**os.environ, **credentials, "TELEGRAM_MCP_TOKEN": token}

    def _stop_child(self) -> None:
        if self.child is None:
            return
        child = self.child
        self.child = None
        if child.poll() is not None:
            return
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()

    def tick(self, *, now: float) -> None:
        try:
            environment = self._runtime_environment()
        except (OSError, UnicodeError, ValueError):
            self._stop_child()
            return

        if self.child is not None:
            if self.child.poll() is None:
                return
            self.child = None
            self.next_start = now + self.retry_delay
            return

        if now < self.next_start:
            return
        self.child = self.popen(
            [str(self.python_path), str(self.serve_path)],
            env=environment,
            close_fds=True,
        )

    def close(self) -> None:
        self._stop_child()


def _runtime_paths() -> RuntimePaths:
    data_dir = Path(os.getenv("ASSISTANT_DATA_DIR", "/app/data"))
    return RuntimePaths(
        credentials=Path(
            os.getenv(
                "TELEGRAM_USERBOT_CREDENTIALS_FILE",
                data_dir / "telegram-userbot.env",
            )
        ),
        token=data_dir / "telegram-userbot.token",
        enabled=data_dir / "telegram-userbot.enabled",
    )


def main() -> None:
    os.umask(0o077)
    supervisor = Supervisor(
        paths=_runtime_paths(),
        serve_path=Path(__file__).with_name("serve.py"),
    )
    print("telegram-userbot supervisor: waiting for enable marker", file=sys.stderr)
    try:
        while True:
            supervisor.tick(now=time.monotonic())
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        supervisor.close()


if __name__ == "__main__":
    main()
