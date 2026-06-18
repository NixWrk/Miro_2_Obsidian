from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from audit_item_node_mapping import audit_mapping_issues, summarize_mapping  # noqa: E402


class ItemNodeMappingAuditTests(unittest.TestCase):
    def test_reports_connector_endpoint_mismatch_and_missing_endpoint_node(self) -> None:
        miro = [
            {"id": "a", "type": "text", "geometry": {"width": 100, "height": 50}, "position": {"x": 0, "y": 0}},
            {"id": "b", "type": "text", "geometry": {"width": 100, "height": 50}, "position": {"x": 200, "y": 0}},
            {"id": "c", "type": "text", "geometry": {"width": 100, "height": 50}, "position": {"x": 400, "y": 0}},
            {"id": "e1", "type": "connector", "startItem": {"id": "a"}, "endItem": {"id": "b"}},
        ]
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
                {"id": "b", "type": "text", "x": 200, "y": 0, "width": 100, "height": 50},
            ],
            "edges": [{"id": "e1", "fromNode": "a", "toNode": "c"}],
        }

        reasons = {issue.reason for issue in audit_mapping_issues(miro, canvas)}

        self.assertIn("connector_endpoint_mismatch", reasons)
        self.assertIn("connector_endpoint_missing_canvas_node", reasons)

    def test_reports_wrong_canvas_kind_and_node_type(self) -> None:
        miro = [
            {"id": "img-1", "type": "image", "geometry": {"width": 100, "height": 50}, "position": {"x": 0, "y": 0}},
            {"id": "shape-1", "type": "shape", "geometry": {"width": 100, "height": 50}, "position": {"x": 0, "y": 0}},
        ]
        canvas = {
            "nodes": [{"id": "img-1", "type": "text", "x": 0, "y": 0, "width": 100, "height": 50}],
            "edges": [{"id": "shape-1", "fromNode": "img-1", "toNode": "missing"}],
        }

        reasons = {issue.reason for issue in audit_mapping_issues(miro, canvas)}

        self.assertIn("node_type_mismatch", reasons)
        self.assertIn("item_represented_as_edge", reasons)

    def test_ignores_known_generated_edge_ids(self) -> None:
        miro = [
            {"id": "a", "type": "mindmap_node", "geometry": {"width": 100, "height": 50}, "position": {"x": 0, "y": 0}},
            {"id": "b", "type": "mindmap_node", "geometry": {"width": 100, "height": 50}, "position": {"x": 200, "y": 0}},
        ]
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
                {"id": "b", "type": "text", "x": 200, "y": 0, "width": 100, "height": 50},
            ],
            "edges": [{"id": "mindmap-a-b", "fromNode": "a", "toNode": "b"}],
        }

        summary = summarize_mapping(miro, canvas)

        self.assertEqual(summary["total"], 0)

    def test_reports_node_position_drift_when_canvas_center_moves_from_source(self) -> None:
        miro = [
            {
                "id": "shape-1",
                "type": "shape",
                "geometry": {"width": 100, "height": 50},
                "position": {"x": 0, "y": 0, "origin": "center", "relativeTo": "canvas_center"},
            },
            {
                "id": "shape-2",
                "type": "shape",
                "geometry": {"width": 100, "height": 50},
                "position": {"x": 200, "y": 0, "origin": "center", "relativeTo": "canvas_center"},
            }
        ]
        canvas = {
            "nodes": [
                {"id": "shape-1", "type": "text", "x": -50, "y": -25, "width": 100, "height": 50},
                {"id": "shape-2", "type": "text", "x": -50, "y": -25, "width": 100, "height": 50},
            ],
            "edges": [],
        }

        reasons = {issue.reason for issue in audit_mapping_issues(miro, canvas, scale=1)}

        self.assertIn("node_position_drift", reasons)

    def test_allows_canvas_size_change_when_top_left_anchor_is_preserved(self) -> None:
        miro = [
            {
                "id": "embed-1",
                "type": "embed",
                "geometry": {"width": 200, "height": 200},
                "position": {"x": 0, "y": 0, "origin": "center", "relativeTo": "canvas_center"},
            }
        ]
        canvas = {
            "nodes": [{"id": "embed-1", "type": "link", "x": -100, "y": -100, "width": 200, "height": 112.5}],
            "edges": [],
        }

        summary = summarize_mapping(miro, canvas, scale=1)

        self.assertEqual(summary["total"], 0)

    def test_marks_position_drift_from_repaired_source_overlap_as_non_actionable(self) -> None:
        miro = [
            {
                "id": "a",
                "type": "text",
                "geometry": {"width": 100, "height": 100},
                "position": {"x": 0, "y": 0, "origin": "center", "relativeTo": "canvas_center"},
            },
            {
                "id": "b",
                "type": "text",
                "geometry": {"width": 100, "height": 100},
                "position": {"x": 0, "y": 40, "origin": "center", "relativeTo": "canvas_center"},
            },
            {
                "id": "anchor",
                "type": "text",
                "geometry": {"width": 100, "height": 100},
                "position": {"x": 300, "y": 300, "origin": "center", "relativeTo": "canvas_center"},
            },
        ]
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": -50, "y": -50, "width": 100, "height": 100},
                {"id": "b", "type": "text", "x": -50, "y": 66, "width": 100, "height": 100},
                {"id": "anchor", "type": "text", "x": 250, "y": 250, "width": 100, "height": 100},
            ],
            "edges": [],
        }

        summary = summarize_mapping(miro, canvas, scale=1)

        self.assertEqual(summary["actionable"], 0)
        self.assertEqual(summary["by_reason"], {"node_layout_repaired_source_overlap": 1})


if __name__ == "__main__":
    unittest.main()
