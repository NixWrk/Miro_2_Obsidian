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

        self.assertEqual(result.reason, "table_source_limited")
        self.assertFalse(result.actionable)

    def test_classifies_position_only_unsupported_item_as_actionable(self) -> None:
        item = {"id": "custom-1", "type": "custom_widget", "position": {"x": 1, "y": 2}, "isSupported": False}

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "unsupported_position_only")
        self.assertTrue(result.actionable)

    def test_classifies_known_position_only_source_limited_item(self) -> None:
        item = {"id": "flip-1", "type": "flip_card", "position": {"x": 1, "y": 2}, "isSupported": False}

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "source_limited_unsupported_content")
        self.assertFalse(result.actionable)

    def test_classifies_empty_table_text_as_source_limited(self) -> None:
        item = {
            "id": "cell-1",
            "type": "table_text",
            "isSupported": False,
            "geometry": {"width": 120, "height": 30},
            "position": {"x": 0, "y": 0},
        }

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "table_source_limited")
        self.assertFalse(result.actionable)

    def test_classifies_empty_table_item_as_source_limited(self) -> None:
        item = {
            "id": "table-1",
            "type": "table",
            "isSupported": False,
            "geometry": {"width": 320, "height": 180},
            "position": {"x": 0, "y": 0},
        }

        result = classify_missing_item(item)

        self.assertEqual(result.reason, "table_source_limited")
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

        self.assertEqual(result.reason, "recoverable_content_missing")
        self.assertTrue(result.actionable)
        self.assertEqual(result.title, "Playlist")

    def test_classifies_table_link_as_recoverable(self) -> None:
        result = classify_missing_item({
            "id": "cell-1",
            "type": "table_text",
            "links": {"web": "https://miro.test/?moveToWidget=cell-1"},
            "geometry": {"width": 120, "height": 30},
        })

        self.assertEqual(result.reason, "recoverable_content_missing")
        self.assertTrue(result.actionable)

    def test_reports_incomplete_source_envelope(self) -> None:
        miro = {
            "items": [],
            "comments": [],
            "completeness": {
                "complete": False,
                "items": {"complete": True},
                "comments": {"complete": False},
                "assets": {"complete": False, "checked": False},
            },
        }

        missing = audit_missing_items(miro, {"nodes": [], "edges": []})

        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0].item_id, "__source__")
        self.assertEqual(missing[0].reason, "source_incomplete")
        self.assertTrue(missing[0].actionable)
        self.assertIn("comments.complete", missing[0].detail)

    def test_required_local_asset_needs_a_canvas_file_node(self) -> None:
        item = {
            "id": "doc-1",
            "type": "document",
            "local_name": "doc.pdf",
            "data": {"title": "Document"},
        }
        missing = audit_missing_items(
            [item],
            {"nodes": [{"id": "doc-1", "type": "text"}], "edges": []},
        )

        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0].reason, "required_asset_not_represented")
        self.assertTrue(missing[0].actionable)

    def test_known_board_coverage_limit_is_visible_but_not_actionable(self) -> None:
        miro = {
            "items": [],
            "comments": [],
            "completeness": {
                "complete": True,
                "capture_complete": True,
                "board_complete": False,
                "items": {"complete": True},
                "comments": {"complete": True},
                "assets": {"complete": True, "checked": True},
            },
        }

        missing = audit_missing_items(miro, {"nodes": [], "edges": []})

        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0].reason, "source_coverage_limited")
        self.assertFalse(missing[0].actionable)

    def test_classifies_board_metadata(self) -> None:
        result = classify_missing_item({"id": "board-1", "type": "board"})

        self.assertEqual(result.reason, "board_metadata")


if __name__ == "__main__":
    unittest.main()
