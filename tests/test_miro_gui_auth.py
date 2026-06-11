from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

sys.path.insert(0, str(MIRO_JSON_DIR))

import auth  # noqa: E402


class MiroGuiAuthTests(unittest.TestCase):
    def test_gui_auth_uses_127_loopback_redirect(self) -> None:
        self.assertEqual(auth.REDIRECT_URI, "http://127.0.0.1:8000/callback")
        self.assertIn("redirect_uri=http://127.0.0.1:8000/callback", auth.AUTH_URL)

    def test_open_in_yandex_uses_local_app_data_browser(self) -> None:
        browser = str(Path("C:/Users/me/AppData/Local/Yandex/YandexBrowser/Application/browser.exe"))
        with patch.dict(os.environ, {"LOCALAPPDATA": str(Path("C:/Users/me/AppData/Local"))}, clear=True):
            with patch("auth.os.path.isfile", side_effect=lambda path: path == browser):
                with patch("auth.subprocess.Popen") as popen:
                    self.assertTrue(auth.open_in_yandex("https://example.invalid/oauth"))

        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], [browser, "https://example.invalid/oauth"])

    def test_open_in_yandex_returns_false_without_browser(self) -> None:
        with patch("auth.os.path.isfile", return_value=False):
            with patch("auth.subprocess.Popen") as popen:
                self.assertFalse(auth.open_in_yandex("https://example.invalid/oauth"))

        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
