from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from merge_miro_sources import WEBSDK_CAPTURE_PROFILE, WEBSDK_EXPORTER_VERSION  # noqa: E402
from miro_source_expansion_workflow import (  # noqa: E402
    build_workflow_plan,
    render_next_actions,
    run_analysis,
    validate_output_target,
    write_workflow_plan,
)
from miro_capability_probe import build_coverage_rows  # noqa: E402


class MiroSourceExpansionWorkflowTests(unittest.TestCase):
    def test_plan_contains_ordered_commands_without_secret_value(self) -> None:
        plan = build_workflow_plan(
            Path("probe_run"), board_id="board-1", websdk_port=8766
        )

        self.assertIn("miro_rest_generate_probe_board.py --output", plan)
        self.assertIn("MIRO_ACCESS_TOKEN", plan)
        self.assertIn("Yandex Browser", plan)
        self.assertIn("http://localhost:8765/callback", plan)
        self.assertIn("Use this URI for SDK authorization", plan)
        self.assertIn("partial API failures", plan)
        self.assertIn("cannot create more boards", plan)
        self.assertIn("--board-id", plan)
        self.assertIn("--board-id board-1", plan)
        self.assertIn("http://localhost:8766/index.html", plan)
        self.assertIn("serve_no_cache.py --port 8766", plan)
        self.assertIn("exporter_version", plan)
        self.assertIn("same Miro team as the target board", plan)
        self.assertIn("If several `export to Json` apps exist", plan)
        self.assertIn("Profile settings", plan)
        self.assertIn("+ More apps", plan)
        self.assertIn("+ More tools", plan)
        self.assertIn("app-visible team", plan)
        self.assertIn("same board", plan)
        self.assertIn("left-hand app toolbar", plan)
        self.assertIn("Create probe items", plan)
        self.assertIn("miro_slide_probe.py", plan)
        self.assertIn("slide_probe_result.json", plan)
        self.assertIn("miro_source_expansion_workflow.py analyze", plan)
        self.assertNotIn("Bearer ", plan)

    def test_write_plan_uses_default_websdk_port_and_ownership_marker(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_workflow_plan_") as tmp:
            output_dir = Path(tmp) / "out"
            plan_path = write_workflow_plan(output_dir)
            plan = plan_path.read_text(encoding="utf-8")

            self.assertIn("serve_no_cache.py --port 8766", plan)
            self.assertTrue((output_dir / ".miro-source-expansion").is_file())

    def test_output_validation_rejects_file_and_invalid_sentinel(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_workflow_guard_") as tmp:
            root = Path(tmp)
            file_output = root / "file-output"
            file_output.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "not a regular directory"):
                validate_output_target(file_output)

            owned = root / "owned"
            owned.mkdir()
            (owned / ".miro-source-expansion").write_text(
                "wrong-owner\n",
                encoding="utf-8",
            )
            marker = owned / "keep.txt"
            marker.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "sentinel is invalid"):
                validate_output_target(owned)
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_next_actions_reports_websdk_only_candidates(self) -> None:
        rows = build_coverage_rows(
            [],
            {
                "items": [
                    {
                        "id": "tag-1",
                        "type": "tag",
                        "x": 1,
                        "y": 2,
                        "width": 80,
                        "height": 24,
                    }
                ]
            },
        )

        report = render_next_actions(rows)

        self.assertIn("`tag`", report)
        self.assertIn("websdk_export_candidate", report)

    def test_next_actions_reports_generated_probe_candidates(self) -> None:
        rows = build_coverage_rows([], [])

        report = render_next_actions(rows)

        self.assertIn("`embed`", report)
        self.assertIn("generated_probe_candidate", report)

    def test_next_actions_reports_source_limited_manual_fixture_candidates(
        self,
    ) -> None:
        rows = build_coverage_rows([], [])

        report = render_next_actions(rows)

        self.assertIn("`kanban`", report)
        self.assertIn("source_limited", report)

    def test_analyze_writes_report_and_merged_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rest_json = tmp_path / "rest.json"
            websdk_json = tmp_path / "websdk.json"
            output_dir = tmp_path / "out"

            rest_json.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "source_surface": "rest",
                        "export_scope": "board",
                        "exporter_version": "test",
                        "exported_at": datetime.now(timezone.utc).isoformat(),
                        "board": {"id": "board-1"},
                        "items": [
                            {
                                "id": "text-1",
                                "type": "text",
                                "data": {"content": "<p>REST</p>"},
                            },
                            {
                                "id": "image-1",
                                "type": "image",
                                "local_name": "asset.png",
                                "data": {"imageUrl": "https://example.test/asset.png"},
                            },
                        ],
                        "comments": [],
                        "provenance": {
                            "board_id": "board-1",
                            "items": {
                                "complete": True,
                                "raw_count": 2,
                                "item_count": 2,
                                "sources": {"unknown": 2},
                            },
                            "comments": {
                                "complete": True,
                                "raw_count": 0,
                                "comment_count": 0,
                            },
                            "assets": {"strategy": "test"},
                        },
                        "completeness": {
                            "complete": True,
                            "capture_complete": True,
                            "board_complete": False,
                            "coverage_basis": "miro.board.get_api_surface",
                            "known_limitations": [
                                "unsupported_item_details_unavailable",
                                "unsupported_parent_children_not_enumerated",
                                "comment_content_unavailable",
                            ],
                            "items": {"complete": True},
                            "comments": {"complete": True},
                            "assets": {
                                "complete": True,
                                "checked": True,
                                "missing": [],
                                "optional_missing": [],
                                "requirements": {
                                    "images": 1,
                                    "documents": 0,
                                    "doc_formats": 0,
                                    "embeds": 0,
                                    "failed": 0,
                                    "optional_failed": 0,
                                },
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            rest_sidecar = rest_json.with_name("rest_files")
            rest_sidecar.mkdir()
            (rest_sidecar / "asset.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            websdk_json.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "source_surface": "web_sdk",
                        "export_scope": "board",
                        "exporter_version": WEBSDK_EXPORTER_VERSION,
                        "capture_profile": WEBSDK_CAPTURE_PROFILE,
                        "exported_at": datetime.now(timezone.utc).isoformat(),
                        "board": {"id": "board-1"},
                        "items": [
                            {
                                "id": "tag-1",
                                "type": "tag",
                                "x": 1,
                                "y": 2,
                                "width": 80,
                                "height": 24,
                            }
                        ],
                        "provenance": {
                            "items": {
                                "method": "miro.board.get",
                                "scope": "api_exposed_board_items",
                                "raw_count": 1,
                                "serialized_count": 1,
                            },
                            "serialization": {"issue_count": 0, "issues": []},
                        },
                        "completeness": {
                            "complete": True,
                            "capture_complete": True,
                            "board_complete": False,
                            "coverage_basis": "miro.board.get_api_surface",
                            "known_limitations": [
                                "unsupported_item_details_unavailable",
                                "unsupported_parent_children_not_enumerated",
                                "comment_content_unavailable",
                            ],
                            "items": {
                                "complete": True,
                                "raw_count": 1,
                                "serialized_count": 1,
                                "serialization_errors": [],
                            },
                            "serialization": {"complete": True, "issues": []},
                        },
                        "summary": {"total": 1, "by_type": {"tag": 1}},
                    }
                ),
                encoding="utf-8",
            )

            artifacts = run_analysis(rest_json, websdk_json, output_dir)

            self.assertTrue(artifacts["capability_report_md"].exists())
            self.assertTrue(artifacts["next_actions"].exists())
            merged = json.loads(artifacts["merged_json"].read_text(encoding="utf-8"))
            self.assertEqual(
                {item["id"] for item in merged["items"]}, {"text-1", "image-1", "tag-1"}
            )
            self.assertTrue(
                (
                    artifacts["merged_json"].with_name("merged.miro_files")
                    / "asset.png"
                ).is_file()
            )
            self.assertTrue(merged["completeness"]["complete"])
            self.assertTrue(merged["completeness"]["capture_complete"])
            self.assertTrue(merged["completeness"]["assets"]["checked"])

    def test_failed_analysis_preserves_previous_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rest_json = root / "rest.json"
            websdk_json = root / "broken-websdk.json"
            output_dir = root / "out"
            output_dir.mkdir()
            (output_dir / ".miro-source-expansion").write_text(
                "miro-source-expansion-v1\n",
                encoding="utf-8",
            )
            (output_dir / "merged.miro.json").write_text(
                "old-generation", encoding="utf-8"
            )
            rest_json.write_text("{}", encoding="utf-8")
            websdk_json.write_text("{}", encoding="utf-8")

            with self.assertRaises(ValueError):
                run_analysis(rest_json, websdk_json, output_dir)

            self.assertEqual(
                (output_dir / "merged.miro.json").read_text(encoding="utf-8"),
                "old-generation",
            )
            self.assertFalse((output_dir / "capability_report.md").exists())


if __name__ == "__main__":
    unittest.main()
