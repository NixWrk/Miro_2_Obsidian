from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_source_expansion_workflow import build_workflow_plan, render_next_actions, run_analysis  # noqa: E402
from miro_capability_probe import build_coverage_rows  # noqa: E402


class MiroSourceExpansionWorkflowTests(unittest.TestCase):
    def test_plan_contains_ordered_commands_without_secret_value(self) -> None:
        plan = build_workflow_plan(Path("probe_run"), board_id="board-1")

        self.assertIn("miro_rest_probe_board.py --output", plan)
        self.assertIn("MIRO_ACCESS_TOKEN", plan)
        self.assertIn("--board-id board-1", plan)
        self.assertIn("miro_source_expansion_workflow.py analyze", plan)
        self.assertNotIn("Bearer ", plan)

    def test_next_actions_reports_websdk_only_candidates(self) -> None:
        rows = build_coverage_rows([], {"items": [{"id": "tag-1", "type": "tag", "x": 1, "y": 2, "width": 80, "height": 24}]})

        report = render_next_actions(rows)

        self.assertIn("`tag`", report)
        self.assertIn("websdk_export_candidate", report)

    def test_analyze_writes_report_and_merged_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rest_json = tmp_path / "rest.json"
            websdk_json = tmp_path / "websdk.json"
            output_dir = tmp_path / "out"

            rest_json.write_text(
                json.dumps([{"id": "text-1", "type": "text", "data": {"content": "<p>REST</p>"}}]),
                encoding="utf-8",
            )
            websdk_json.write_text(
                json.dumps({"items": [{"id": "tag-1", "type": "tag", "x": 1, "y": 2, "width": 80, "height": 24}]}),
                encoding="utf-8",
            )

            artifacts = run_analysis(rest_json, websdk_json, output_dir)

            self.assertTrue(artifacts["capability_report_md"].exists())
            self.assertTrue(artifacts["next_actions"].exists())
            merged = json.loads(artifacts["merged_json"].read_text(encoding="utf-8"))
            self.assertEqual({item["id"] for item in merged}, {"text-1", "tag-1"})


if __name__ == "__main__":
    unittest.main()
