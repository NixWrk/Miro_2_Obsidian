from __future__ import annotations

import copy
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from Json_2_Canvas.Converter import convert_miro_to_canvas
from Json_2_Canvas.output_formats import (
    ADVANCED_CANVAS,
    MIRO_CANVAS,
    NATIVE_CANVAS,
    OUTPUT_FORMATS,
    RAW_JSON,
    apply_output_format,
    normalize_output_format,
    to_miro_canvas,
    to_native_canvas,
)
from miro2obsidian.schema import validate_board

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

#: Fixtures picked to exercise what the task calls out: text with bold, a
#: link, and a list; frames and connectors; an image; a link node; and a
#: presentation deck.
FIXTURE_NAMES = (
    "text_text_vertical_clearance",  # bold + ordered list
    "labeled_anchor_text_not_link_card",  # link + bold
    "slide_connector_across_deck_frames",  # frames (group) + connectors (edges)
    "image_file_compact_label",  # file node (image)
    "embed_recovered_url",  # link node
    "slide_compact_overview",  # a presentation deck
)

_HTML_TAG_RE = re.compile(r"<[a-zA-Z/][^>]*>")

_ALLOWED_NODE_FIELDS = {
    "id", "type", "x", "y", "width", "height", "color", "text", "file",
    "subpath", "url", "label", "background", "backgroundStyle",
}
_ALLOWED_EDGE_FIELDS = {
    "id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd",
    "color", "label",
}


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _advanced_canvas_board(fixture_name: str) -> dict[str, Any]:
    """Run the real converter on a fixture, the same way the production
    pipeline does, and return the advanced-canvas board these transforms
    start from. Mirrors test_fixture_regressions.py's own converter runner."""
    fixture_dir = FIXTURES_DIR / fixture_name
    with tempfile.TemporaryDirectory(prefix=f"output_formats_{fixture_name}_") as tmp:
        work_dir = Path(tmp)
        input_path = work_dir / "input.miro.json"
        shutil.copy2(fixture_dir / "input.miro.json", input_path)

        source_files = fixture_dir / "input.miro_files"
        if source_files.exists():
            shutil.copytree(source_files, work_dir / "input.miro_files")

        vault_root = work_dir / "vault"
        target_dir = vault_root / "MIRO2OBSIDIAN"
        target_dir.mkdir(parents=True)

        manifest = _load_json(fixture_dir / "case.json")
        converter_cfg = manifest.get("converter", {})

        canvas_path = convert_miro_to_canvas(
            str(input_path),
            str(target_dir),
            str(vault_root),
            scale=float(converter_cfg.get("scale", 1.0)),
            min_font_px=int(converter_cfg.get("min_font_px", 8)),
            theme=str(converter_cfg.get("theme", "dark")),
            text_style_mode=str(converter_cfg.get("text_style_mode", "miro")),
        )
        return _load_json(Path(canvas_path))


class OutputFormatConstantsTests(unittest.TestCase):
    def test_output_formats_tuple_has_the_four_settled_formats(self) -> None:
        self.assertEqual(
            OUTPUT_FORMATS,
            (ADVANCED_CANVAS, NATIVE_CANVAS, MIRO_CANVAS, RAW_JSON),
        )

    def test_normalize_output_format_accepts_case_and_whitespace(self) -> None:
        self.assertEqual(normalize_output_format(" Native-Canvas "), NATIVE_CANVAS)

    def test_normalize_output_format_defaults_to_advanced_canvas(self) -> None:
        self.assertEqual(normalize_output_format(None), ADVANCED_CANVAS)

    def test_normalize_output_format_rejects_unknown_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unknown output format"):
            normalize_output_format("obsidian-canvas")

    def test_apply_output_format_rejects_non_board_formats(self) -> None:
        with self.assertRaisesRegex(ValueError, "not a board transform"):
            apply_output_format({"nodes": [], "edges": []}, RAW_JSON)


