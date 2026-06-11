from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_rest_export_board import export_board_items, write_json  # noqa: E402


class MiroRestExportBoardTests(unittest.TestCase):
    def test_export_board_items_uses_existing_downloader_and_dedupes(self) -> None:
        raw_items = [
            {"id": "text-1", "type": "text", "source": "items(v2)", "data": {"content": "<p>Old</p>"}},
            {"id": "text-1", "type": "text", "source": "items(v2-experimental)", "data": {"content": "<p>New</p>"}},
        ]
        with patch("miro_rest_export_board.get_items_on_board", return_value=raw_items) as get_items:
            items = export_board_items(board_id="board-1", token="token-1", prefer_experimental=True)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "text-1")
        self.assertIn("moveToWidget=text-1", items[0]["links"]["web"])
        get_items.assert_called_once()
        self.assertTrue(get_items.call_args.kwargs["prefer_experimental_items"])
        self.assertTrue(get_items.call_args.kwargs["confirm_skip_source"]("tags", 403, "forbidden"))
        self.assertTrue(get_items.call_args.kwargs["confirm_exp_fallback"](10))

    def test_write_json_creates_parent_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "rest_export.json"

            write_json(path, [{"id": "item-1", "type": "text"}])

            self.assertTrue(path.exists())
            self.assertIn('"item-1"', path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
