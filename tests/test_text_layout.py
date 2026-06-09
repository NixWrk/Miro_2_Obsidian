import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import (  # noqa: E402
    _compact_short_label_html,
    _compact_short_inline_label_heights,
    _estimate_render_height,
    _expand_short_inline_label_widths,
    _is_short_text_label,
    _recover_embed_url,
    _resolve_link_visual_overlaps,
    _resolve_text_text_horizontal_edge_overlaps,
    _resolve_short_label_visual_vertical_overlaps,
    _resolve_text_text_vertical_overlaps,
    _resolve_text_visual_horizontal_overlaps,
    _resolve_text_visual_vertical_stack_overlaps,
    _resolve_ultra_narrow_label_visual_overlaps,
    _strip_edge_empty_paragraphs,
)


class TextLayoutTests(unittest.TestCase):
    def test_edge_empty_paragraphs_are_removed_from_labels(self) -> None:
        html = "<p><br /></p><p><strong>4. Revenue / Monetisation</strong></p><p><br /></p>"

        self.assertEqual(
            _strip_edge_empty_paragraphs(html),
            "<p><strong>4. Revenue / Monetisation</strong></p>",
        )

    def test_embed_url_recovers_from_embedly_iframe_query(self) -> None:
        html = (
            '<iframe src="//cdn.embedly.com/widgets/media.html?'
            'src=http%3A%2F%2Fwww.youtube.com%2Fembed%2Fvideoseries%3Flist%3DPL-example'
            '&url=https%3A%2F%2Fwww.youtube.com%2Fplaylist%3Flist%3DPL-example'
            '&schema=youtube"></iframe>'
        )

        self.assertEqual(
            _recover_embed_url({"url": "", "html": html}),
            "https://www.youtube.com/playlist?list=PL-example",
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

    def test_text_text_vertical_clearance_moves_lower_text_down(self) -> None:
        nodes = [
            {
                "id": "deadline-heading",
                "type": "text",
                "x": -2147,
                "y": -820,
                "width": 345,
                "height": 137,
                "text": '<div style="font-size:28px; line-height:1.35">Deadline</div>',
                "styleAttributes": {"border": "invisible", "fontSize": 28},
            },
            {
                "id": "deadline-notes",
                "type": "text",
                "x": -2147,
                "y": -745,
                "width": 714,
                "height": 235,
                "text": '<div style="font-size:16px; line-height:1.35"><ol><li>Scope</li></ol></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 16},
            },
        ]

        _resolve_text_text_vertical_overlaps(nodes)

        self.assertEqual(nodes[0]["y"], -820)
        self.assertGreaterEqual(nodes[1]["y"], nodes[0]["y"] + nodes[0]["height"] + 16)

    def test_text_text_horizontal_edge_clearance_moves_right_text_sideways(self) -> None:
        nodes = [
            {
                "id": "left-title",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 400,
                "height": 88,
                "text": '<div style="font-size:24px; line-height:1.35">GPT trainer management section</div>',
                "styleAttributes": {"border": "invisible", "fontSize": 24},
            },
            {
                "id": "right-title",
                "type": "text",
                "x": 382,
                "y": 0,
                "width": 360,
                "height": 88,
                "text": '<div style="font-size:24px; line-height:1.35">GPT trainer product section</div>',
                "styleAttributes": {"border": "invisible", "fontSize": 24},
            },
        ]

        _resolve_text_text_horizontal_edge_overlaps(nodes)

        self.assertGreaterEqual(nodes[1]["x"], nodes[0]["x"] + nodes[0]["width"] + 16)

    def test_link_visual_clearance_moves_link_away_from_file(self) -> None:
        nodes = [
            {
                "id": "image",
                "type": "file",
                "x": -190,
                "y": -2637,
                "width": 660,
                "height": 346,
            },
            {
                "id": "video",
                "type": "link",
                "x": 95,
                "y": -2647,
                "width": 320,
                "height": 180,
                "url": "https://example.com/video",
            },
        ]

        _resolve_link_visual_overlaps(nodes)

        self.assertEqual(nodes[0]["x"], -190)
        self.assertLessEqual(nodes[1]["y"] + nodes[1]["height"], nodes[0]["y"] - 16)

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

    def test_short_label_visual_clearance_moves_label_below_when_center_is_inside_neighbor(self) -> None:
        nodes = [
            {
                "id": "metric-label",
                "type": "text",
                "x": -5092,
                "y": 827,
                "width": 106,
                "height": 45,
                "text": '<span style="font-size:8px; line-height:1.35">4. Revenue / Monetisation</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 8},
            },
            {
                "id": "metric-video",
                "type": "link",
                "x": -5183,
                "y": 688,
                "width": 320,
                "height": 180,
                "url": "https://example.com/video",
            },
        ]

        _resolve_short_label_visual_vertical_overlaps(nodes)

        self.assertGreaterEqual(nodes[0]["y"], nodes[1]["y"] + nodes[1]["height"] + 16)

    def test_text_visual_vertical_stack_moves_lower_visual_down(self) -> None:
        nodes = [
            {
                "id": "long-text",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 300,
                "height": 120,
                "text": '<div style="font-size:8px; line-height:1.35"><p>Long text that grew after min font fitting and now needs a separate vertical stack clearance rule.</p></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 8},
            },
            {
                "id": "below-image",
                "type": "file",
                "x": 0,
                "y": 90,
                "width": 300,
                "height": 180,
            },
        ]

        _resolve_text_visual_vertical_stack_overlaps(nodes)

        self.assertGreaterEqual(nodes[1]["y"], nodes[0]["y"] + nodes[0]["height"] + 16)

    def test_text_visual_vertical_stack_ignores_group_container(self) -> None:
        nodes = [
            {
                "id": "container",
                "type": "group",
                "x": -20,
                "y": -20,
                "width": 360,
                "height": 360,
            },
            {
                "id": "long-text",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 300,
                "height": 120,
                "text": '<div style="font-size:8px; line-height:1.35"><p>Long text that grew after min font fitting and now needs a separate vertical stack clearance rule.</p></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 8},
            },
            {
                "id": "below-image",
                "type": "file",
                "x": 0,
                "y": 90,
                "width": 300,
                "height": 180,
            },
        ]

        _resolve_text_visual_vertical_stack_overlaps(nodes)

        self.assertGreaterEqual(nodes[2]["y"], nodes[1]["y"] + nodes[1]["height"] + 16)

    def test_text_visual_vertical_stack_pushes_blocking_lower_nodes_down(self) -> None:
        nodes = [
            {
                "id": "above-blocker",
                "type": "text",
                "x": 0,
                "y": -126,
                "width": 300,
                "height": 110,
                "text": '<div style="font-size:8px; line-height:1.35">Earlier text block</div>',
                "styleAttributes": {"border": "invisible", "fontSize": 8},
            },
            {
                "id": "long-text",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 300,
                "height": 120,
                "text": '<div style="font-size:8px; line-height:1.35"><p>Long text that grew after min font fitting and now needs a separate vertical stack clearance rule.</p></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 8},
            },
            {
                "id": "below-image",
                "type": "file",
                "x": 0,
                "y": 90,
                "width": 300,
                "height": 180,
            },
            {
                "id": "below-blocker",
                "type": "file",
                "x": 0,
                "y": 286,
                "width": 300,
                "height": 120,
            },
        ]

        _resolve_text_visual_vertical_stack_overlaps(nodes)

        self.assertGreaterEqual(nodes[2]["y"], nodes[1]["y"] + nodes[1]["height"] + 16)
        self.assertGreaterEqual(nodes[3]["y"], nodes[2]["y"] + nodes[2]["height"] + 16)

    def test_short_label_visual_clearance_can_push_lower_visual_down(self) -> None:
        nodes = [
            {
                "id": "label",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 140,
                "height": 45,
                "text": '<span style="font-size:11px; line-height:1.35">Interviews</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 11},
            },
            {
                "id": "lower-image",
                "type": "file",
                "x": 0,
                "y": 38,
                "width": 140,
                "height": 50,
            },
            {
                "id": "upper-blocker",
                "type": "file",
                "x": 0,
                "y": -23,
                "width": 140,
                "height": 45,
            },
            {
                "id": "lower-blocker",
                "type": "file",
                "x": 0,
                "y": 104,
                "width": 140,
                "height": 45,
            },
        ]

        _resolve_short_label_visual_vertical_overlaps(nodes)

        self.assertGreaterEqual(nodes[1]["y"], nodes[0]["y"] + nodes[0]["height"] + 16)
        self.assertGreaterEqual(nodes[3]["y"], nodes[1]["y"] + nodes[1]["height"] + 16)

    def test_short_inline_label_height_compacts_to_single_line_need(self) -> None:
        nodes = [
            {
                "id": "interview-label",
                "type": "text",
                "x": -3944,
                "y": -1813,
                "width": 100,
                "height": 46,
                "text": '<div style="font-size:11px; line-height:1.35"><strong>Interviews</strong></div>',
                "styleAttributes": {"border": "invisible", "fontSize": 11},
            },
            {
                "id": "below-image",
                "type": "file",
                "x": -3944,
                "y": -1776,
                "width": 100,
                "height": 42,
            },
        ]

        _compact_short_inline_label_heights(nodes)

        self.assertLess(nodes[0]["height"], 46)
        self.assertGreaterEqual(nodes[0]["height"], 30)

    def test_ultra_narrow_label_moves_to_readable_free_slot_around_visual(self) -> None:
        nodes = [
            {
                "id": "visual",
                "type": "file",
                "x": 0,
                "y": 0,
                "width": 400,
                "height": 260,
            },
            {
                "id": "label",
                "type": "text",
                "x": 398,
                "y": 30,
                "width": 2,
                "height": 180,
                "text": '<span style="font-size:8px; line-height:1.35">Customer Development</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 8},
            },
        ]

        _resolve_ultra_narrow_label_visual_overlaps(nodes)

        self.assertGreaterEqual(nodes[1]["width"], 64)
        overlap_w, overlap_h = (
            min(nodes[0]["x"] + nodes[0]["width"], nodes[1]["x"] + nodes[1]["width"]) - max(nodes[0]["x"], nodes[1]["x"]),
            min(nodes[0]["y"] + nodes[0]["height"], nodes[1]["y"] + nodes[1]["height"]) - max(nodes[0]["y"], nodes[1]["y"]),
        )
        self.assertTrue(overlap_w <= 0 or overlap_h <= 0)

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

    def test_very_short_label_width_expands_to_readable_width(self) -> None:
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
            {
                "id": "kano-label",
                "type": "text",
                "x": -4072,
                "y": -243,
                "width": 55,
                "height": 83,
                "text": '<span style="font-size:22px; line-height:1.35">\u041a\u0430\u043d\u043e</span>',
                "styleAttributes": {"border": "invisible", "fontSize": 22},
            },
            {
                "id": "kano-image",
                "type": "file",
                "x": -4072,
                "y": -144,
                "width": 410,
                "height": 300,
            },
        ]

        _expand_short_inline_label_widths(nodes)

        self.assertGreaterEqual(nodes[0]["width"], 120)
        self.assertGreaterEqual(nodes[2]["width"], 108)

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
