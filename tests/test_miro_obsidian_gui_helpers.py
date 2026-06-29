from __future__ import annotations

import json
import os
import threading
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from Miro_2_Obsidian_GUI import (
    MiroPipelineApp,
    authorize_gui_token,
    board_id_from_text,
    board_label,
    board_refs_from_file,
    show_error_later,
)
from miro_oauth_token import OAuthConfig


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

    def test_board_label_includes_team_and_collection_when_present(self) -> None:
        self.assertEqual(
            board_label(
                {
                    "id": "board-1",
                    "name": "Roadmap",
                    "team": {"name": "Team A"},
                    "project": {"name": "Project X"},
                }
            ),
            "Team A / Project X - Roadmap (board-1)",
        )

    def test_board_label_handles_missing_context(self) -> None:
        self.assertEqual(board_label({"id": "board-1", "name": "Roadmap"}), "Roadmap (board-1)")

    def test_authorize_gui_token_prefers_existing_env_token(self) -> None:
        with patch.dict(os.environ, {"MIRO_ACCESS_TOKEN": "env-token"}, clear=True):
            self.assertEqual(authorize_gui_token(), "env-token")

    def test_authorize_gui_token_uses_env_oauth_credentials(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        messages = []
        env = {"MIRO_CLIENT_ID": "client-1", "MIRO_CLIENT_SECRET": "secret-1"}
        with patch.dict(os.environ, env, clear=True):
            with patch("Miro_2_Obsidian_GUI.config_from_env", return_value=config) as config_from_env:
                with patch("Miro_2_Obsidian_GUI.authorize_and_get_token", return_value="modern-token") as modern:
                    self.assertEqual(authorize_gui_token(messages.append), "modern-token")

        config_from_env.assert_called_once_with()
        modern.assert_called_once_with(config)
        self.assertTrue(any("127.0.0.1:8765" in message for message in messages))

    def test_authorize_gui_token_uses_ignored_local_oauth_config(self) -> None:
        config = OAuthConfig(client_id="local-client", client_secret="local-secret")
        with patch.dict(os.environ, {}, clear=True):
            with patch("Miro_2_Obsidian_GUI.config_from_env", return_value=config) as config_from_env:
                with patch("Miro_2_Obsidian_GUI.authorize_and_get_token", return_value="local-token") as modern:
                    self.assertEqual(authorize_gui_token(), "local-token")

        config_from_env.assert_called_once_with()
        modern.assert_called_once_with(config)

    def test_authorize_gui_token_requires_a_token_or_oauth_app(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("Miro_2_Obsidian_GUI.config_from_env", side_effect=ValueError("missing")):
                with self.assertRaisesRegex(RuntimeError, "Existing JSON"):
                    authorize_gui_token()

    def test_show_error_later_keeps_exception_message_after_except_scope(self) -> None:
        callbacks = []

        def after(delay_ms, callback):
            callbacks.append((delay_ms, callback))

        try:
            raise RuntimeError("auth needs credentials")
        except RuntimeError as exc:
            show_error_later(after, "OAuth failed", exc)

        with patch("Miro_2_Obsidian_GUI.messagebox.showerror") as showerror:
            callbacks[0][1]()

        self.assertEqual(callbacks[0][0], 0)
        showerror.assert_called_once_with("OAuth failed", "auth needs credentials")

    def test_authorize_token_reuses_inflight_oauth_result(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app.token = None
        app.token_lock = threading.Lock()
        app._log = lambda _message: None
        release = threading.Event()

        def fake_authorize(_logger):
            release.wait(1)
            return "token-1"

        results: list[str] = []
        threads = [
            threading.Thread(target=lambda: results.append(MiroPipelineApp._authorize_token(app))),
            threading.Thread(target=lambda: results.append(MiroPipelineApp._authorize_token(app))),
        ]
        with patch("Miro_2_Obsidian_GUI.authorize_gui_token", side_effect=fake_authorize) as authorize:
            for thread in threads:
                thread.start()
            for _ in range(50):
                if authorize.call_count:
                    break
                time.sleep(0.01)
            release.set()
            for thread in threads:
                thread.join(timeout=2)

        self.assertEqual(sorted(results), ["token-1", "token-1"])
        authorize.assert_called_once()


if __name__ == "__main__":
    unittest.main()
