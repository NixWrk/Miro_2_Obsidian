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

    def test_board_choice_label_keeps_same_name_boards_distinct(self) -> None:
        first = miro_json_gui.board_choice_label(
            {"id": "board-1", "name": "Roadmap", "team": {"name": "Team A"}}
        )
        second = miro_json_gui.board_choice_label(
            {"id": "board-2", "name": "Roadmap", "team": {"name": "Team A"}}
        )

        self.assertNotEqual(first, second)
        self.assertIn("board-1", first)
        self.assertIn("Team A", first)

    def test_main_thread_bridge_returns_values_and_propagates_errors(self) -> None:
        class ImmediateApp:
            @staticmethod
            def after(_delay, callback):
                callback()

        bridge = miro_json_gui.MiroDownloaderApp._ask_in_main_thread
        self.assertEqual(bridge(ImmediateApp(), lambda: "ok", timeout=1), "ok")
        with self.assertRaisesRegex(ValueError, "callback failed"):
            bridge(
                ImmediateApp(),
                lambda: (_ for _ in ()).throw(ValueError("callback failed")),
                timeout=1,
            )

    def test_main_thread_bridge_reports_timeout(self) -> None:
        class StalledApp:
            @staticmethod
            def after(_delay, _callback):
                return None

        with self.assertRaisesRegex(TimeoutError, "Tk main thread"):
            miro_json_gui.MiroDownloaderApp._ask_in_main_thread(
                StalledApp(),
                lambda: None,
                timeout=0,
            )



    def test_progress_and_file_callbacks_defer_widget_mutations(self) -> None:
        callbacks = []

        class ProgressBar:
            values = []

            def set(self, value):
                self.values.append(value)

        class Label:
            values = []

            def configure(self, **kwargs):
                self.values.append(kwargs)

        class Row:
            events = []

            def set_done(self):
                self.events.append(("done", None))

            def set_skipped(self, message):
                self.events.append(("skipped", message))

            def set_error(self, message):
                self.events.append(("error", message))

        class App:
            overall_pb = ProgressBar()
            progress_label = Label()
            file_rows = {"item-1": Row()}

            @staticmethod
            def after(_delay, callback):
                callbacks.append(callback)

        app = App()
        miro_json_gui.MiroDownloaderApp.update_overall_progress(app, 1, 2)
        miro_json_gui.MiroDownloaderApp._on_file_done(app, "item-1")
        miro_json_gui.MiroDownloaderApp._on_file_fail(app, "item-1", "download failed")

        self.assertEqual(app.overall_pb.values, [])
        self.assertEqual(app.file_rows["item-1"].events, [])
        for callback in callbacks:
            callback()

        self.assertEqual(app.overall_pb.values, [0.5])
        self.assertEqual(app.progress_label.values, [{"text": "1 / 2"}])
        self.assertEqual(
            app.file_rows["item-1"].events,
            [("done", None), ("error", "download failed")],
        )

if __name__ == "__main__":
    unittest.main()
