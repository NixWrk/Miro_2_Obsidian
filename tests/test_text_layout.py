import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import (  # noqa: E402
    _compact_short_label_html,
    _estimate_render_height,
    _is_short_text_label,
    _resolve_text_visual_horizontal_overlaps,
    _strip_edge_empty_paragraphs,
)


class TextLayoutTests(unittest.TestCase):
    def test_edge_empty_paragraphs_are_removed_from_labels(self) -> None:
        html = "<p><br /></p><p><strong>4. Revenue / Monetisation</strong></p><p><br /></p>"

        self.assertEqual(
            _strip_edge_empty_paragraphs(html),
            "<p><strong>4. Revenue / Monetisation</strong></p>",
        )

    def test_short_label_detection_rejects_long_list_content(self) -> None:
        self.assertTrue(_is_short_text_label("<p><strong>Приоритезация и оценка</strong></p>"))
        self.assertFalse(_is_short_text_label("<ol><li>One</li><li>Two</li></ol>"))

    def test_short_label_html_unwraps_paragraph_margins(self) -> None:
        self.assertEqual(
            _compact_short_label_html("<p><strong>Приоритезация по ROI</strong></p>"),
            "<strong>Приоритезация по ROI</strong>",
        )

    def test_single_html_paragraph_does_not_add_an_extra_line(self) -> None:
        plain = _estimate_render_height("Short title", width_px=400, font_px=20, line_height=1.4)
        html = _estimate_render_height("<p>Short title</p>", width_px=400, font_px=20, line_height=1.4)

        self.assertEqual(html, plain)

    def test_explicit_second_paragraph_adds_one_line(self) -> None:
        one = _estimate_render_height("<p>First</p>", width_px=400, font_px=20, line_height=1.4)
        two = _estimate_render_height(
            "<p>First</p><p>Second</p>",
            width_px=400,
            font_px=20,
            line_height=1.4,
        )

        self.assertEqual(two - one, int(20 * 1.4))

    def test_text_visual_clearance_shrinks_conflicting_edge(self) -> None:
        nodes = [
            {
                "id": "wide-text",
                "type": "text",
                "x": -274,
                "y": -132,
                "width": 548,
                "height": 264,
                "text": '<div style="font-size:23px; line-height:1.35"><p>Long multiline text that should clear the visual neighbor.</p></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 23},
            },
            {
                "id": "right-image",
                "type": "file",
                "x": 236,
                "y": -197.5,
                "width": 548,
                "height": 395,
            },
        ]

        _resolve_text_visual_horizontal_overlaps(nodes, min_font_px=8)

        self.assertEqual(nodes[0]["x"], -274)
        self.assertEqual(nodes[0]["width"], 494)
        self.assertLessEqual(nodes[0]["x"] + nodes[0]["width"], nodes[1]["x"] - 16)


if __name__ == "__main__":
    unittest.main()
