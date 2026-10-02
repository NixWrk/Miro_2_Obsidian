from __future__ import annotations

import json
import os
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from Json_2_Canvas.Scale_engine import ViewProfile
from Miro_2_Obsidian_GUI import (
    ACCOUNT_SOURCE_MODE,
    AGENT_WORKFLOW,
    CODE_WORKFLOW,
    JSON_SOURCE_MODE,
    MANUAL_WORKFLOW,
    URL_LIST_SOURCE_MODE,
    URL_SOURCE_MODE,
    ConversionOptions,
    MiroPipelineApp,
    RunRequest,
    board_id_from_text,
    board_label,
    board_output_name,
    board_refs_from_file,
    build_import_options,
    default_source_json_path,
    default_web_board_list,
    explain_code_step,
    selected_board_inputs,
    show_error_later,
)
from miro2obsidian import gui_support, miro_auth
from miro2obsidian.agent_runner import AgentOutcome
from miro2obsidian.import_service import ImportResult, ResolvedBoard


class _Value:
    def __init__(self, value: object) -> None:
        self.value = value

    def get(self) -> object:
        return self.value


def _display_available() -> bool:
    try:
        import tkinter

        root = tkinter.Tk()
        root.destroy()
    except Exception:  # noqa: BLE001 - no tkinter or no display
        return False
    return True


def _options(**overrides: object) -> ConversionOptions:
    values: dict[str, object] = dict(
        scale=None,
        theme="dark",
        text_style_mode="miro",
        output_format="native-canvas",
        allow_missing_assets=False,
        prefer_experimental=True,
        install_obsidian_plugins=False,
    )
    values.update(overrides)
    return ConversionOptions(**values)  # type: ignore[arg-type]


def _app() -> MiroPipelineApp:
    """An app object without a window: only the logic under test is wired."""
    app = object.__new__(MiroPipelineApp)
    app.logged = []
    app._log = app.logged.append
    app.after = lambda _ms, _callback=None: None
    app._ui = lambda _callback: None
    app.active_workflow_mode = MANUAL_WORKFLOW
    return app


