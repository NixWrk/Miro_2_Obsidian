from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from Miro_2_Obsidian_GUI import authorize_gui_token, board_id_from_text, board_refs_from_file


class MiroObsidianGuiHelperTests(unittest.TestCase):
    def test_board_id_from_text_accepts_full_miro_url_or_raw_id(self) -> None:
        self.assertEqual(
            board_id_from_text("https://miro.com/app/board/uXjVTest123=/?share_link_id=1"),
            "uXjVTest123=",
        )
        self.assertEqual(board_id_from_text("uXjVRaw123="), "uXjVRaw123=")

    def test_board_refs_from_markdown_extracts_unique_links(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boards.md"
            path.write_text(
                "\n".join(
                    [
                        "- [Alpha](https://miro.com/app/board/uXjAlpha=/)",
                        "- [Alpha duplicate](https://miro.com/app/board/uXjAlpha=/)",
                        "- [Beta](https://miro.com/app/board/uXjBeta=/?share_link_id=2)",
                    ]
                ),
                encoding="utf-8",
            )

            refs = board_refs_from_file(path)

        self.assertEqual(refs, [("uXjAlpha=", "Alpha"), ("uXjBeta=", "Beta")])

    def test_board_refs_from_json_uses_id_and_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boards.json"
            path.write_text(
                json.dumps({"boards": [{"id": "uXjAlpha=", "name": "Alpha"}]}),
                encoding="utf-8",
            )

            refs = board_refs_from_file(path)

        self.assertEqual(refs, [("uXjAlpha=", "Alpha")])

    def test_authorize_gui_token_prefers_existing_env_token(self) -> None:
        with patch.dict(os.environ, {"MIRO_ACCESS_TOKEN": "env-token"}, clear=True):
            with patch("Miro_2_Obsidian_GUI.legacy_authorize_and_get_token") as legacy:
                self.assertEqual(authorize_gui_token(), "env-token")

        legacy.assert_not_called()

    def test_authorize_gui_token_uses_env_oauth_before_legacy_gui_flow(self) -> None:
        config = object()
        env = {"MIRO_CLIENT_ID": "client-1", "MIRO_CLIENT_SECRET": "secret-1"}
        with patch.dict(os.environ, env, clear=True):
            with patch("Miro_2_Obsidian_GUI.legacy_authorize_and_get_token") as legacy:
                with patch("Miro_2_Obsidian_GUI.config_from_env", return_value=config) as config_from_env:
                    with patch("Miro_2_Obsidian_GUI.authorize_and_get_token", return_value="modern-token") as modern:
                        self.assertEqual(authorize_gui_token(), "modern-token")

        config_from_env.assert_called_once_with()
        modern.assert_called_once_with(config)
        legacy.assert_not_called()

    def test_authorize_gui_token_uses_legacy_gui_flow_without_env_oauth(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("Miro_2_Obsidian_GUI.legacy_authorize_and_get_token", return_value="legacy-token") as legacy:
                with patch("Miro_2_Obsidian_GUI.authorize_and_get_token") as modern:
                    self.assertEqual(authorize_gui_token(), "legacy-token")

        legacy.assert_called_once_with()
        modern.assert_not_called()

    def test_authorize_gui_token_requires_a_token_or_oauth_app(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("Miro_2_Obsidian_GUI.legacy_authorize_and_get_token", None):
                with self.assertRaisesRegex(RuntimeError, "Miro Developer App"):
                    authorize_gui_token()


if __name__ == "__main__":
    unittest.main()
