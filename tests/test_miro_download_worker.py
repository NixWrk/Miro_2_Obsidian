from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

from Miro_2_Json.download_worker import run_download  # noqa: E402
from Miro_2_Json.miro_downloader import download_all, write_json  # noqa: E402


def worker_kwargs(root: Path, *, ask_strategy):
    return {
        "board_id": "board-1",
        "token": "token-1",
        "save_base": root,
        "safe_team": "team",
        "safe_board": "board",
        "rename_files": True,
        "prefer_experimental": True,
        "canonical": False,
        "log": lambda _message: None,
        "ask_strategy": ask_strategy,
        "ask_continue_forbidden": lambda *_args: False,
        "ask_exp_fallback": lambda _count: False,
        "on_prepare_rows": lambda *_args: None,
        "on_file_start": lambda *_args: None,
        "on_file_done": lambda *_args: None,
        "on_file_fail": lambda *_args: None,
        "on_overall_progress": lambda *_args: None,
    }


class MiroDownloadWorkerTests(unittest.TestCase):
    def test_default_gui_mode_uses_complete_canonical_exporter(self) -> None:
        payload = {"items": [{"id": "item-1"}], "comments": [{"id": "comment-1"}]}
        info = {"asset_stats": {"failed": 0}}
        with tempfile.TemporaryDirectory(prefix="miro2obs_worker_canonical_") as tmp:
            root = Path(tmp)
            kwargs = worker_kwargs(root, ask_strategy=lambda _paths: "overwrite")
            kwargs["canonical"] = True
            with (
                patch("Miro_2_Json.download_worker.export_complete_board_source", return_value=(payload, info)) as export,
                patch("Miro_2_Json.download_worker.get_items_on_board") as legacy_items,
            ):
                result = run_download(**kwargs)

        self.assertEqual(result, root / "team_board.json")
        export.assert_called_once()
        self.assertTrue(export.call_args.kwargs["download_assets"])
        self.assertFalse(export.call_args.kwargs["allow_missing_assets"])
        legacy_items.assert_not_called()

    def test_cancelled_conflict_returns_none_without_writing_json(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_worker_cancel_") as tmp:
            root = Path(tmp)
            (root / "team_board.json").write_text("[]", encoding="utf-8")
            with (
                patch("Miro_2_Json.download_worker.get_items_on_board", return_value=[]),
                patch("Miro_2_Json.download_worker.write_json") as save,
            ):
                result = run_download(**worker_kwargs(root, ask_strategy=lambda _paths: None))

        self.assertIsNone(result)
        save.assert_not_called()

    def test_success_returns_the_written_json_path(self) -> None:
        item = {"id": "text-1", "type": "text", "data": {"content": "hello"}}
        with tempfile.TemporaryDirectory(prefix="miro2obs_worker_success_") as tmp:
            root = Path(tmp)
            expected = root / "team_board.json"
            with (
                patch("Miro_2_Json.download_worker.get_items_on_board", return_value=[item]),
                patch("Miro_2_Json.download_worker.write_json") as save,
            ):
                result = run_download(**worker_kwargs(root, ask_strategy=lambda _paths: "overwrite"))

        self.assertEqual(result, expected)
        save.assert_called_once()
        self.assertEqual(save.call_args.args[0], expected)

    def test_headless_download_reports_handled_failures(self) -> None:
        item = {"id": "image-1", "type": "image", "data": {"imageUrl": ""}}
        failed: list[tuple[str, str]] = []
        progress: list[tuple[int, int]] = []
        with tempfile.TemporaryDirectory(prefix="miro2obs_headless_failure_") as tmp:
            root = Path(tmp)
            result = download_all(
                [item],
                root,
                "token-1",
                "team",
                "board",
                id_to_final_path={"image-1": root / "image.png"},
                on_file_fail=lambda item_id, reason: failed.append((str(item_id), reason)),
                on_overall_progress=lambda done, total: progress.append((done, total)),
            )

        self.assertEqual(result, [("image-1", "пустой URL")])
        self.assertEqual(failed, result)
        self.assertEqual(progress, [(1, 1)])

    def test_handled_asset_failure_preserves_json_and_raises(self) -> None:
        item = {"id": "image-1", "type": "image", "data": {"imageUrl": ""}}
        failures: list[tuple[str, str]] = []
        with tempfile.TemporaryDirectory(prefix="miro2obs_worker_failure_") as tmp:
            root = Path(tmp)
            kwargs = worker_kwargs(root, ask_strategy=lambda _paths: "overwrite")
            kwargs["on_file_fail"] = lambda item_id, reason: failures.append((str(item_id), reason))
            with (
                patch("Miro_2_Json.download_worker.get_items_on_board", return_value=[item]),
                patch("Miro_2_Json.download_worker.write_json") as save,
            ):
                with self.assertRaisesRegex(RuntimeError, "asset download"):
                    run_download(**kwargs)

        save.assert_called_once()
        self.assertEqual(failures, [("image-1", "пустой URL")])

    def test_atomic_json_write_preserves_existing_file_when_replace_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_json_write_") as tmp:
            target = Path(tmp) / "board.json"
            target.write_text("old", encoding="utf-8")

            with patch.object(Path, "replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    write_json(target, [{"id": "new"}])

            self.assertEqual(target.read_text(encoding="utf-8"), "old")
            self.assertFalse(target.with_suffix(".json.tmp").exists())

    def test_asset_worker_exceptions_are_propagated(self) -> None:
        item = {
            "id": "image-1",
            "type": "image",
            "data": {"imageUrl": "https://assets.example.test/image"},
        }
        with tempfile.TemporaryDirectory(prefix="miro2obs_worker_error_") as tmp:
            root = Path(tmp)
            with patch(
                "Miro_2_Json.miro_downloader.download_resource_with_redirect",
                side_effect=RuntimeError("worker failed"),
            ):
                with self.assertRaisesRegex(RuntimeError, "asset download worker"):
                    download_all(
                        [item],
                        root,
                        "token-1",
                        "team",
                        "board",
                        id_to_final_path={"image-1": root / "image.png"},
                    )


if __name__ == "__main__":
    unittest.main()