class SyntheticTransformTests(unittest.TestCase):
    """Hand-built boards, so the field allowlist and purity are checked
    without depending on what a fixture happens to contain."""

    def test_to_native_canvas_keeps_only_json_canvas_fields(self) -> None:
        board = {
            "nodes": [
                {
                    "id": "n1",
                    "type": "text",
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 50,
                    "text": '<div style="font-size:12px"><p>Hi</p></div>',
                    "styleAttributes": {"fontSize": 12},
                }
            ],
            "edges": [
                {
                    "id": "e1",
                    "fromNode": "n1",
                    "toNode": "n1",
                    "styleAttributes": {"path": "dotted"},
                }
            ],
            "miroSource": {"items": []},
            "metadata": {"version": "1.0-1.0"},
        }

        result = to_native_canvas(board)

        self.assertEqual(set(result.keys()), {"nodes", "edges"})
        self.assertEqual(result["nodes"][0]["text"], "Hi")
        self.assertNotIn("styleAttributes", result["nodes"][0])
        self.assertNotIn("styleAttributes", result["edges"][0])

    def test_to_native_canvas_leaves_plain_text_untouched(self) -> None:
        board = {
            "nodes": [
                {"id": "n1", "type": "text", "x": 0, "y": 0, "width": 1, "height": 1, "text": "plain"}
            ],
            "edges": [],
        }
        result = to_native_canvas(board)
        self.assertEqual(result["nodes"][0]["text"], "plain")

    def test_to_native_canvas_does_not_mutate_its_input(self) -> None:
        board = {
            "nodes": [
                {
                    "id": "n1",
                    "type": "text",
                    "x": 0,
                    "y": 0,
                    "width": 1,
                    "height": 1,
                    "text": "<p>Hi</p>",
                    "styleAttributes": {"fontSize": 12},
                }
            ],
            "edges": [],
            "miroSource": {"items": []},
        }
        before = copy.deepcopy(board)
        to_native_canvas(board)
        self.assertEqual(board, before)

    def test_to_miro_canvas_keeps_miro_source_identical_and_adds_marker(self) -> None:
        source = {"items": [{"id": "n1", "type": "text"}]}
        board = {
            "nodes": [
                {"id": "n1", "type": "text", "x": 0, "y": 0, "width": 1, "height": 1, "text": "plain"}
            ],
            "edges": [],
            "miroSource": source,
        }

        result = to_miro_canvas(board)

        self.assertEqual(result["miroSource"], source)
        self.assertIsNot(result["miroSource"], source)
        self.assertEqual(result["miroCanvas"], {"schemaVersion": 1})

    def test_to_miro_canvas_does_not_mutate_its_input(self) -> None:
        board = {
            "nodes": [],
            "edges": [],
            "miroSource": {"items": [{"id": "n1", "type": "text"}]},
        }
        before = copy.deepcopy(board)
        to_miro_canvas(board)
        self.assertEqual(board, before)

    def test_to_miro_canvas_without_miro_source_still_adds_marker(self) -> None:
        result = to_miro_canvas({"nodes": [], "edges": []})
        self.assertNotIn("miroSource", result)
        self.assertEqual(result["miroCanvas"], {"schemaVersion": 1})


class FixtureTransformTests(unittest.TestCase):
    """The transforms over real converter output, across boards with text
    formatting, frames, images, connectors, and a presentation deck."""

    def test_native_canvas_has_no_html_and_only_spec_fields(self) -> None:
        for fixture_name in FIXTURE_NAMES:
            with self.subTest(fixture=fixture_name):
                board = _advanced_canvas_board(fixture_name)
                result = to_native_canvas(board)

                self.assertEqual(set(result.keys()), {"nodes", "edges"})
                for node in result["nodes"]:
                    self.assertLessEqual(set(node.keys()), _ALLOWED_NODE_FIELDS)
                    text = node.get("text")
                    if isinstance(text, str):
                        self.assertIsNone(
                            _HTML_TAG_RE.search(text),
                            f"{fixture_name}/{node['id']} still has HTML: {text!r}",
                        )
                for edge in result["edges"]:
                    self.assertLessEqual(set(edge.keys()), _ALLOWED_EDGE_FIELDS)

                issues = validate_board(result)
                self.assertEqual(issues, [], f"{fixture_name}: {issues}")

    def test_miro_canvas_keeps_miro_source_and_validates(self) -> None:
        for fixture_name in FIXTURE_NAMES:
            with self.subTest(fixture=fixture_name):
                board = _advanced_canvas_board(fixture_name)
                result = to_miro_canvas(board)

                self.assertEqual(result["miroSource"], board["miroSource"])
                self.assertEqual(result["miroCanvas"], {"schemaVersion": 1})
                for node in result["nodes"]:
                    self.assertLessEqual(set(node.keys()), _ALLOWED_NODE_FIELDS)
                    text = node.get("text")
                    if isinstance(text, str):
                        self.assertIsNone(_HTML_TAG_RE.search(text))

                issues = validate_board(result)
                self.assertEqual(issues, [], f"{fixture_name}: {issues}")

    def test_native_canvas_converts_bold_and_lists_to_markdown(self) -> None:
        board = _advanced_canvas_board("text_text_vertical_clearance")
        result = to_native_canvas(board)
        by_id = {node["id"]: node for node in result["nodes"]}

        self.assertIn("**Tom DeMarco. Deadline.**", by_id["deadline-heading"]["text"])
        notes_text = by_id["deadline-notes"]["text"]
        self.assertIn("**Hard deadline**", notes_text)
        self.assertIn("- ", notes_text)

    def test_native_canvas_converts_a_link_to_markdown(self) -> None:
        board = _advanced_canvas_board("labeled_anchor_text_not_link_card")
        result = to_native_canvas(board)

        self.assertEqual(
            result["nodes"][0]["text"],
            "[TAM / SAM / SOM Canvas](https://example.invalid/tam-sam-som)",
        )

    def test_does_not_mutate_real_converter_output(self) -> None:
        board = _advanced_canvas_board("slide_connector_across_deck_frames")
        before = copy.deepcopy(board)
        to_native_canvas(board)
        to_miro_canvas(board)
        self.assertEqual(board, before)


if __name__ == "__main__":
    unittest.main()
