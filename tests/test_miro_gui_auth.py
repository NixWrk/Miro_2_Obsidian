from __future__ import annotations

import inspect
import unittest
from unittest.mock import patch



from Miro_2_Json import auth


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
        with patch("Miro_2_Json.auth.config_from_env", return_value=config) as load_config:
            with patch(
                "Miro_2_Json.auth._authorize_and_get_token", return_value="token-1"
            ) as authorize:
                self.assertEqual(auth.authorize_and_get_token(), "token-1")

        load_config.assert_called_once_with()
        authorize.assert_called_once_with(config)

    def test_gui_auth_requires_user_oauth_credentials(self) -> None:
        with patch(
            "Miro_2_Json.auth.config_from_env",
            side_effect=RuntimeError("MIRO_CLIENT_ID and MIRO_CLIENT_SECRET"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "MIRO_CLIENT_ID and MIRO_CLIENT_SECRET"
            ):
                auth.authorize_and_get_token()


if __name__ == "__main__":
    unittest.main()
