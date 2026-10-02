"""Display-free tests for the logic behind the desktop GUI."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from miro2obsidian import app_setup, gui_support, miro_auth
from miro2obsidian.agent_runner import AgentOutcome
from miro2obsidian.credential_store import CredentialStoreUnavailable, MiroConnection
from miro2obsidian.import_service import ImportResult


class WebSdkChoiceTests(unittest.TestCase):
    def test_code_automation_defaults_to_automatic_capture(self) -> None:
        self.assertEqual(gui_support.default_websdk_choice("Code automation"), gui_support.WEBSDK_AUTO)
        self.assertEqual(gui_support.default_websdk_choice("Manual"), gui_support.WEBSDK_OFF)
        self.assertEqual(gui_support.default_websdk_choice("Manual", has_file=True), gui_support.WEBSDK_FILE)

    def test_choices_map_to_import_service_modes(self) -> None:
        self.assertEqual(gui_support.resolve_websdk_option(gui_support.WEBSDK_AUTO, ""), "auto")
        self.assertEqual(gui_support.resolve_websdk_option(gui_support.WEBSDK_OFF, "ignored"), "skip")
        self.assertEqual(
            gui_support.WEBSDK_CHOICES,
            ("Automatic (open board and capture)", "Off (REST only)", "From file\u2026"),
        )

    def test_file_choice_needs_one_board_and_an_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp) / "websdk.json"
            capture.write_text("{}", encoding="utf-8")
            self.assertEqual(gui_support.resolve_websdk_option(gui_support.WEBSDK_FILE, str(capture)), capture)
            with self.assertRaisesRegex(ValueError, "one board"):
                gui_support.resolve_websdk_option(gui_support.WEBSDK_FILE, str(capture), single_board=False)
            with self.assertRaisesRegex(ValueError, "existing"):
                gui_support.resolve_websdk_option(gui_support.WEBSDK_FILE, str(capture) + ".missing")
        with self.assertRaisesRegex(ValueError, "Web SDK JSON"):
            gui_support.resolve_websdk_option(gui_support.WEBSDK_FILE, "  ")
        with self.assertRaises(ValueError):
            gui_support.resolve_websdk_option("bogus", "")


class ConnectionTextTests(unittest.TestCase):
    def test_not_connected_points_to_the_setup_button(self) -> None:
        line = gui_support.connection_status_line(miro_auth.ConnectionStatus(connected=False))
        self.assertIn("Set up Miro app", line)

    def test_missing_credential_store_is_explained(self) -> None:
        line = gui_support.connection_status_line(
            miro_auth.ConnectionStatus(connected=False, store_available=False, problem="No usable store.")
        )
        self.assertIn("credential store", line)
        self.assertIn("MIRO_ACCESS_TOKEN", line)

    def test_refreshable_connection_names_the_team(self) -> None:
        status = miro_auth.ConnectionStatus(
            connected=True, source="vault-v2", team_name="Acme", refreshable=True
        )
        self.assertEqual(
            gui_support.connection_status_line(status), "Connected to team Acme. The connection renews itself."
        )

    def test_connection_that_cannot_renew_shows_its_expiry(self) -> None:
        expires = datetime.now(timezone.utc) + timedelta(hours=1)
        status = miro_auth.ConnectionStatus(
            connected=True, source="vault-v2", team_name="Acme", refreshable=False, expires_at=expires
        )
        line = gui_support.connection_status_line(status)
        self.assertIn("Acme", line)
        self.assertIn("cannot renew itself", line)
        self.assertIn(str(expires.astimezone().year), line)

    def test_env_and_legacy_sources_are_described(self) -> None:
        env = gui_support.connection_status_line(miro_auth.ConnectionStatus(connected=True, source="env"))
        legacy = gui_support.connection_status_line(miro_auth.ConnectionStatus(connected=True, source="vault-v1"))
        self.assertIn("MIRO_ACCESS_TOKEN", env)
        self.assertIn("connect again", legacy)

    def test_status_line_never_contains_secrets(self) -> None:
        status = miro_auth.ConnectionStatus(connected=True, source="vault-v2", team_name="Acme", refreshable=True)
        self.assertNotIn("secret", gui_support.connection_status_line(status).lower())

    def test_errors_become_plain_language(self) -> None:
        self.assertIn("Set up Miro app", gui_support.explain_connection_error(miro_auth.NotConnected("x")))
        self.assertIn(
            "Switch Miro team",
            gui_support.explain_connection_error(miro_auth.TokenRefreshFailed("x", needs_reauthorization=True)),
        )
        self.assertEqual(
            gui_support.explain_connection_error(miro_auth.TokenRefreshFailed("try later", needs_reauthorization=False)),
            "try later",
        )
        self.assertIn(
            "MIRO_ACCESS_TOKEN", gui_support.explain_connection_error(CredentialStoreUnavailable("No vault."))
        )
        self.assertEqual(gui_support.explain_connection_error(RuntimeError("boom")), "boom")


class ReconnectTests(unittest.TestCase):
    def _connection(self, **overrides: object) -> MiroConnection:
        values = dict(client_id="client-1", client_secret="secret-1", access_token="tok", refresh_token="ref")
        values.update(overrides)
        return MiroConnection(**values)  # type: ignore[arg-type]

    def test_reconnect_uses_the_saved_client_credentials(self) -> None:
        status = miro_auth.ConnectionStatus(connected=True, team_name="Other")
        with patch("miro2obsidian.miro_auth.load_connection", return_value=self._connection()):
            with patch("miro2obsidian.miro_auth.connect_with_credentials", return_value=status) as connect:
                self.assertIs(miro_auth.reconnect_with_saved_app(report=lambda _m: None), status)
        self.assertEqual(connect.call_args.args, ("client-1", "secret-1"))

    def test_reconnect_without_a_saved_app_says_to_set_it_up(self) -> None:
        for connection in (None, self._connection(client_secret=None), self._connection(client_id="")):
            with patch("miro2obsidian.miro_auth.load_connection", return_value=connection):
                with patch("miro2obsidian.miro_auth.connect_with_credentials") as connect:
                    with self.assertRaises(miro_auth.NotConnected):
                        miro_auth.reconnect_with_saved_app()
                connect.assert_not_called()


class OutcomeTests(unittest.TestCase):
    def test_import_result_degraded_by_missing_websdk_warns_about_it(self) -> None:
        outcome = gui_support.outcome_from_import_result(
            ImportResult(
                "degraded",
                board_id="b1",
                board_name="Alpha",
                reason="websdk_unavailable",
                message="Imported 4 items from REST only.",
                next_step="Click the app icon and run again.",
                artifact_path="/v/Alpha.canvas",
                warnings=["The Miro app did not answer."],
            )
        )
        text = "\n".join(gui_support.outcome_lines(outcome))
        self.assertIn("[Written with gaps] Alpha", text)
        self.assertIn("Imported 4 items from REST only.", text)
        self.assertIn("Web SDK data is missing", text)
        self.assertIn("Warning: The Miro app did not answer.", text)
        self.assertIn("Result: /v/Alpha.canvas", text)
        self.assertIn("What to do: For the full export keep Web SDK on Automatic, click the Miro to Obsidian app icon", text)

    def test_command_line_advice_is_put_in_gui_words(self) -> None:
        def outcome(status: str, reason: str, message: str, next_step: str) -> gui_support.BoardOutcome:
            return gui_support.outcome_from_import_result(
                ImportResult(status, board_id="b", reason=reason, message=message, next_step=next_step)
            )

        not_connected = outcome(
            "needs_user",
            "not_connected",
            "Miro is not connected. Connect once with `miro2obsidian auth login --form` (a local form).",
            "Run `miro2obsidian setup guide` to create your Miro app (once), then `miro2obsidian auth login --form`.",
        )
        self.assertEqual(not_connected.message, "Miro is not connected.")
        self.assertIn("Set up Miro app", not_connected.next_step or "")
        store = outcome(
            "needs_user", "not_connected", "No credential store.", "Set the environment variable MIRO_ACCESS_TOKEN."
        )
        self.assertIn("MIRO_ACCESS_TOKEN", store.next_step or "")
        timeout = outcome(
            "needs_user", "websdk_capture_timeout", "No capture.", "Click the icon, then run the same command again."
        )
        self.assertIn("Run pipeline", timeout.next_step or "")
        degraded = outcome(
            "degraded", "websdk_unavailable", "REST only.", "Run again with `--websdk required`."
        )
        self.assertNotIn("--websdk", degraded.next_step or "")
        self.assertTrue(degraded.websdk_missing)
        generic = outcome("failed", "error", "Boom.", "Run `miro2obsidian doctor` to check the setup.")
        self.assertNotIn("miro2obsidian", generic.next_step or "")
        apps = outcome("needs_user", "app_setup_required", "Not allowed.", "See `miro2obsidian setup guide`.")
        self.assertIn("step 4", apps.next_step or "")
        plain = outcome("needs_user", "file_locked", "Locked.", "Close the board in Obsidian and retry.")
        self.assertEqual(plain.next_step, "Close the board in Obsidian and retry.")

    def test_incomplete_source_with_websdk_does_not_claim_missing_websdk(self) -> None:
        outcome = gui_support.outcome_from_import_result(
            ImportResult(
                "degraded", board_id="b", reason="incomplete_source", message="Incomplete.", websdk_used=True
            )
        )
        self.assertFalse(outcome.websdk_missing)

    def test_needs_user_keeps_message_and_next_step(self) -> None:
        outcome = gui_support.outcome_from_import_result(
            ImportResult(
                "needs_user",
                board_id="b",
                reason="file_locked",
                message="A file is locked.",
                next_step="Close the board in Obsidian.",
            )
        )
        self.assertEqual((outcome.status, outcome.next_step), ("needs_user", "Close the board in Obsidian."))

    def test_pipeline_outcomes_for_existing_json(self) -> None:
        pipeline = type("P", (), {"canvas_path": Path("a.canvas"), "source_json": Path("a.json")})()
        done = gui_support.outcome_from_pipeline(pipeline, degraded=False)
        gap = gui_support.outcome_from_pipeline(pipeline, degraded=True)
        self.assertEqual((done.status, done.artifact_path), ("complete", "a.canvas"))
        self.assertEqual(gap.status, "degraded")
        self.assertFalse(gap.websdk_missing)

    def test_agent_degraded_shows_gaps_and_missing_websdk(self) -> None:
        outcome = gui_support.outcome_from_agent(
            AgentOutcome("degraded", artifact_path=Path("x.canvas"), websdk_used=False, message="REST only.")
        )
        self.assertEqual(outcome.status, "degraded")
        self.assertTrue(outcome.websdk_missing)
        self.assertIn("REST only.", "\n".join(gui_support.outcome_lines(outcome)))
        verified = gui_support.outcome_from_agent(AgentOutcome("degraded", websdk_used=True))
        self.assertFalse(verified.websdk_missing)

    def test_agent_needs_user_uses_its_own_text_else_a_reason_default(self) -> None:
        own = gui_support.outcome_from_agent(
            AgentOutcome("needs_user", reason="login", message="Sign in please.", next_step="Use the window.")
        )
        self.assertEqual((own.message, own.next_step), ("Sign in please.", "Use the window."))
        default = gui_support.outcome_from_agent(AgentOutcome("needs_user", reason="browser_unavailable"))
        self.assertIn("browser", default.message)
        self.assertIn("Code automation", default.next_step or "")
        unknown = gui_support.outcome_from_agent(AgentOutcome("needs_user", reason="other"))
        self.assertTrue(unknown.next_step)

    def test_agent_failure_surfaces_the_diagnostics_log(self) -> None:
        outcome = gui_support.outcome_from_agent(
            AgentOutcome("failed", message="The agent crashed. Diagnostics log: /data/logs/agent-x.log")
        )
        self.assertEqual(outcome.message, "The agent crashed.")
        self.assertEqual(outcome.diagnostics_log, "/data/logs/agent-x.log")
        self.assertIn("Diagnostics log: /data/logs/agent-x.log", "\n".join(gui_support.outcome_lines(outcome)))

    def test_extract_diagnostics_log(self) -> None:
        self.assertEqual(gui_support.extract_diagnostics_log("No log here."), ("No log here.", None))
        message, path = gui_support.extract_diagnostics_log("It failed. Diagnostics log: C:\\Users\\me\\logs\\a.log")
        self.assertEqual((message, path), ("It failed.", "C:\\Users\\me\\logs\\a.log"))


class SummaryTests(unittest.TestCase):
    def _board(self, status: str, name: str = "B", **kw: object) -> gui_support.BoardOutcome:
        return gui_support.BoardOutcome(status, name=name, **kw)  # type: ignore[arg-type]

    def test_all_complete_is_an_info_dialog_with_the_path(self) -> None:
        summary = gui_support.summarize_outcomes([self._board("complete", artifact_path="/v/a.canvas")])
        self.assertEqual((summary.level, summary.title, summary.text), ("info", "Pipeline complete", "/v/a.canvas"))

    def test_worst_status_decides_the_level(self) -> None:
        cases = {
            "degraded": ("warning", "Written with gaps"),
            "needs_user": ("warning", "Miro needs your attention"),
            "failed": ("error", "Pipeline failed"),
        }
        for status, (level, title) in cases.items():
            summary = gui_support.summarize_outcomes(
                [self._board("complete", "A", artifact_path="/a"), self._board(status, "B", next_step="Do this.")]
            )
            self.assertEqual((summary.level, summary.title, summary.worst_status), (level, title, status))
            self.assertIn("Do this.", summary.text)
            self.assertEqual(summary.counts["complete"], 1)

    def test_needs_user_text_leads_with_what_to_do(self) -> None:
        summary = gui_support.summarize_outcomes(
            [self._board("needs_user", message="No capture arrived.", next_step="Click the icon.")]
        )
        self.assertIn("No capture arrived.", summary.text)
        self.assertIn("What to do: Click the icon.", summary.text)

    def test_empty_run_is_an_error(self) -> None:
        self.assertEqual(gui_support.summarize_outcomes([]).level, "error")


class EventTests(unittest.TestCase):
    def test_events_become_log_lines(self) -> None:
        fmt = gui_support.format_import_event
        self.assertEqual(fmt({"event": "board_started", "message": "Importing A."}), "Importing A.")
        self.assertEqual(fmt({"event": "step", "message": "Doing it."}), "Doing it.")
        self.assertIn("Needs you: Stuck. Next: Click.", fmt({"event": "needs_user", "message": "Stuck.", "next_step": "Click."}))
        self.assertEqual(
            fmt({"event": "board_finished", "result": {"status": "degraded", "board_name": "A"}}),
            "A: Written with gaps.",
        )
        self.assertIsNone(fmt({"event": "unknown"}))

    def test_capture_wait_event_is_the_one_with_a_board_url(self) -> None:
        self.assertTrue(gui_support.is_capture_wait_event({"event": "step", "board_url": "https://miro.com/app/board/x/"}))
        self.assertFalse(gui_support.is_capture_wait_event({"event": "step", "message": "x"}))


class AgentInstructionsTests(unittest.TestCase):
    def test_prompt_names_vault_folder_format_boards_and_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            text = gui_support.build_agent_instructions(
                cli_command="/py/python -m scripts.miro_pipeline",
                vault_root=vault,
                target_dir=vault / "Boards" / "Miro",
                output_format="native-canvas",
                boards=["https://miro.com/app/board/uXjA=/", "uXjB="],
                websdk="auto",
            )
            self.assertIn(f"Vault: {vault}", text)
        self.assertIn("Folder inside the vault: Boards/Miro", text)
        self.assertIn("Output format: native-canvas", text)
        self.assertIn("/py/python -m scripts.miro_pipeline agent-guide", text)
        self.assertIn('--board "https://miro.com/app/board/uXjA=/" --board "uXjB="', text)
        self.assertIn("--format native-canvas --websdk auto --json", text)
        self.assertIn("/py/python -m scripts.miro_pipeline mcp --print-config", text)
        self.assertIn("Never ask me for", text)

    def test_prompt_without_choices_asks_the_agent_to_ask(self) -> None:
        text = gui_support.build_agent_instructions(
            cli_command="miro2obsidian",
            vault_root=None,
            target_dir=None,
            output_format="advanced-canvas",
            websdk="skip",
        )
        self.assertIn("ask me for the path of my Obsidian vault", text)
        self.assertIn("miro2obsidian boards --json", text)
        self.assertIn("--websdk skip", text)
        self.assertIn('--vault "<VAULT PATH>"', text)

    def test_websdk_file_is_quoted(self) -> None:
        text = gui_support.build_agent_instructions(
            cli_command="miro2obsidian",
            vault_root=None,
            target_dir=None,
            output_format="native-canvas",
            boards=["b1"],
            websdk="/tmp/web sdk.json",
        )
        self.assertIn('--websdk "/tmp/web sdk.json"', text)

    def test_cli_command_shows_the_real_executable(self) -> None:
        command = gui_support.agent_cli_command()
        self.assertTrue(command)
        with patch("miro2obsidian.agent_runner._pipeline_command", side_effect=RuntimeError("missing")):
            self.assertEqual(gui_support.agent_cli_command(), "miro2obsidian")


class WizardTests(unittest.TestCase):
    def test_wizard_follows_setup_steps_and_ends_with_the_connect_form(self) -> None:
        steps = gui_support.wizard_steps()
        source_ids = [s["id"] for s in app_setup.setup_steps()]
        self.assertEqual(steps[-1]["id"], "connect")
        self.assertTrue(steps[-1]["form"])
        self.assertEqual(
            [s["id"] for s in steps[:-1]],
            [i for i in source_ids if i not in {"connect", "open_app_on_board"}],
        )
        self.assertIn("20 seconds", steps[-1]["after_note"])
        self.assertEqual(steps[0]["url"], app_setup.DEVELOPER_HUB_URL)

    def test_every_copy_value_has_a_button_label_and_the_manifest_is_one(self) -> None:
        steps = gui_support.wizard_steps()
        labels = {label for step in steps for label in step["copy_values"]}
        self.assertIn("App manifest (YAML)", labels)
        self.assertEqual(gui_support.copy_button_label("App manifest (YAML)"), "Copy manifest")
        self.assertEqual(gui_support.copy_button_label("Redirect URI"), "Copy Redirect URI")
        manifest = next(step["copy_values"]["App manifest (YAML)"] for step in steps if "App manifest (YAML)" in step["copy_values"])
        self.assertEqual(manifest, app_setup.app_manifest_yaml())

    def test_wizard_text_no_longer_advises_against_expiring_tokens(self) -> None:
        text = json.dumps(gui_support.wizard_steps())
        self.assertNotIn("unchecked", text)
        self.assertNotIn("Leave 'Expire", text)

    def test_resume_goes_to_the_step_after_the_last_completed_one(self) -> None:
        steps = gui_support.wizard_steps()
        self.assertEqual(gui_support.resume_step_index(steps, None), 0)
        self.assertEqual(gui_support.resume_step_index(steps, "unknown"), 0)
        self.assertEqual(gui_support.resume_step_index(steps, steps[0]["id"]), 1)
        self.assertEqual(gui_support.resume_step_index(steps, "connect"), len(steps) - 1)
        self.assertEqual(gui_support.resume_step_index([], "x"), 0)


class SettingsTests(unittest.TestCase):
    def test_round_trip_and_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "gui-settings.json"
            self.assertEqual(gui_support.load_settings(path), {})
            self.assertTrue(gui_support.save_settings({gui_support.SETUP_STEP_KEY: "create_app"}, path))
            self.assertEqual(gui_support.load_settings(path), {gui_support.SETUP_STEP_KEY: "create_app"})
            self.assertTrue(gui_support.save_settings({gui_support.SETUP_STEP_KEY: "install_app"}, path))
            self.assertEqual(gui_support.load_settings(path)[gui_support.SETUP_STEP_KEY], "install_app")
            self.assertEqual([p.name for p in path.parent.iterdir()], ["gui-settings.json"])

    def test_only_the_known_key_is_stored_so_no_secret_can_land_there(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gui-settings.json"
            gui_support.save_settings({"client_secret": "s3cret", gui_support.SETUP_STEP_KEY: "connect"}, path)
            stored = path.read_text(encoding="utf-8")
        self.assertNotIn("s3cret", stored)
        self.assertNotIn("client_secret", stored)

    def test_corrupt_or_foreign_files_read_as_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gui-settings.json"
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(gui_support.load_settings(path), {})
            path.write_text('["list"]', encoding="utf-8")
            self.assertEqual(gui_support.load_settings(path), {})
            path.write_text(json.dumps({gui_support.SETUP_STEP_KEY: 5, "x": "y"}), encoding="utf-8")
            self.assertEqual(gui_support.load_settings(path), {})

    def test_unwritable_location_returns_false(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "blocker"
            blocker.write_text("file", encoding="utf-8")
            self.assertFalse(
                gui_support.save_settings({gui_support.SETUP_STEP_KEY: "x"}, blocker / "gui-settings.json")
            )

    def test_default_location_is_under_the_app_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with patch("miro2obsidian.gui_support.paths.app_data_dir", return_value=Path(tmp)):
                self.assertEqual(gui_support.settings_path(), Path(tmp) / "gui-settings.json")


if __name__ == "__main__":
    unittest.main()
