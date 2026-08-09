import os
import tempfile
import unittest
from pathlib import Path


_session_dir = tempfile.TemporaryDirectory()
os.environ["TELEGRAM_API_ID"] = "12345"
os.environ["TELEGRAM_API_HASH"] = "abcdef123456"
os.environ["TELEGRAM_SESSION_NAME"] = str(Path(_session_dir.name) / "session")
os.environ["TELEGRAM_EXPOSED_TOOLS"] = "read-only"

from onboarding import register_onboarding_tools  # noqa: E402
from serve import APPROVED_READ_ONLY_TOOLS, apply_exposed_tool_policy  # noqa: E402
from telegram_mcp.runtime import mcp, _apply_exposed_tools_mode  # noqa: E402
import telegram_mcp.tools  # noqa: E402,F401


ONBOARDING_TOOLS = {"login_status"}
REMOVED_QR_TOOLS = {"qr_login_start", "qr_login_status", "qr_login_password"}


class ReadOnlyRegistryTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        _session_dir.cleanup()

    def test_effective_registry_is_an_explicit_read_only_allowlist(self):
        apply_exposed_tool_policy(
            mcp,
            upstream_apply=_apply_exposed_tools_mode,
            mode="read-only",
        )
        names = {tool.name for tool in mcp._tool_manager.list_tools()}
        self.assertEqual(names, APPROVED_READ_ONLY_TOOLS)
        self.assertIn("list_chats", names)
        self.assertIn("get_messages", names)
        self.assertIn("search_messages", names)
        self.assertNotIn("send_message", names)
        self.assertNotIn("edit_message", names)
        self.assertNotIn("delete_message", names)
        self.assertNotIn("join_chat_by_link", names)
        self.assertNotIn("get_invite_link", names)
        self.assertNotIn("export_chat_invite", names)

    def test_onboarding_is_the_only_addition_after_read_only_pruning(self):
        register_onboarding_tools(mcp, object())
        tools = list(mcp._tool_manager.list_tools())
        names = {tool.name for tool in tools}
        self.assertEqual(names, APPROVED_READ_ONLY_TOOLS | ONBOARDING_TOOLS)
        self.assertTrue(REMOVED_QR_TOOLS.isdisjoint(names))
        for tool in tools:
            self.assertEqual(
                getattr(tool.annotations, "readOnlyHint", False),
                True,
                f"incorrect readOnlyHint: {tool.name}",
            )


if __name__ == "__main__":
    unittest.main()
