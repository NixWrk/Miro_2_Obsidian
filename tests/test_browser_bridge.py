from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from miro2obsidian.browser_bridge import (
    PROFILE_ENV,
    BrowserBridgeUnavailable,
    BrowserLoginRequired,
    _prepare_miro_page,
    _cdp_url,
    browser_profile_dir,
    start_browser_bridge,
)


class BrowserBridgeTests(unittest.TestCase):
    def test_first_login_opens_sign_in_before_board(self) -> None:
        page = Mock()
        messages = []
        with patch("miro2obsidian.browser_bridge._authenticated_miro_page",
                   side_effect=[False, True, True]):
            _prepare_miro_page(Mock(), page, "https://miro.com/app/board/example=/",
                               login_timeout_seconds=2, on_status=messages.append)
        self.assertEqual([call.args[0] for call in page.goto.call_args_list], [
            "https://miro.com/app/dashboard/",
            "https://miro.com/login/",
            "https://miro.com/app/board/example=/",
        ])
        self.assertEqual(len(messages), 2)

    def test_unfinished_login_stops_before_agent_starts(self) -> None:
        page = Mock()
        with patch("miro2obsidian.browser_bridge._authenticated_miro_page", return_value=False):
            with self.assertRaises(BrowserLoginRequired):
                _prepare_miro_page(Mock(), page, "https://miro.com/app/board/example=/",
                                   login_timeout_seconds=0, on_status=None)
        self.assertEqual(page.goto.call_count, 2)

    def test_separate_process_can_use_temporary_browser(self) -> None:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            if not Path(playwright.chromium.executable_path).is_file():
                self.skipTest("Playwright Chromium is not installed")
        child = (
            "import sys; from playwright.sync_api import sync_playwright; "
            "p=sync_playwright().start(); b=p.chromium.connect_over_cdp(sys.argv[1]); "
            "print(b.contexts[0].pages[0].title()); b.close(); p.stop()"
        )
        with tempfile.TemporaryDirectory() as temp:
            with start_browser_bridge(
                "data:text/html,<title>bridge-smoke</title>",
                profile_dir=Path(temp),
                headless=True,
                install_missing=False,
            ) as bridge:
                completed = subprocess.run(
                    [sys.executable, "-c", child, bridge.cdp_url],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout.strip(), "bridge-smoke")

    def test_profile_override_is_not_tied_to_a_machine(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {PROFILE_ENV: temp}):
                self.assertEqual(browser_profile_dir(), Path(temp).resolve())

    def test_cdp_endpoint_is_loopback_and_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            (profile / "DevToolsActivePort").write_text("32123\n/devtools/browser/test\n", encoding="ascii")

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    return None

                def read(self):
                    return json.dumps({"Browser": "Chrome/123"}).encode()

            with patch("miro2obsidian.browser_bridge.urlopen", return_value=Response()) as open_url:
                self.assertEqual(_cdp_url(profile), "http://127.0.0.1:32123")
            open_url.assert_called_once_with("http://127.0.0.1:32123/json/version", timeout=3)

    def test_rejects_invalid_browser_port(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            (profile / "DevToolsActivePort").write_text("99999\n", encoding="ascii")
            with self.assertRaisesRegex(BrowserBridgeUnavailable, "invalid local debugging port"):
                _cdp_url(profile)
