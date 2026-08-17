from __future__ import annotations

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.audit_item_node_mapping import audit_mapping_issues, summarize_mapping  # noqa: E402


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

    def test_reports_missing_expected_node_and_edge(self) -> None:
        miro = [
            {"id": "a", "type": "text", "geometry": {"width": 100, "height": 50}, "position": {"x": 0, "y": 0}},
            {"id": "b", "type": "text", "geometry": {"width": 100, "height": 50}, "position": {"x": 200, "y": 0}},
            {"id": "shape-1", "type": "shape", "geometry": {"width": 100, "height": 50}, "position": {"x": 400, "y": 0}},
            {"id": "edge-1", "type": "connector", "startItem": {"id": "a"}, "endItem": {"id": "b"}},
        ]
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
                {"id": "b", "type": "text", "x": 200, "y": 0, "width": 100, "height": 50},
            ],
            "edges": [],
        }

        reasons = {issue.reason for issue in audit_mapping_issues(miro, canvas)}

        self.assertIn("missing_expected_canvas_node", reasons)
        self.assertIn("missing_expected_canvas_edge", reasons)

    def test_accepts_recoverable_source_limited_placeholder(self) -> None:
        miro = [{
            "id": "table-1",
            "type": "table",
            "geometry": {"width": 320, "height": 180},
            "position": {"x": 0, "y": 0},
            "links": {"web": "https://miro.test/table-1"},
        }]
        canvas = {
            "nodes": [{"id": "table-1", "type": "text", "x": -160, "y": -90, "width": 320, "height": 180}],
            "edges": [],
        }

        self.assertEqual(summarize_mapping(miro, canvas)["total"], 0)

    def test_reports_bare_comment_missing_from_canvas(self) -> None:
        issues = audit_mapping_issues(
            [{"id": "comment-1", "type": "comment"}],
            {"nodes": [], "edges": []},
        )

        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].reason, "missing_expected_canvas_node")
        self.assertTrue(issues[0].actionable)

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

    def test_ignores_generated_source_incomplete_diagnostic(self) -> None:
        miro = {
            "items": [],
            "comments": [],
            "completeness": {"complete": False},
        }
        canvas = {
            "nodes": [{
                "id": "miro-source-incomplete",
                "type": "text",
                "x": 0,
                "y": 0,
                "width": 400,
                "height": 200,
            }],
            "edges": [],
        }

        self.assertEqual(summarize_mapping(miro, canvas)["total"], 0)

    def test_required_local_asset_cannot_be_counted_as_text_placeholder(self) -> None:
        miro = [{
            "id": "image-1",
            "type": "image",
            "local_name": "asset.png",
            "data": {"imageUrl": "https://example.test/asset.png"},
            "geometry": {"width": 100, "height": 50},
        }]
        canvas = {
            "nodes": [{"id": "image-1", "type": "text", "x": 0, "y": 0, "width": 100, "height": 50}],
            "edges": [],
        }

        summary = summarize_mapping(miro, canvas)

        self.assertEqual(summary["actionable"], 1)
        self.assertEqual(summary["by_reason"], {"node_type_mismatch": 1})

    def test_accepts_recoverable_document_text_placeholder(self) -> None:
        miro = [{
            "id": "doc-1",
            "type": "document",
            "data": {"title": "Unavailable document"},
            "geometry": {"width": 200, "height": 100},
        }]
        canvas = {
            "nodes": [{"id": "doc-1", "type": "text", "x": 0, "y": 0, "width": 200, "height": 100}],
            "edges": [],
        }

        self.assertEqual(summarize_mapping(miro, canvas)["total"], 0)

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

    def test_repaired_source_overlap_ignores_empty_decorative_canvas_overlap(self) -> None:
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
                "id": "decor",
                "type": "shape",
                "data": {"content": ""},
                "geometry": {"width": 400, "height": 400},
                "position": {"x": 0, "y": 132, "origin": "center", "relativeTo": "canvas_center"},
            },
        ]
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": -50, "y": -50, "width": 100, "height": 100},
                {"id": "b", "type": "text", "x": -50, "y": 66, "width": 100, "height": 100},
                {
                    "id": "decor",
                    "type": "text",
                    "x": -200,
                    "y": -68,
                    "width": 400,
                    "height": 400,
                    "text": '<span style="font-size:12px"></span>',
                    "styleAttributes": {"shape": "round-rectangle"},
                },
            ],
            "edges": [],
        }

        summary = summarize_mapping(miro, canvas, scale=1)

        self.assertEqual(summary["actionable"], 0)
        self.assertEqual(summary["by_reason"], {"node_layout_repaired_source_overlap": 1})


if __name__ == "__main__":
    unittest.main()
