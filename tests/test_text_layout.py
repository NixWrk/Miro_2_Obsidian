import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import _estimate_render_height, _is_short_text_label, _strip_edge_empty_paragraphs  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
