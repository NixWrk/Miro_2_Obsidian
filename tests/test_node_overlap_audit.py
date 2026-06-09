from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from audit_node_overlaps import audit_nodes  # noqa: E402


class NodeOverlapAuditTests(unittest.TestCase):
    def test_detects_content_node_overlap(self) -> None:
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": 0, "y": 0, "width": 100, "height": 100},
                {"id": "b", "type": "file", "x": 75, "y": 60, "width": 100, "height": 100},
            ],
            "edges": [],
        }

        overlaps = audit_nodes(canvas)

        self.assertEqual(len(overlaps), 1)
        self.assertEqual(overlaps[0].left.node_id, "a")
        self.assertEqual(overlaps[0].right.node_id, "b")
        self.assertEqual(overlaps[0].width, 25)
        self.assertEqual(overlaps[0].height, 40)

    def test_ignores_group_nodes_by_default(self) -> None:
        canvas = {
            "nodes": [
                {"id": "group", "type": "group", "x": 0, "y": 0, "width": 300, "height": 300},
                {"id": "text", "type": "text", "x": 10, "y": 10, "width": 100, "height": 100},
            ],
            "edges": [],
        }

        self.assertEqual(audit_nodes(canvas), [])

    def test_thresholds_filter_small_overlaps(self) -> None:
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": 0, "y": 0, "width": 100, "height": 100},
                {"id": "b", "type": "text", "x": 99.5, "y": 99.5, "width": 100, "height": 100},
            ],
            "edges": [],
        }

        overlaps = audit_nodes(canvas, min_overlap_width=1.0, min_overlap_height=1.0)

        self.assertEqual(overlaps, [])

    def test_can_exclude_intentional_overlay_node(self) -> None:
        canvas = {
            "nodes": [
                {"id": "a", "type": "text", "x": 0, "y": 0, "width": 100, "height": 100},
                {"id": "b", "type": "text", "x": 50, "y": 50, "width": 100, "height": 100},
            ],
            "edges": [],
        }

        self.assertEqual(audit_nodes(canvas, exclude_node_ids=["b"]), [])


if __name__ == "__main__":
    unittest.main()
