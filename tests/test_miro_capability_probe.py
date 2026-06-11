from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_capability_probe import build_coverage_rows, render_markdown_report, summarize_items  # noqa: E402


class MiroCapabilityProbeTests(unittest.TestCase):
    def test_summarizes_geometry_and_content(self) -> None:
        root = [
            {
                "id": "text-1",
                "type": "text",
                "position": {"x": 10, "y": 20},
                "geometry": {"width": 100, "height": 40},
                "data": {"content": "<p>Hello</p>"},
            },
            {"id": "format-1", "type": "data_table_format", "position": {"x": 1, "y": 2}},
        ]

        summary = summarize_items(root)

        self.assertEqual(summary["text"].count, 1)
        self.assertEqual(summary["text"].with_geometry, 1)
        self.assertEqual(summary["text"].with_content, 1)
        self.assertEqual(summary["data_table_format"].with_geometry, 0)

    def test_marks_websdk_only_items_as_export_candidates(self) -> None:
        rest_root = [{"id": "text-1", "type": "text"}]
        websdk_root = [{"id": "tag-1", "type": "tag", "x": 0, "y": 0, "width": 80, "height": 24, "title": "urgent"}]

        rows = {row.item_type: row for row in build_coverage_rows(rest_root, websdk_root)}

        self.assertEqual(rows["tag"].coverage, "websdk_only")
        self.assertEqual(rows["tag"].action, "websdk_export_candidate")

    def test_text_with_position_and_width_is_placeable_when_height_is_missing(self) -> None:
        root = [
            {
                "id": "text-1",
                "type": "text",
                "position": {"x": 10, "y": 20},
                "geometry": {"width": 100},
                "data": {"content": "<p>Hello</p>"},
            }
        ]

        summary = summarize_items(root)

        self.assertEqual(summary["text"].with_geometry, 1)

    def test_summarizes_keyed_rest_probe_items(self) -> None:
        root = {
            "items": {
                "text_probe": {
                    "id": "text-1",
                    "type": "text",
                    "position": {"x": 10, "y": 20},
                    "geometry": {"width": 100},
                    "data": {"content": "<p>Hello</p>"},
                }
            }
        }

        summary = summarize_items(root)

        self.assertEqual(summary["text"].count, 1)
        self.assertEqual(summary["text"].with_geometry, 1)
        self.assertEqual(summary["text"].with_content, 1)

    def test_marks_observed_dropped_rest_items_as_source_limited_when_no_geometry_or_content(self) -> None:
        rest_root = [{"id": "format-1", "type": "data_table_format", "position": {"x": 1, "y": 2}}]

        rows = {row.item_type: row for row in build_coverage_rows(rest_root, [])}

        self.assertEqual(rows["data_table_format"].coverage, "rest_only")
        self.assertEqual(rows["data_table_format"].action, "intentional_or_source_limited")

    def test_board_metadata_is_not_a_converter_candidate(self) -> None:
        rest_root = [{"id": "board-1", "type": "board", "name": "Probe board"}]

        rows = {row.item_type: row for row in build_coverage_rows(rest_root, [])}

        self.assertEqual(rows["board"].coverage, "rest_only")
        self.assertEqual(rows["board"].action, "metadata")

    def test_mindmap_node_is_generated_probe_candidate(self) -> None:
        rows = {row.item_type: row for row in build_coverage_rows([], [])}

        self.assertEqual(rows["mindmap_node"].coverage, "not_seen")
        self.assertEqual(rows["mindmap_node"].action, "generated_probe_candidate")

    def test_mindmap_node_content_is_read_from_node_view(self) -> None:
        summary = summarize_items(
            [
                {
                    "id": "mind-1",
                    "type": "mindmap_node",
                    "x": 10,
                    "y": 20,
                    "width": 180,
                    "height": 60,
                    "nodeView": {"content": "<p>Root</p>"},
                }
            ]
        )

        self.assertEqual(summary["mindmap_node"].with_geometry, 1)
        self.assertEqual(summary["mindmap_node"].with_content, 1)

    def test_observed_mindmap_node_is_covered_after_fixture_rule(self) -> None:
        rest_root = [
            {
                "id": "mind-1",
                "type": "mindmap_node",
                "position": {"x": 10, "y": 20},
                "geometry": {"width": 180, "height": 60},
                "data": {
                    "nodeView": {
                        "data": {"content": "<p>Root</p>"},
                    },
                },
            }
        ]

        rows = {row.item_type: row for row in build_coverage_rows(rest_root, [])}

        self.assertEqual(rows["mindmap_node"].coverage, "rest_only")
        self.assertEqual(rows["mindmap_node"].action, "covered_or_audit_needed")

    def test_report_contains_actionable_candidate_rows(self) -> None:
        rows = build_coverage_rows([], [{"id": "tag-1", "type": "tag", "x": 0, "y": 0, "width": 80, "height": 24}])

        report = render_markdown_report(rows)

        self.assertIn("`tag`", report)
        self.assertIn("websdk_export_candidate", report)


if __name__ == "__main__":
    unittest.main()
