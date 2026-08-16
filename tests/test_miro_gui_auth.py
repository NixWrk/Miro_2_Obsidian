from __future__ import annotations

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
    def test_gui_auth_defaults_are_read_only_and_loopback(self) -> None:
        self.assertEqual(auth.DEFAULT_SCOPES, "boards:read team:read")
        self.assertEqual(auth.REDIRECT_URI, "http://localhost:8765/callback")

    def test_gui_auth_has_no_bundled_client_secret(self) -> None:
        source = inspect.getsource(auth)

        self.assertEqual(auth.CLIENT_SECRET, "")
        self.assertNotIn("bddm", source)

    def test_gui_auth_delegates_to_shared_oauth_implementation(self) -> None:
        config = object()
        with patch("auth.config_from_env", return_value=config) as load_config:
            with patch(
                "auth._authorize_and_get_token", return_value="token-1"
            ) as authorize:
                self.assertEqual(auth.authorize_and_get_token(), "token-1")

        load_config.assert_called_once_with()
        authorize.assert_called_once_with(config)

    def test_gui_auth_requires_user_oauth_credentials(self) -> None:
        with patch(
            "auth.config_from_env",
            side_effect=RuntimeError("MIRO_CLIENT_ID and MIRO_CLIENT_SECRET"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "MIRO_CLIENT_ID and MIRO_CLIENT_SECRET"
            ):
                auth.authorize_and_get_token()


if __name__ == "__main__":
    unittest.main()
