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
    ConversionOptions,
    MiroPipelineApp,
    authorize_gui_token,
    board_id_from_text,
    board_label,
    board_output_name,
    board_refs_from_file,
    default_source_json_path,
    default_web_board_list,
    explain_code_step,
    show_error_later,
)
from scripts.miro_oauth_token import OAuthConfig


class _Value:
    def __init__(self, value: object) -> None:
        self.value = value

    def get(self) -> object:
        return self.value


class MiroObsidianGuiHelperTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "GUI smoke test requires Windows")
    def test_gui_constructs_with_pinned_customtkinter(self) -> None:
        app = MiroPipelineApp()
        try:
            app.withdraw()
            app.update_idletasks()
            self.assertEqual(app.run_button.cget("text"), "Run pipeline")
        finally:
            app.destroy()

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

    def test_board_output_name_uses_id_to_avoid_label_collisions(self) -> None:
        first = board_output_name("Промдизайн", "uXjAlpha=")
        second = board_output_name("Промдизайн", "uXjBeta=")

        self.assertNotEqual(first, second)
        self.assertTrue(first.endswith("uXjAlpha="))
        self.assertTrue(second.endswith("uXjBeta="))

    def test_default_source_json_path_uses_captured_target_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "vault" / "boards"
            result = default_source_json_path(str(target), "Board / Alpha", "uXjAlpha=")

        self.assertEqual(result.parent, target / "_miro_sources")
        self.assertEqual(result.name, "Board_Alpha_uXjAlpha=.json")

    def test_default_source_json_path_uses_user_export_root_when_target_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            export_root = Path(tmp) / "exports"
            with patch("Miro_2_Obsidian_GUI.DEFAULT_EXPORT_ROOT", export_root):
                result = default_source_json_path("", "Board", "uXjAlpha=")

        self.assertEqual(result.parent, export_root / "_miro_sources")

    def test_default_board_list_requires_explicit_environment_path(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(default_web_board_list())

        with tempfile.TemporaryDirectory() as tmp:
            board_list = Path(tmp) / "boards.md"
            board_list.write_text("# Boards", encoding="utf-8")
            with patch.dict(os.environ, {"MIRO_BOARD_LIST": str(board_list)}, clear=True):
                self.assertEqual(default_web_board_list(), board_list)

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

    def test_authorize_gui_token_uses_session_credentials_over_old_environment(self) -> None:
        config = OAuthConfig(client_id="new-client", client_secret="new-secret")
        with patch.dict(os.environ, {"MIRO_ACCESS_TOKEN": "old-token"}, clear=True):
            with patch("Miro_2_Obsidian_GUI.config_from_env") as config_from_env:
                with patch(
                    "Miro_2_Obsidian_GUI.authorize_and_get_token",
                    return_value="new-token",
                ) as authorize:
                    self.assertEqual(authorize_gui_token(config=config), "new-token")
        config_from_env.assert_not_called()
        authorize.assert_called_once_with(config)

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
        app.oauth_config = None
        app.token_lock = threading.Lock()
        app._log = lambda _message: None
        release = threading.Event()

        def fake_authorize(_logger, *, config):
            self.assertIsNone(config)
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

    def test_switch_miro_team_clears_board_and_reauthorizes(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app.token = "old-token"
        app.oauth_config = object()
        app.token_lock = threading.Lock()
        app.boards_by_label = {"Old board": {"id": "old-board"}}
        app.selected_account_board_id = "old-board"
        app.board_menu = unittest.mock.Mock()
        app._log = unittest.mock.Mock()
        app.authenticate_and_refresh_boards = unittest.mock.Mock()

        with patch("Miro_2_Obsidian_GUI.clear_access_token") as clear:
            MiroPipelineApp.reauthorize_and_refresh_boards(app)
        clear.assert_called_once_with()

        self.assertIsNone(app.token)
        self.assertEqual(app.boards_by_label, {})
        self.assertEqual(app.selected_account_board_id, "")
        app.board_menu.configure.assert_called_once_with(values=["Authenticate first"])
        app.board_menu.set.assert_called_once_with("Authenticate first")
        app.authenticate_and_refresh_boards.assert_called_once_with()

    def test_code_mode_reuses_token_from_os_credential_store(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app.token = None
        app.oauth_config = None
        app.token_lock = threading.Lock()
        app.active_workflow_mode = "Code automation"
        app._log = lambda _message: None
        with patch("Miro_2_Obsidian_GUI.load_access_token", return_value="stored-token") as load:
            with patch("Miro_2_Obsidian_GUI.authorize_gui_token") as authorize:
                self.assertEqual(MiroPipelineApp._authorize_token(app), "stored-token")
        load.assert_called_once_with()
        authorize.assert_not_called()

    def test_code_mode_saves_new_token_once(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app.token = None
        app.oauth_config = None
        app.token_lock = threading.Lock()
        app.active_workflow_mode = "Code automation"
        app._log = lambda _message: None
        with patch("Miro_2_Obsidian_GUI.load_access_token", return_value=None):
            with patch("Miro_2_Obsidian_GUI.authorize_gui_token", return_value="new-token") as authorize:
                with patch("Miro_2_Obsidian_GUI.save_access_token") as save:
                    self.assertEqual(MiroPipelineApp._authorize_token(app), "new-token")
                    self.assertEqual(MiroPipelineApp._authorize_token(app), "new-token")
        authorize.assert_called_once()
        save.assert_called_once_with("new-token")

    def test_code_mode_continues_when_os_credential_store_is_unavailable(self) -> None:
        from miro2obsidian.credential_store import CredentialStoreUnavailable

        app = object.__new__(MiroPipelineApp)
        app.token = None
        app.oauth_config = None
        app.token_lock = threading.Lock()
        app.active_workflow_mode = "Code automation"
        app._credential_saved_in_session = False
        messages = []
        app._log = messages.append
        with patch("Miro_2_Obsidian_GUI.load_access_token", side_effect=CredentialStoreUnavailable("No vault")):
            with patch("Miro_2_Obsidian_GUI.authorize_gui_token", return_value="session-token"):
                with patch("Miro_2_Obsidian_GUI.save_access_token", side_effect=CredentialStoreUnavailable("No vault")):
                    self.assertEqual(MiroPipelineApp._authorize_token(app), "session-token")
        self.assertTrue(any("session only" in message for message in messages))

    def test_forget_miro_connection_clears_session_and_store(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app.token = "old-token"
        app._credential_saved_in_session = True
        app.token_lock = threading.Lock()
        app.boards_by_label = {"Old": {"id": "board"}}
        app.selected_account_board_id = "board"
        app.board_menu = unittest.mock.Mock()
        app._log = unittest.mock.Mock()
        with patch("Miro_2_Obsidian_GUI.clear_access_token") as clear:
            MiroPipelineApp.forget_miro_connection(app)
        clear.assert_called_once_with()
        self.assertIsNone(app.token)
        self.assertFalse(app._credential_saved_in_session)
        self.assertEqual(app.boards_by_label, {})
        self.assertEqual(app.selected_account_board_id, "")

    def test_code_narration_follows_actual_pipeline_events(self) -> None:
        self.assertIsNone(explain_code_step("Unrelated message"))
        app = object.__new__(MiroPipelineApp)
        app._token = lambda: "test-token"
        messages = []
        app._log = messages.append
        options = ConversionOptions(
            scale=None,
            theme="dark",
            text_style_mode="miro",
            output_format="miro-canvas",
            allow_missing_assets=False,
            prefer_experimental=True,
            install_obsidian_plugins=False,
        )

        def fake_pipeline(**kwargs):
            kwargs["logger"]("Exporting the complete board through REST v2-experimental.")
            kwargs["logger"]("Converting through the single Converter.py path at scale=1.")
            return "ok"

        with patch("Miro_2_Obsidian_GUI.run_rest_experimental_pipeline", side_effect=fake_pipeline):
            MiroPipelineApp._run_one_board(
                app,
                board_id="board-1",
                label="Board",
                source_json=Path("source.json"),
                target_dir=Path("Canvas"),
                vault_root=Path("vault"),
                attachment_dir=None,
                profile=object(),
                min_font_px=8,
                options=options,
                narrate=True,
            )
        self.assertTrue(messages[0].startswith("Code: requesting"))
        self.assertTrue(messages[2].startswith("Code: converting"))

    def test_manual_websdk_file_is_passed_to_shared_pipeline(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app._token = lambda: "test-token"
        app._log = lambda _message: None
        options = ConversionOptions(
            scale=None,
            theme="dark",
            text_style_mode="miro",
            output_format="miro-canvas",
            allow_missing_assets=False,
            prefer_experimental=True,
            install_obsidian_plugins=False,
        )
        with patch("Miro_2_Obsidian_GUI.run_rest_experimental_pipeline") as pipeline:
            MiroPipelineApp._run_one_board(
                app,
                board_id="board-1",
                label="Board",
                source_json=Path("source.json"),
                target_dir=Path("Canvas"),
                vault_root=Path("vault"),
                attachment_dir=None,
                profile=object(),
                min_font_px=8,
                options=options,
                websdk_json=Path("websdk.json"),
            )
        self.assertEqual(pipeline.call_args.kwargs["websdk_json"], Path("websdk.json"))

    def test_gui_wires_explicit_existing_json_degraded_opt_in(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "Miro_2_Obsidian_GUI.py").read_text(encoding="utf-8")
        self.assertIn("Allow incomplete/unverified JSON", source)
        self.assertIn("allow_incomplete_source=options.allow_missing_assets", source)

    def test_gui_wires_share_attachments_checkbox(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "Miro_2_Obsidian_GUI.py").read_text(encoding="utf-8")
        self.assertIn("Store identical attachments once", source)
        self.assertIn("share_attachments=self.share_attachments.get()", source)
        self.assertIn("share_attachments=options.share_attachments", source)

    def test_miro_export_modes_use_canonical_pipeline(self) -> None:
        app = object.__new__(MiroPipelineApp)
        app._token = lambda: "token-1"
        app._log = lambda _message: None
        app.scale = _Value("")
        app.theme = _Value("dark")
        app.text_style_mode = _Value("miro")
        app.allow_missing_assets = _Value(False)
        app.stable_items = _Value(True)
        app.install_obsidian_plugins = _Value(False)
        options = ConversionOptions(
            scale=None,
            theme="dark",
            text_style_mode="miro",
            output_format="advanced-canvas",
            allow_missing_assets=False,
            prefer_experimental=False,
            install_obsidian_plugins=False,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "source.json"
            target_dir = root / "target"
            vault_root = root / "vault"
            attachment_dir = vault_root / "Files" / "Attachments"
            profile = object()

            with patch("Miro_2_Obsidian_GUI.run_rest_experimental_pipeline", return_value="ok") as pipeline:
                result = MiroPipelineApp._run_one_board(
                    app,
                    board_id="board-1",
                    label="Board",
                    source_json=source_json,
                    target_dir=target_dir,
                    vault_root=vault_root,
                    attachment_dir=attachment_dir,
                    profile=profile,
                    min_font_px=8,
                    options=options,
                )

        self.assertEqual(result, "ok")
        pipeline.assert_called_once()
        self.assertEqual(pipeline.call_args.kwargs["board_id"], "board-1")
        self.assertEqual(pipeline.call_args.kwargs["token"], "token-1")
        self.assertEqual(pipeline.call_args.kwargs["source_json"], source_json)
        self.assertEqual(pipeline.call_args.kwargs["attachment_dir"], attachment_dir)
        self.assertFalse(pipeline.call_args.kwargs["prefer_experimental"])


if __name__ == "__main__":
    unittest.main()
