import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import (  # noqa: E402
    _compact_short_label_html,
    _estimate_render_height,
    _expand_short_inline_label_widths,
    _is_short_text_label,
    _resolve_short_label_visual_vertical_overlaps,
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

    def test_short_label_visual_clearance_moves_label_above_neighbor(self) -> None:
        nodes = [
            {
                "id": "rice-label",
                "type": "text",
                "x": -5005,
                "y": -227,
                "width": 63,
                "height": 102,
                "text": '<span style="font-size:29px; line-height:1.35">RICE</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 29},
            },
            {
                "id": "rice-image",
                "type": "file",
                "x": -5005,
                "y": -155,
                "width": 410,
                "height": 300,
            },
        ]

        _resolve_short_label_visual_vertical_overlaps(nodes)

        self.assertEqual(nodes[0]["y"], -273)
        self.assertLessEqual(nodes[0]["y"] + nodes[0]["height"], nodes[1]["y"] - 16)

    def test_short_inline_label_width_expands_without_visual_neighbor(self) -> None:
        nodes = [
            {
                "id": "priority-label",
                "type": "text",
                "x": -6219,
                "y": -853,
                "width": 329,
                "height": 51,
                "text": '<div style="font-size:20px; line-height:1.35"><strong>Приоритезация через метрики</strong></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 20, "textAlign": "left"},
            },
            {
                "id": "distant-label",
                "type": "text",
                "x": -6219,
                "y": -700,
                "width": 200,
                "height": 50,
                "text": '<span style="font-size:20px; line-height:1.35">Другая подпись</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 20},
            },
        ]

        _expand_short_inline_label_widths(nodes)

        self.assertEqual(nodes[0]["x"], -6219)
        self.assertGreaterEqual(nodes[0]["width"], 360)

    def test_very_short_label_width_is_not_expanded(self) -> None:
        nodes = [
            {
                "id": "rice-label",
                "type": "text",
                "x": -5005,
                "y": -273,
                "width": 63,
                "height": 102,
                "text": '<span style="font-size:29px; line-height:1.35">RICE</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 29},
            },
            {
                "id": "rice-image",
                "type": "file",
                "x": -5005,
                "y": -155,
                "width": 410,
                "height": 300,
            },
        ]

        _expand_short_inline_label_widths(nodes)

        self.assertEqual(nodes[0]["width"], 63)

    def test_short_label_width_does_not_expand_over_neighbor(self) -> None:
        nodes = [
            {
                "id": "priority-label",
                "type": "text",
                "x": 0,
                "y": -66,
                "width": 200,
                "height": 50,
                "text": '<div style="font-size:20px; line-height:1.35"><strong>Приоритезация через метрики</strong></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 20, "textAlign": "left"},
            },
            {
                "id": "neighbor-label",
                "type": "text",
                "x": 250,
                "y": -66,
                "width": 100,
                "height": 50,
                "text": '<span style="font-size:20px; line-height:1.35">Сосед</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 20},
            },
        ]

        _expand_short_inline_label_widths(nodes)

        self.assertEqual(nodes[0]["width"], 200)

    def test_short_label_width_tolerates_tiny_edge_overlap(self) -> None:
        nodes = [
            {
                "id": "priority-label",
                "type": "text",
                "x": -6219,
                "y": -853,
                "width": 329,
                "height": 51,
                "text": '<div style="font-size:20px; line-height:1.35"><strong>Приоритезация через метрики</strong></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 20, "textAlign": "left"},
            },
            {
                "id": "edge-neighbor",
                "type": "text",
                "x": -5947,
                "y": -1033,
                "width": 382,
                "height": 186,
                "text": '<span style="font-size:20px; line-height:1.35">Сосед сверху</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 20},
            },
        ]

        _expand_short_inline_label_widths(nodes)

        self.assertGreaterEqual(nodes[0]["width"], 360)

    def test_short_inline_label_width_does_not_expand_when_current_width_fits(self) -> None:
        nodes = [
            {
                "id": "heading-label",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 520,
                "height": 79,
                "text": '<div style="font-size:40px; line-height:1.35"><strong>Приоритезация и оценка</strong></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 40, "textAlign": "left"},
            },
        ]

        _expand_short_inline_label_widths(nodes)

        self.assertEqual(nodes[0]["width"], 520)


if __name__ == "__main__":
    unittest.main()
