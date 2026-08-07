import tempfile
import unittest
from pathlib import Path

from container_supervisor import RuntimePaths, Supervisor, load_credentials, read_private_file


VALID_CREDENTIALS = (
    "TELEGRAM_API_ID=12345\n"
    "TELEGRAM_API_HASH=abcdef123456\n"
)


class FakeChild:
    def __init__(self):
        self.returncode = None
        self.terminated = 0
        self.killed = 0
        self.waited = []

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated += 1

    def kill(self):
        self.killed += 1

    def wait(self, timeout=None):
        self.waited.append(timeout)
        return 0


class ContainerSupervisorTest(unittest.TestCase):
    def private_file(self, path: Path, text: str):
        path.write_text(text, encoding="utf-8")
        path.chmod(0o600)

    def test_credentials_accept_only_expected_private_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "telegram-userbot.env"
            self.private_file(path, VALID_CREDENTIALS)
            self.assertEqual(
                load_credentials(path),
                {
                    "TELEGRAM_API_ID": "12345",
                    "TELEGRAM_API_HASH": "abcdef123456",
                },
            )

            self.private_file(path, VALID_CREDENTIALS + "EXTRA=x\n")
            with self.assertRaisesRegex(ValueError, "unexpected credential key"):
                load_credentials(path)

            self.private_file(path, VALID_CREDENTIALS)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private permissions"):
                load_credentials(path)

    def test_credentials_reject_duplicates_invalid_values_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "telegram-userbot.env"
            self.private_file(
                path,
                VALID_CREDENTIALS + "TELEGRAM_API_ID=67890\n",
            )
            with self.assertRaisesRegex(ValueError, "duplicate credential key"):
                load_credentials(path)

            self.private_file(
                path,
                "TELEGRAM_API_ID=nope\nTELEGRAM_API_HASH=abcdef123456\n",
            )
            with self.assertRaisesRegex(ValueError, "invalid TELEGRAM_API_ID"):
                load_credentials(path)

            target = root / "real.env"
            self.private_file(target, VALID_CREDENTIALS)
            path.unlink()
            path.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "regular file"):
                load_credentials(path)

    def test_private_reader_rejects_foreign_owner_and_parent_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.mkdir(mode=0o700)
            path = real / "token"
            self.private_file(path, "secret")
            alias = root / "alias"
            alias.symlink_to(real, target_is_directory=True)
            with self.assertRaises((OSError, ValueError)):
                read_private_file(alias / "token")

    def test_marker_removal_stops_the_only_child_without_exposing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = root / "telegram-userbot.env"
            token = root / "telegram-userbot.token"
            enabled = root / "telegram-userbot.enabled"
            self.private_file(credentials, VALID_CREDENTIALS)
            self.private_file(token, "synthetic-bearer-token-value-with-length\n")
            self.private_file(enabled, "enabled\n")
            paths = RuntimePaths(credentials, token, enabled)
            child = FakeChild()
            starts = []

            def popen(argv, *, env, close_fds):
                starts.append((argv, env.copy(), close_fds))
                return child

            supervisor = Supervisor(
                paths=paths,
                serve_path=root / "serve.py",
                python_path=Path("/fixed/python"),
                popen=popen,
            )

            supervisor.tick(now=0)
            supervisor.tick(now=1)
            self.assertEqual(len(starts), 1)
            self.assertIs(supervisor.child, child)
            self.assertEqual(starts[0][0], ["/fixed/python", str(root / "serve.py")])
            self.assertTrue(starts[0][2])
            self.assertEqual(starts[0][1]["TELEGRAM_API_ID"], "12345")
            self.assertEqual(starts[0][1]["TELEGRAM_API_HASH"], "abcdef123456")
            self.assertEqual(
                starts[0][1]["TELEGRAM_MCP_TOKEN"],
                "synthetic-bearer-token-value-with-length",
            )

            enabled.unlink()
            supervisor.tick(now=2)
            self.assertEqual(child.terminated, 1)
            self.assertEqual(child.killed, 0)
            self.assertEqual(child.waited, [10])
            self.assertIsNone(supervisor.child)

    def test_unexpected_exit_observes_retry_delay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = root / "telegram-userbot.env"
            token = root / "telegram-userbot.token"
            enabled = root / "telegram-userbot.enabled"
            self.private_file(credentials, VALID_CREDENTIALS)
            self.private_file(token, "synthetic-bearer-token-value-with-length\n")
            self.private_file(enabled, "enabled\n")
            children = [FakeChild(), FakeChild()]
            starts = []

            def popen(argv, *, env, close_fds):
                starts.append(argv)
                return children[len(starts) - 1]

            supervisor = Supervisor(
                paths=RuntimePaths(credentials, token, enabled),
                serve_path=root / "serve.py",
                python_path=Path("/fixed/python"),
                popen=popen,
                retry_delay=5,
            )
            supervisor.tick(now=0)
            children[0].returncode = 1
            supervisor.tick(now=1)
            supervisor.tick(now=5)
            self.assertEqual(len(starts), 1)
            supervisor.tick(now=6)
            self.assertEqual(len(starts), 2)


if __name__ == "__main__":
    unittest.main()