class _SyncThread:
    """Runs the thread target immediately so worker logic can be asserted."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None) -> None:
        self.target, self.args, self.kwargs = target, args, kwargs or {}

    def start(self) -> None:
        self.target(*self.args, **self.kwargs)


class MiroObsidianGuiHelperTests(unittest.TestCase):
    @unittest.skipUnless(_display_available(), "GUI smoke test needs a display (use xvfb-run on Linux)")
    def test_gui_constructs_with_pinned_customtkinter(self) -> None:
        app = MiroPipelineApp()
        try:
            app.withdraw()
            app.update_idletasks()
            self.assertEqual(app.run_button.cget("text"), "Run pipeline")
            self.assertEqual(app.copy_agent_button.cget("text"), "Copy instructions for my agent")
            self.assertEqual(app.websdk_choice.get(), gui_support.WEBSDK_OFF)
            app.workflow_mode.set(CODE_WORKFLOW)
            app.on_workflow_mode_changed(CODE_WORKFLOW)
            self.assertEqual(app.websdk_choice.get(), gui_support.WEBSDK_AUTO)
            app.on_workflow_mode_changed(AGENT_WORKFLOW)
            self.assertEqual(app.websdk_choice.cget("state"), "disabled")
        finally:
            app.destroy()

    @unittest.skipUnless(_display_available(), "GUI smoke test needs a display (use xvfb-run on Linux)")
    def test_setup_wizard_walks_the_setup_steps_and_resumes(self) -> None:
        from Miro_2_Obsidian_GUI import SetupWizard

        app = MiroPipelineApp()
        try:
            app.withdraw()
            with tempfile.TemporaryDirectory() as tmp:
                settings = Path(tmp) / "gui-settings.json"
                wizard = SetupWizard(app, settings_file=settings)
                try:
                    steps = wizard.steps
                    self.assertEqual(wizard.index, 0)
                    self.assertEqual(steps[-1]["id"], "connect")
                    for _ in range(len(steps) - 1):
                        wizard.next()
                    wizard.update_idletasks()
                    self.assertTrue(wizard.step.get("form"))
                    self.assertEqual(wizard.secret_entry.cget("show"), "*")
                    wizard.back()
                    self.assertEqual(wizard.index, len(steps) - 2)
                finally:
                    wizard.destroy()
                second = SetupWizard(app, settings_file=settings)
                try:
                    self.assertEqual(second.index, len(steps) - 1)
                finally:
                    second.destroy()
                self.assertNotIn("secret", settings.read_text(encoding="utf-8").lower())
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

    def test_gui_wires_explicit_existing_json_degraded_opt_in(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "Miro_2_Obsidian_GUI.py").read_text(encoding="utf-8")
        self.assertIn("Allow incomplete/unverified JSON", source)
        self.assertIn("allow_incomplete_source=options.allow_missing_assets", source)

    def test_gui_wires_share_attachments_checkbox(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "Miro_2_Obsidian_GUI.py").read_text(encoding="utf-8")
        self.assertIn("Store identical attachments once", source)
        self.assertIn("share_attachments=self.share_attachments.get()", source)
        self.assertIn("share_attachments=options.share_attachments", source)


    # -- token handling goes through miro_auth only -------------------------

    def test_gui_never_touches_the_legacy_token_functions(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "Miro_2_Obsidian_GUI.py").read_text(encoding="utf-8")
        for forbidden in ("save_access_token", "load_access_token", "clear_access_token", "authorize_oauth"):
            self.assertNotIn(forbidden, source)
        self.assertNotIn("Expire user authorization token", source)

    def test_token_comes_from_miro_auth(self) -> None:
        app = _app()
        with patch("Miro_2_Obsidian_GUI.miro_auth.get_access_token", return_value="tok") as get:
            self.assertEqual(app._token(), "tok")
        get.assert_called_once_with()

    def test_legacy_authorize_gui_token_name_routes_through_miro_auth(self) -> None:
        from Miro_2_Obsidian_GUI import authorize_gui_token
        from Miro_2_Json.GUI import resolve_gui_token

        self.assertIs(resolve_gui_token, authorize_gui_token)
        messages = []
        with patch("Miro_2_Obsidian_GUI.miro_auth.get_access_token", return_value="tok"):
            self.assertEqual(authorize_gui_token(messages.append), "tok")
        self.assertTrue(messages)
        with patch.dict(os.environ, {"MIRO_ACCESS_TOKEN": "env-token"}, clear=True):
            self.assertEqual(authorize_gui_token(), "env-token")

    def test_token_errors_become_plain_language(self) -> None:
        app = _app()
        with patch(
            "Miro_2_Obsidian_GUI.miro_auth.get_access_token", side_effect=miro_auth.NotConnected("x")
        ):
            with self.assertRaisesRegex(RuntimeError, "Set up Miro app"):
                app._token()
        with patch(
            "Miro_2_Obsidian_GUI.miro_auth.get_access_token",
            side_effect=miro_auth.TokenRefreshFailed("gone", needs_reauthorization=True),
        ):
            with self.assertRaisesRegex(RuntimeError, "Switch Miro team"):
                app._token()

    def test_connect_runs_miro_auth_in_a_worker_and_reports_team(self) -> None:
        app = _app()
        app.connect_lock = threading.Lock()
        app.source_mode = _Value(JSON_SOURCE_MODE)
        app.connection_label = unittest.mock.Mock()
        connected = []
        status = miro_auth.ConnectionStatus(connected=True, team_name="Acme", refreshable=True)
        with patch("Miro_2_Obsidian_GUI.threading.Thread", _SyncThread):
            with patch(
                "Miro_2_Obsidian_GUI.miro_auth.connect_with_credentials", return_value=status
            ) as connect:
                app.connect_miro_app("client", "secret", on_success=connected.append)
        connect.assert_called_once()
        self.assertEqual(connect.call_args.args, ("client", "secret"))
        self.assertEqual(connected, [status])
        self.assertTrue(any("Acme" in line for line in app.logged))
        self.assertFalse(any("secret" in line for line in app.logged))

    def test_connect_failure_is_reported_without_a_dialog_loop(self) -> None:
        app = _app()
        app.connect_lock = threading.Lock()
        errors = []
        with patch("Miro_2_Obsidian_GUI.threading.Thread", _SyncThread):
            with patch(
                "Miro_2_Obsidian_GUI.miro_auth.connect_with_credentials",
                side_effect=RuntimeError("Miro refused"),
            ):
                app.connect_miro_app("client", "secret", on_error=errors.append)
        self.assertEqual(errors, ["Miro refused"])
        self.assertFalse(app.connect_lock.locked())

    def test_switch_miro_team_clears_boards_and_reconnects_with_saved_app(self) -> None:
        app = _app()
        app.boards_by_label = {"Old board": {"id": "old-board"}}
        app.selected_account_board_id = "old-board"
        app.board_menu = unittest.mock.Mock()
        app.connect_miro_app = unittest.mock.Mock()

        MiroPipelineApp.reauthorize_and_refresh_boards(app)

        self.assertEqual(app.boards_by_label, {})
        self.assertEqual(app.selected_account_board_id, "")
        app.board_menu.configure.assert_called_once_with(values=["Connect first"])
        app.connect_miro_app.assert_called_once_with("", "", reconnect=True)

    def test_switch_team_without_saved_app_opens_the_setup(self) -> None:
        app = _app()
        app.connect_lock = threading.Lock()
        opened = []
        app._ui = lambda callback: opened.append(callback)
        app.open_miro_setup = unittest.mock.Mock()
        with patch("Miro_2_Obsidian_GUI.threading.Thread", _SyncThread):
            with patch(
                "Miro_2_Obsidian_GUI.miro_auth.reconnect_with_saved_app",
                side_effect=miro_auth.NotConnected("none"),
            ):
                app.connect_miro_app("", "", reconnect=True)
        self.assertEqual(opened, [app.open_miro_setup])

    def test_forget_asks_first_then_disconnects_through_miro_auth(self) -> None:
        app = _app()
        app.boards_by_label = {"Old": {"id": "board"}}
        app.selected_account_board_id = "board"
        app.board_menu = unittest.mock.Mock()
        app.refresh_connection_status = unittest.mock.Mock()
        with patch("Miro_2_Obsidian_GUI.threading.Thread", _SyncThread):
            with patch("Miro_2_Obsidian_GUI.messagebox.askyesno", return_value=False):
                with patch("Miro_2_Obsidian_GUI.miro_auth.disconnect") as disconnect:
                    MiroPipelineApp.forget_miro_connection(app)
            disconnect.assert_not_called()
            self.assertEqual(app.selected_account_board_id, "board")

            with patch("Miro_2_Obsidian_GUI.messagebox.askyesno", return_value=True) as ask:
                with patch("Miro_2_Obsidian_GUI.miro_auth.disconnect", return_value=True) as disconnect:
                    MiroPipelineApp.forget_miro_connection(app)
        ask.assert_called_once()
        disconnect.assert_called_once_with()
        self.assertEqual(app.boards_by_label, {})
        self.assertEqual(app.selected_account_board_id, "")
        self.assertTrue(any("revoked" in line for line in app.logged))
        app.refresh_connection_status.assert_called_once_with()

    # -- board selection and import options ----------------------------------

    def test_selected_board_inputs_for_each_miro_source(self) -> None:
        account = selected_board_inputs(
            ACCOUNT_SOURCE_MODE, account_board_id="uXjA=", account_label="Alpha"
        )
        self.assertEqual(account, [ResolvedBoard("uXjA=", name="Alpha")])
        self.assertEqual(
            selected_board_inputs(URL_SOURCE_MODE, board_text="https://miro.com/app/board/uXjB=/?x=1"),
            ["uXjB="],
        )
        self.assertEqual(selected_board_inputs(URL_SOURCE_MODE, board_text="Roadmap"), ["Roadmap"])
        with tempfile.TemporaryDirectory() as tmp:
            listing = Path(tmp) / "boards.md"
            listing.write_text("- [Alpha](https://miro.com/app/board/uXjA=/)\n", encoding="utf-8")
            self.assertEqual(
                selected_board_inputs(URL_LIST_SOURCE_MODE, url_list_text=str(listing)),
                [ResolvedBoard("uXjA=", name="Alpha")],
            )
        for mode in (ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE, URL_LIST_SOURCE_MODE):
            with self.assertRaises(ValueError):
                selected_board_inputs(mode)

    def test_build_import_options_maps_the_form(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            target = vault / "Boards"
            profile = ViewProfile()
            result = build_import_options(
                vault_root=vault,
                target_dir=target,
                attachment_dir=None,
                options=_options(allow_missing_assets=True, prefer_experimental=False, scale=2.0),
                profile=profile,
                min_font_px=9,
                websdk="skip",
            )
        self.assertEqual(result.websdk, "skip")
        self.assertEqual(result.target_dir, target)
        self.assertEqual(result.source_dir, target / "_miro_sources")
        self.assertEqual(result.output_format, "native-canvas")
        self.assertTrue(result.allow_missing_assets)
        self.assertFalse(result.prefer_experimental)
        self.assertEqual(result.scale, 2.0)
        self.assertEqual(result.min_font_px, 9)
        self.assertIs(result.view_profile, profile)

    # -- running -------------------------------------------------------------

    def _request(self, vault: Path, **overrides: object) -> RunRequest:
        values: dict[str, object] = dict(
            source_mode=URL_SOURCE_MODE,
            workflow_mode=CODE_WORKFLOW,
            target_text=str(vault / "Boards"),
            options=_options(),
            profile=ViewProfile(),
            min_font_px=8,
            websdk="auto",
            board_text="https://miro.com/app/board/uXjA=/",
        )
        values.update(overrides)
        return RunRequest(**values)  # type: ignore[arg-type]

    def test_code_automation_runs_the_import_service_with_automatic_capture(self) -> None:
        app = _app()
        app._ui = lambda callback: callback()
        app._set_entry = unittest.mock.Mock()
        app.vault_root = unittest.mock.Mock()
        app.run_status = unittest.mock.Mock()
        result = ImportResult(
            "degraded",
            board_id="uXjA=",
            board_name="Alpha",
            reason="websdk_unavailable",
            message="REST only.",
            next_step="Click the app icon.",
            artifact_path="C:/vault/Boards/Alpha.canvas",
        )

        def fake_run_imports(inputs, options, *, on_event=None, **_kw):
            on_event({"event": "board_started", "board_id": "uXjA=", "message": "Importing Alpha."})
            on_event(
                {
                    "event": "step",
                    "board_id": "uXjA=",
                    "message": "Opened the board in the browser. If the export does not start within about 20 seconds, click the app icon.",
                    "board_url": "https://miro.com/app/board/uXjA=/",
                }
            )
            return [result]

        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / ".obsidian").mkdir()
            with patch("Miro_2_Obsidian_GUI.run_imports", side_effect=fake_run_imports) as run:
                outcomes = app._execute_request(self._request(vault))
        inputs, options = run.call_args.args
        self.assertEqual(inputs, ["uXjA="])
        self.assertEqual(options.websdk, "auto")
        self.assertEqual(options.vault_root, vault.resolve())
        self.assertEqual([o.status for o in outcomes], ["degraded"])
        self.assertTrue(outcomes[0].websdk_missing)
        self.assertTrue(any("Importing Alpha." in line for line in app.logged))
        self.assertTrue(any("click the app icon" in line for line in app.logged))
        # the instruction is also pinned above the log while the capture waits
        texts = [call.kwargs["text"] for call in app.run_status.configure.call_args_list]
        self.assertTrue(any("click the app icon" in text for text in texts))

    def test_manual_run_passes_a_websdk_file_to_the_import_service(self) -> None:
        app = _app()
        app._set_entry = unittest.mock.Mock()
        app.vault_root = unittest.mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / ".obsidian").mkdir()
            capture = vault / "websdk.json"
            capture.write_text("{}", encoding="utf-8")
            request = self._request(vault, workflow_mode=MANUAL_WORKFLOW, websdk=capture)
            with patch("Miro_2_Obsidian_GUI.run_imports", return_value=[]) as run:
                app._execute_request(request)
        self.assertEqual(run.call_args.args[1].websdk, capture)

    def test_existing_json_keeps_the_legacy_pipeline(self) -> None:
        app = _app()
        app._set_entry = unittest.mock.Mock()
        app.vault_root = unittest.mock.Mock()
        pipeline = unittest.mock.Mock(canvas_path=Path("a.canvas"), source_json=Path("a.json"))
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / ".obsidian").mkdir()
            request = self._request(
                vault, source_mode=JSON_SOURCE_MODE, websdk=None, json_path_text=str(vault / "a.json")
            )
            with patch("Miro_2_Obsidian_GUI.run_existing_json_pipeline", return_value=pipeline) as run:
                with patch("Miro_2_Obsidian_GUI.pipeline_result_is_degraded", return_value=False):
                    with patch("Miro_2_Obsidian_GUI.run_imports") as imports:
                        outcomes = app._execute_request(request)
        run.assert_called_once()
        imports.assert_not_called()
        self.assertEqual(outcomes[0].status, "complete")
        self.assertEqual(outcomes[0].artifact_path, "a.canvas")

    def test_agent_degraded_is_written_with_gaps_and_warns_about_missing_websdk(self) -> None:
        app = _app()
        app._set_entry = unittest.mock.Mock()
        app.vault_root = unittest.mock.Mock()
        agent = AgentOutcome(
            "degraded",
            artifact_path=Path("x.canvas"),
            websdk_used=False,
            message="Only REST data.",
            next_step="Click the app icon and run again.",
        )
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / ".obsidian").mkdir()
            request = self._request(vault, workflow_mode=AGENT_WORKFLOW, websdk=None)
            with patch("Miro_2_Obsidian_GUI.run_agent", return_value=agent) as run_agent:
                outcomes = app._execute_request(request)
        run_agent.assert_called_once()
        outcome = outcomes[0]
        self.assertEqual(outcome.status, "degraded")
        self.assertTrue(outcome.websdk_missing)
        text = "\n".join(gui_support.outcome_lines(outcome))
        self.assertIn("Written with gaps", text)
        self.assertIn("Only REST data.", text)
        self.assertIn("Web SDK data is missing", text)
        self.assertIn("Click the app icon and run again.", text)

    def test_present_outcomes_picks_the_dialog_by_severity(self) -> None:
        app = _app()
        shown = []
        app.after = lambda _ms, callback: callback()
        for status, expected in (("complete", "showinfo"), ("degraded", "showwarning"), ("needs_user", "showwarning"), ("failed", "showerror")):
            with patch.multiple(
                "Miro_2_Obsidian_GUI.messagebox",
                showinfo=lambda *a: shown.append("showinfo"),
                showwarning=lambda *a: shown.append("showwarning"),
                showerror=lambda *a: shown.append("showerror"),
            ):
                app._present_outcomes(
                    [gui_support.BoardOutcome(status, name="B", message="m", next_step="do it")]
                )
            self.assertEqual(shown[-1], expected)

    def test_needs_user_dialog_shows_the_next_step(self) -> None:
        app = _app()
        captured = []
        app.after = lambda _ms, callback: callback()
        outcome = gui_support.outcome_from_import_result(
            ImportResult(
                "needs_user",
                board_id="b",
                reason="file_locked",
                message="A file is locked.",
                next_step="Close the board in Obsidian, then press Run pipeline again.",
            )
        )
        with patch("Miro_2_Obsidian_GUI.messagebox.showwarning", lambda title, text: captured.append((title, text))):
            app._present_outcomes([outcome])
        self.assertEqual(captured[0][0], "Miro needs your attention")
        self.assertIn("Close the board in Obsidian, then press Run pipeline again.", captured[0][1])

    def test_collect_run_request_validates_the_websdk_choice(self) -> None:
        app = _app()
        app.source_mode = _Value(URL_SOURCE_MODE)
        app.workflow_mode = _Value(CODE_WORKFLOW)
        app.target_dir = _Value("/vault/Boards")
        app.websdk_choice = _Value(gui_support.WEBSDK_FILE)
        app.websdk_path = _Value("")
        app.min_font_px = _Value("8")
        app.min_zoom = _Value("0.12")
        app.scale_mode = _Value("readable")
        app.scale = _Value("")
        app.theme = _Value("dark")
        app.text_style_mode = _Value("miro")
        app.output_format = _Value("native-canvas")
        app.allow_missing_assets = _Value(False)
        app.stable_items = _Value(False)
        app.install_obsidian_plugins = _Value(False)
        app.share_attachments = _Value(True)
        app.json_path = _Value("")
        app.url_list_path = _Value("")
        app.board_id = _Value("https://miro.com/app/board/uXjA=/")
        app.selected_account_board_id = ""
        app.agent_command_spec = None
        with self.assertRaisesRegex(ValueError, "Web SDK JSON"):
            app._collect_run_request()
        app.websdk_choice = _Value(gui_support.WEBSDK_AUTO)
        request = app._collect_run_request()
        self.assertEqual(request.websdk, "auto")
        app.websdk_choice = _Value(gui_support.WEBSDK_OFF)
        self.assertEqual(app._collect_run_request().websdk, "skip")

    def test_copy_instructions_text_uses_the_form(self) -> None:
        app = _app()
        app.target_dir = _Value("")
        app.source_mode = _Value(URL_SOURCE_MODE)
        app.board_id = _Value("https://miro.com/app/board/uXjA=/")
        app.url_list_path = _Value("")
        app.selected_account_board_id = ""
        app.output_format = _Value("native-canvas")
        app.websdk_choice = _Value(gui_support.WEBSDK_OFF)
        app.websdk_path = _Value("")
        with patch("Miro_2_Obsidian_GUI.gui_support.agent_cli_command", return_value="miro2obsidian"):
            text = app._agent_instructions_text()
        self.assertIn("miro2obsidian agent-guide", text)
        self.assertIn('--board "uXjA="', text)
        self.assertIn("--format native-canvas", text)
        self.assertIn("--websdk skip", text)
        self.assertIn("miro2obsidian mcp --print-config", text)

    def test_code_narration_explains_import_service_steps(self) -> None:
        self.assertTrue(
            explain_code_step("Exporting the board through Miro's REST API.").startswith("Code: requesting")
        )
        self.assertTrue(explain_code_step("Asking the Miro app for a capture of the board.").startswith("Code:"))
        app = _app()
        app.run_status = unittest.mock.Mock()
        app._on_import_event(
            {"event": "step", "board_id": "b", "message": "Exporting the board through Miro's REST API."},
            narrate=True,
        )
        self.assertTrue(app.logged[0].startswith("Code: requesting"))
        self.assertIn("REST API", app.logged[1])


if __name__ == "__main__":
    unittest.main()
