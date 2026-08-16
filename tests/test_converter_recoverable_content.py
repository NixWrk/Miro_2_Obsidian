from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "Json_2_Canvas"))

from Converter import convert_item_to_canvas_node  # noqa: E402


def convert(item: dict) -> dict | None:
    return convert_item_to_canvas_node(
        item,
        str(REPO_ROOT),
        str(REPO_ROOT),
    )


class ConverterRecoverableContentTests(unittest.TestCase):
    def test_card_preserves_fields_and_source_url(self) -> None:
        node = convert(
            {
                "id": "card-1",
                "type": "card",
                "data": {
                    "title": "Release",
                    "fields": [
                        {"label": "Status", "value": "Ready"},
                        {"label": "Owner", "value": {"name": "Ada"}},
                    ],
                    "url": "https://example.test/cards/1",
                },
                "geometry": {"width": 320, "height": 160},
                "position": {"x": 0, "y": 0},
            }
        )

        self.assertIsNotNone(node)
        self.assertIn("Status", node["text"])
        self.assertIn("Ready", node["text"])
        self.assertIn("Owner", node["text"])
        self.assertIn("Ada", node["text"])
        self.assertIn("https://example.test/cards/1", node["text"])

    def test_preview_url_metadata_falls_back_to_text_placeholder(self) -> None:
        node = convert(
            {
                "id": "preview-1",
                "type": "preview",
                "data": {"previewUrl": "https://example.test/preview.png"},
                "geometry": {"width": 240, "height": 120},
                "position": {"x": 10, "y": 20},
            }
        )

        self.assertIsNotNone(node)
        self.assertEqual(node["type"], "text")
        self.assertIn("https://example.test/preview.png", node["text"])

    def test_preview_target_url_uses_native_link_node(self) -> None:
        node = convert(
            {
                "id": "preview-link",
                "type": "preview",
                "data": {"url": "https://example.test/article"},
                "geometry": {"width": 240, "height": 120},
                "position": {"x": 10, "y": 20},
            }
        )

        self.assertIsNotNone(node)
        self.assertEqual(node["type"], "link")
        self.assertEqual(node["url"], "https://example.test/article")

    def test_empty_table_cell_with_web_link_is_not_dropped(self) -> None:
        node = convert(
            {
                "id": "cell-1",
                "type": "table_text",
                "links": {"web": "https://miro.test/?moveToWidget=cell-1"},
                "geometry": {"width": 160, "height": 36},
                "position": {"x": 0, "y": 0},
            }
        )

        self.assertIsNotNone(node)
        self.assertIn("moveToWidget=cell-1", node["text"])

    def test_positionless_tag_title_is_preserved(self) -> None:
        node = convert({"id": "tag-1", "type": "tag", "title": "Critical"})

        self.assertIsNotNone(node)
        self.assertEqual(node["id"], "tag-1")
        self.assertIn("Critical", node["text"])


if __name__ == "__main__":
    unittest.main()
