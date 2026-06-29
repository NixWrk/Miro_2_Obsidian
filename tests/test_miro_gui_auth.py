from __future__ import annotations

import os
import inspect
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

sys.path.insert(0, str(MIRO_JSON_DIR))

import auth  # noqa: E402


class MiroGuiAuthTests(unittest.TestCase):
    def test_gui_auth_has_no_bundled_client_secret(self) -> None:
        source = inspect.getsource(auth)

        self.assertEqual(auth.CLIENT_SECRET, "")
        self.assertNotIn("bddm", source)

    def test_gui_auth_uses_localhost_loopback_redirect(self) -> None:
        self.assertEqual(auth.REDIRECT_URI, "http://localhost:8000/callback")
        with patch.dict(os.environ, {"MIRO_CLIENT_ID": "client-1"}, clear=True):
            self.assertIn("redirect_uri=http://localhost:8000/callback", auth.build_authorize_url())

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

    def test_open_authentication_page_opens_direct_oauth_url_instead_of_popup(self) -> None:
        with patch.dict(os.environ, {"MIRO_CLIENT_ID": "client-1"}, clear=True):
            expected_url = auth.build_authorize_url()
            with patch("auth.open_in_yandex", return_value=True) as yandex:
                with patch("auth.webbrowser.open") as browser:
                    self.assertTrue(auth.open_authentication_page())

        yandex.assert_called_once_with(expected_url)
        self.assertNotIn("/popup", yandex.call_args.args[0])
        browser.assert_not_called()

    def test_open_authentication_page_falls_back_to_default_browser(self) -> None:
        with patch.dict(os.environ, {"MIRO_CLIENT_ID": "client-1"}, clear=True):
            expected_url = auth.build_authorize_url()
            with patch("auth.open_in_yandex", return_value=False) as yandex:
                with patch("auth.webbrowser.open", return_value=True) as browser:
                    self.assertTrue(auth.open_authentication_page())

        yandex.assert_called_once_with(expected_url)
        browser.assert_called_once_with(expected_url)

    def test_authorize_requires_user_oauth_credentials(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "MIRO_CLIENT_ID and MIRO_CLIENT_SECRET"):
                auth.authorize_and_get_token()


if __name__ == "__main__":
    unittest.main()
