from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from merge_miro_sources import merge_sources, normalize_websdk_item  # noqa: E402


class MergeMiroSourcesTests(unittest.TestCase):
    def test_preserves_rest_item_and_marks_shared_websdk_surface(self) -> None:
        rest = [{"id": "text-1", "type": "text", "data": {"content": "<p>REST</p>"}}]
        websdk = {"items": [{"id": "text-1", "type": "text", "content": "<p>SDK</p>"}]}

        merged = merge_sources(rest, websdk)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["data"]["content"], "<p>REST</p>")
        self.assertEqual(merged[0]["source_surfaces"], ["rest", "web_sdk"])
        self.assertIn("websdk_item", merged[0])

    def test_adds_websdk_only_tag_as_placeable_item(self) -> None:
        websdk_item = {"id": "tag-1", "type": "tag", "x": 10, "y": 20, "width": 80, "height": 24, "title": "Urgent"}

        merged = merge_sources([], {"items": [websdk_item]})

        self.assertEqual(merged[0]["type"], "tag")
        self.assertEqual(merged[0]["position"], {"x": 10, "y": 20})
        self.assertEqual(merged[0]["geometry"], {"width": 80, "height": 24})
        self.assertEqual(merged[0]["data"]["title"], "Urgent")

    def test_normalizes_websdk_only_unsupported_item_for_converter_placeholder(self) -> None:
        item = {"id": "mind-1", "type": "mindmap", "x": 1, "y": 2, "width": 300, "height": 200, "title": "Mind map"}

        normalized = normalize_websdk_item(item)

        self.assertEqual(normalized["type"], "mindmap")
        self.assertEqual(normalized["source_surfaces"], ["web_sdk"])
        self.assertEqual(normalized["geometry"]["width"], 300)
        self.assertEqual(normalized["data"]["title"], "Mind map")


if __name__ == "__main__":
    unittest.main()
