from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from audit_missing_miro_items import audit_missing_items, classify_missing_item  # noqa: E402


class MissingItemsAuditTests(unittest.TestCase):
    def test_ignores_represented_canvas_node_ids(self) -> None:
        miro = [{"id": "text-1", "type": "text", "geometry": {"width": 100, "height": 40}}]
        canvas = {"nodes": [{"id": "text-1", "type": "text"}], "edges": []}

        self.assertEqual(audit_missing_items(miro, canvas), [])

    def test_classifies_empty_preview_as_intentional_drop(self) -> None:
        item = {"id": "preview-1", "type": "preview", "isSupported": False, "data": {}, "geometry": {"width": 250, "height": 159}}

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "empty_card_like_item")
        self.assertFalse(result.actionable)

    def test_classifies_data_table_format_without_geometry(self) -> None:
        item = {"id": "format-1", "type": "data_table_format", "position": {"x": 1, "y": 2}}

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "unsupported_without_geometry")
        self.assertFalse(result.actionable)

    def test_classifies_embed_without_url_as_actionable_when_html_exists(self) -> None:
        item = {
            "id": "embed-1",
            "type": "embed",
            "data": {
                "title": "Playlist",
                "url": "",
                "html": '<iframe src="//cdn.embedly.com/widgets/media.html?url=https%3A%2F%2Fexample.com"></iframe>',
            },
            "geometry": {"width": 400, "height": 225},
        }

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "embed_without_resolvable_url")
        self.assertTrue(result.actionable)
        self.assertEqual(result.title, "Playlist")

    def test_classifies_board_metadata(self) -> None:
        result = classify_missing_item({"id": "board-1", "type": "board"})

        self.assertEqual(result.reason, "board_metadata")


if __name__ == "__main__":
    unittest.main()
