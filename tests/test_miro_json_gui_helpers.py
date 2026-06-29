from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
sys.path.insert(0, str(MIRO_JSON_DIR))

spec = importlib.util.spec_from_file_location("miro_json_gui", MIRO_JSON_DIR / "GUI.py")
assert spec and spec.loader
miro_json_gui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(miro_json_gui)


class MiroJsonGuiHelperTests(unittest.TestCase):
    def test_resolve_gui_token_prefers_env_token_without_oauth(self) -> None:
        with patch.dict(os.environ, {"MIRO_ACCESS_TOKEN": "env-token"}, clear=True):
            with patch.object(miro_json_gui, "authorize_and_get_token") as oauth:
                self.assertEqual(miro_json_gui.resolve_gui_token(), "env-token")

        oauth.assert_not_called()

    def test_resolve_gui_token_falls_back_to_oauth(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(miro_json_gui, "authorize_and_get_token", return_value="oauth-token") as oauth:
                self.assertEqual(miro_json_gui.resolve_gui_token(), "oauth-token")

        oauth.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
