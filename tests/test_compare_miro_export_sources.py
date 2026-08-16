from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from audit_web_board_pipeline import BoardRef  # noqa: E402
from compare_miro_export_sources import (  # noqa: E402
    DEFAULT_BOARD_LIST,
    LEGACY_EXP,
    MERGED_REST_EXP_WEBSDK,
    REST_EXP,
    REST_EXP_NO_ASSETS,
    WEBSDK,
    SourceResult,
    build_production_source_result,
    choose_best_records,
    expand_source_keys,
    find_websdk_export,
    main as comparison_main,
    materialize_source,
    preflight_report,
    production_ineligibility_reasons,
    refresh_board_list,
    render_recommendations,
    reset_outputs,
    resolve_runtime_token,
    source_keys_require_token,
)
from merge_miro_sources import WEBSDK_CAPTURE_PROFILE, WEBSDK_EXPORTER_VERSION  # noqa: E402


def websdk_export(board_id: str, items: list[dict]) -> dict:
    by_type: dict[str, int] = {}
    for item in items:
        item_type = str(item["type"])
        by_type[item_type] = by_type.get(item_type, 0) + 1
    return {
        "schema_version": 1,
        "source_surface": "web_sdk",
        "export_scope": "board",
        "exporter_version": WEBSDK_EXPORTER_VERSION,
        "capture_profile": WEBSDK_CAPTURE_PROFILE,
        "provenance": {
            "items": {
                "method": "miro.board.get",
                "scope": "api_exposed_board_items",
                "raw_count": len(items),
                "serialized_count": len(items),
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
                "raw_count": len(items),
                "serialized_count": len(items),
                "serialization_errors": [],
            },
            "serialization": {"complete": True, "issues": []},
        },
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "board": {"id": board_id},
        "items": items,
        "summary": {"total": len(items), "by_type": by_type},
    }


def union_complete() -> dict[str, int]:
    return {
        "missing_item_ids": 0,
        "missing_fields": 0,
        "missing_content_items": 0,
        "missing_geometry_items": 0,
        "missing_asset_items": 0,
        "missing_comment_ids": 0,
        "missing_comment_fields": 0,
    }


def rest_export(
    board_id: str, items: list[dict], comments: list[dict] | None = None
) -> dict:
    source_counts: dict[str, int] = {}
    for item in items:
        source = str(item.get("source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1
    comment_items = comments or []
    requirements = {
        "images": sum(item.get("type") == "image" for item in items),
        "documents": sum(item.get("type") == "document" for item in items),
        "doc_formats": sum(
            item.get("type") == "doc_format"
            and bool((item.get("data") or {}).get("html"))
            for item in items
        ),
        "embeds": sum(
            item.get("type") == "embed"
            and bool((item.get("data") or {}).get("previewUrl"))
            for item in items
        ),
        "failed": 0,
        "optional_failed": 0,
    }
    return {
        "schema_version": 1,
        "source_surface": "rest",
        "export_scope": "board",
        "exporter_version": "test",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "board": {"id": board_id},
        "items": items,
        "comments": comment_items,
        "provenance": {
            "board_id": board_id,
            "items": {
                "complete": True,
                "raw_count": len(items),
                "item_count": len(items),
                "sources": dict(sorted(source_counts.items())),
            },
            "comments": {
                "complete": True,
                "raw_count": len(comment_items),
                "comment_count": len(comment_items),
            },
            "assets": {"strategy": "test"},
        },
        "completeness": {
            "complete": True,
            "capture_complete": True,
            "board_complete": False,
            "coverage_basis": "rest_api_surface",
            "known_limitations": [],
            "items": {"complete": True},
            "comments": {"complete": True},
            "assets": {
                "complete": True,
                "checked": True,
                "missing": [],
                "optional_missing": [],
                "requirements": requirements,
            },
        },
    }


class CompareMiroExportSourcesTests(unittest.TestCase):
    def test_default_board_list_uses_curated_web_boards(self) -> None:
        self.assertEqual(DEFAULT_BOARD_LIST.name, "Web_boards.md")
        self.assertIn("Obs_Miro", str(DEFAULT_BOARD_LIST))
        self.assertIn("Концепт", str(DEFAULT_BOARD_LIST))

    def test_expand_source_keys_adds_merge_dependencies_once(self) -> None:
        self.assertEqual(
            expand_source_keys(MERGED_REST_EXP_WEBSDK),
            [REST_EXP, WEBSDK, MERGED_REST_EXP_WEBSDK],
        )
        expanded = expand_source_keys(f"{REST_EXP},{MERGED_REST_EXP_WEBSDK}")
        self.assertEqual(expanded, [REST_EXP, WEBSDK, MERGED_REST_EXP_WEBSDK])

    def test_find_websdk_export_matches_board_metadata(self) -> None:
        board = BoardRef(
            board_id="uXjVWebSdk=",
            label="Web SDK",
            url="https://miro.com/app/board/uXjVWebSdk=/",
        )

        with tempfile.TemporaryDirectory(prefix="miro2obs_websdk_find_") as tmp:
            root = Path(tmp)
            path = root / "manual-export.json"
            path.write_text(
                json.dumps(websdk_export("uXjVWebSdk=", [])),
                encoding="utf-8",
            )

            self.assertEqual(find_websdk_export(board, root), path)

    def test_find_websdk_export_reports_rejected_candidates(self) -> None:
        board = BoardRef(
            board_id="uXjVWebSdk=",
            label="Web SDK",
            url="https://miro.com/app/board/uXjVWebSdk=/",
        )
        with tempfile.TemporaryDirectory(prefix="miro2obs_websdk_rejected_") as tmp:
            root = Path(tmp)
            invalid = root / "invalid.json"
            invalid.write_text("[]", encoding="utf-8")
            valid = root / "valid.json"
            valid.write_text(
                json.dumps(websdk_export(board.board_id, [])),
                encoding="utf-8",
            )
            rejected: list[dict[str, str]] = []

            selected = find_websdk_export(board, root, rejected=rejected)

        self.assertEqual(selected, valid)
        self.assertEqual(rejected[0]["path"], str(invalid))
        self.assertIn("JSON object", rejected[0]["reason"])

    def test_find_websdk_export_rejects_nonfinite_max_age(self) -> None:
        board = BoardRef(
            board_id="uXjVWebSdk=",
            label="Web SDK",
            url="https://miro.com/app/board/uXjVWebSdk=/",
        )
        with tempfile.TemporaryDirectory(prefix="miro2obs_websdk_age_") as tmp:
            with self.assertRaisesRegex(ValueError, "finite number"):
                find_websdk_export(board, Path(tmp), max_age_hours=float("nan"))

    def test_find_websdk_export_rejects_nonregular_root(self) -> None:
        board = BoardRef(
            board_id="uXjVWebSdk=",
            label="Web SDK",
            url="https://miro.com/app/board/uXjVWebSdk=/",
        )
        with tempfile.TemporaryDirectory(prefix="miro2obs_websdk_root_") as tmp:
            root = Path(tmp)
            with patch(
                "compare_miro_export_sources.require_regular_directory",
                side_effect=RuntimeError("not a regular directory"),
            ):
                with self.assertRaisesRegex(RuntimeError, "not a regular directory"):
                    find_websdk_export(board, root)

    def test_materialize_rest_no_assets_writes_canonical_source_without_download(
        self,
    ) -> None:
        board = BoardRef(
            board_id="uXjVRest=",
            label="REST",
            url="https://miro.com/app/board/uXjVRest=/",
        )
        items = [{"id": "text-1", "type": "text"}]
        comments = [{"id": "comment-1", "type": "comment"}]

        def complete_export(**kwargs):
            payload = rest_export(board.board_id, items, comments)
            output = Path(kwargs["output_path"])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(payload), encoding="utf-8")
            return payload, {
                "items": len(items),
                "comments": len(comments),
                "asset_stats": {
                    "images": 0,
                    "documents": 0,
                    "doc_formats": 0,
                    "embeds": 0,
                    "failed": 0,
                    "optional_failed": 0,
                },
                "log_tail": [],
                "prefer_experimental": kwargs["prefer_experimental"],
                "download_assets": kwargs["download_assets"],
                "complete": True,
                "degraded": False,
                "missing_assets": [],
                "completeness": payload["completeness"],
            }

        with tempfile.TemporaryDirectory(prefix="miro2obs_source_compare_") as tmp:
            out_dir = Path(tmp)
            with patch(
                "compare_miro_export_sources.export_complete_board_source",
                side_effect=complete_export,
            ) as export:
                result = materialize_source(
                    board,
                    REST_EXP_NO_ASSETS,
                    out_dir=out_dir,
                    token="token-1",
                    websdk_root=out_dir / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )

            payload = json.loads(Path(result.source_json).read_text(encoding="utf-8"))

        self.assertEqual(result.status, "exported")
        self.assertEqual(payload["items"], items)
        self.assertEqual(payload["comments"], comments)
        self.assertEqual(payload["source_surface"], "rest")
        self.assertEqual(payload["board"]["id"], board.board_id)
        self.assertTrue(export.call_args.kwargs["prefer_experimental"])
        self.assertFalse(export.call_args.kwargs["download_assets"])
        self.assertEqual(export.call_args.kwargs["board_name"], board.label)
        self.assertFalse(result.export_info["download_assets"])
        self.assertTrue(result.export_info["complete"])
        self.assertTrue(payload["provenance"]["items"]["complete"])
        self.assertTrue(payload["completeness"]["complete"])

    def test_materialize_merged_preserves_comments_and_downloads_websdk_assets(
        self,
    ) -> None:
        board = BoardRef(
            board_id="uXjVMerge=",
            label="Merge",
            url="https://miro.com/app/board/uXjVMerge=/",
        )

        with tempfile.TemporaryDirectory(prefix="miro2obs_source_merge_") as tmp:
            root = Path(tmp)
            rest_json = root / "rest.json"
            rest_json.write_text(
                json.dumps(
                    rest_export(
                        "uXjVMerge=",
                        [
                            {
                                "id": "text-1",
                                "type": "text",
                                "data": {"content": "<p>REST</p>"},
                                "local_name": "asset.png",
                            }
                        ],
                        [{"id": "comment-1", "type": "comment", "content": "Nice"}],
                    )
                ),
                encoding="utf-8",
            )
            rest_files = rest_json.with_name("rest_files")
            rest_files.mkdir()
            (rest_files / "asset.png").write_bytes(b"asset")

            websdk_json = root / "websdk.json"
            websdk_json.write_text(
                json.dumps(
                    websdk_export(
                        "uXjVMerge=",
                        [
                            {"id": "text-1", "type": "text", "content": "REST"},
                            {
                                "id": "mindmap-1",
                                "type": "mindmap_node",
                                "content": "Only Web SDK",
                                "x": 10,
                                "y": 20,
                                "width": 100,
                                "height": 40,
                            },
                            {
                                "id": "image-1",
                                "type": "image",
                                "url": "https://cdn.example.test/image.png",
                            },
                        ],
                    )
                ),
                encoding="utf-8",
            )
            exported = {
                REST_EXP: SourceResult(REST_EXP, rest_json, "exported", {}),
                WEBSDK: SourceResult(WEBSDK, websdk_json, "exported", {}),
            }

            def download_merged_assets(items, *, output_path, **_kwargs):
                image = next(item for item in items if item["id"] == "image-1")
                image["local_name"] = "websdk-image.png"
                asset_path = (
                    output_path.with_name(f"{output_path.stem}_files")
                    / image["local_name"]
                )
                asset_path.parent.mkdir(parents=True, exist_ok=True)
                asset_path.write_bytes(b"\x89PNG\r\n\x1a\n")
                return {
                    "images": 1,
                    "documents": 0,
                    "doc_formats": 0,
                    "embeds": 0,
                    "failed": 0,
                    "optional_failed": 0,
                }

            with patch(
                "compare_miro_export_sources.download_export_assets",
                side_effect=download_merged_assets,
            ) as asset_download:
                result = materialize_source(
                    board,
                    MERGED_REST_EXP_WEBSDK,
                    out_dir=root / "out",
                    token="token-1",
                    websdk_root=root / "unused",
                    allow_missing_assets=False,
                    exported=exported,
                )
            payload = json.loads(Path(result.source_json).read_text(encoding="utf-8"))
            sidecar = Path(result.source_json).with_name("board_files")
            sidecar_file_exists = (sidecar / "asset.png").is_file()
            websdk_asset_exists = (sidecar / "websdk-image.png").is_file()
            item_ids = {item["id"] for item in payload["items"]}

        comment = payload["comments"][0]
        self.assertEqual(comment["content"], "Nice")
        self.assertEqual(comment["source_surfaces"], ["rest"])
        self.assertEqual(
            comment["source_provenance"]["original_items"]["rest"]["id"], "comment-1"
        )
        self.assertEqual(item_ids, {"text-1", "mindmap-1", "image-1"})
        self.assertTrue(sidecar_file_exists)
        self.assertTrue(websdk_asset_exists)
        asset_download.assert_called_once()
        image = next(item for item in payload["items"] if item["id"] == "image-1")
        self.assertEqual(
            image["data"]["imageUrl"], "https://cdn.example.test/image.png"
        )
        self.assertEqual(image["local_name"], "websdk-image.png")

    def test_legacy_unicode_stdout_error_is_nonfatal_when_json_exists(self) -> None:
        board = BoardRef(
            board_id="uXjVLegacy=",
            label="Legacy",
            url="https://miro.com/app/board/uXjVLegacy=/",
        )

        def fake_run_download(**kwargs):
            save_base = kwargs["save_base"]
            safe_team = kwargs["safe_team"]
            safe_board = kwargs["safe_board"]
            output = save_base / f"{safe_team}_{safe_board}.json"
            output.write_text(
                json.dumps([{"id": "text-1", "type": "text"}]), encoding="utf-8"
            )
            raise UnicodeEncodeError("charmap", "💾", 0, 1, "boom")

        with tempfile.TemporaryDirectory(prefix="miro2obs_legacy_unicode_") as tmp:
            root = Path(tmp)
            with patch("download_worker.run_download", side_effect=fake_run_download):
                result = materialize_source(
                    board,
                    LEGACY_EXP,
                    out_dir=root,
                    token="token-1",
                    websdk_root=root / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )
            payload = json.loads(Path(result.source_json).read_text(encoding="utf-8"))

        self.assertEqual(result.status, "exported")
        self.assertEqual(payload, [{"id": "text-1", "type": "text"}])
        self.assertIn(
            "legacy_stdout_encoding_error_ignored", result.export_info["warning"]
        )

    def test_legacy_export_copies_only_referenced_assets(self) -> None:
        board = BoardRef(
            board_id="uXjVLegacyAssets=",
            label="Legacy assets",
            url="https://miro.com/app/board/uXjVLegacyAssets=/",
        )

        def fake_run_download(**kwargs):
            output = (
                kwargs["save_base"]
                / f"{kwargs['safe_team']}_{kwargs['safe_board']}.json"
            )
            output.write_text(
                json.dumps(
                    [
                        {
                            "id": "image-1",
                            "type": "image",
                            "local_name": "asset.png",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            sidecar = output.with_name(f"{output.stem}_files")
            sidecar.mkdir()
            (sidecar / "asset.png").write_bytes(b"asset")
            (sidecar / "unreferenced.bin").write_bytes(b"extra")

        with tempfile.TemporaryDirectory(prefix="miro2obs_legacy_assets_") as tmp:
            root = Path(tmp)
            with patch("download_worker.run_download", side_effect=fake_run_download):
                result = materialize_source(
                    board,
                    LEGACY_EXP,
                    out_dir=root,
                    token="token-1",
                    websdk_root=root / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )
            sidecar = Path(result.source_json).with_name("board_files")
            copied = (sidecar / "asset.png").read_bytes()
            extra_exists = (sidecar / "unreferenced.bin").exists()

        self.assertEqual(copied, b"asset")
        self.assertFalse(extra_exists)

    def test_failed_legacy_export_preserves_previous_bundle(self) -> None:
        board = BoardRef(
            board_id="uXjVLegacyKeep=",
            label="Legacy keep",
            url="https://miro.com/app/board/uXjVLegacyKeep=/",
        )

        def successful_download(**kwargs):
            output = (
                kwargs["save_base"]
                / f"{kwargs['safe_team']}_{kwargs['safe_board']}.json"
            )
            output.write_text(
                json.dumps([{"id": "old", "type": "text"}]),
                encoding="utf-8",
            )

        with tempfile.TemporaryDirectory(prefix="miro2obs_legacy_keep_") as tmp:
            root = Path(tmp)
            with patch("download_worker.run_download", side_effect=successful_download):
                first = materialize_source(
                    board,
                    LEGACY_EXP,
                    out_dir=root,
                    token="token-1",
                    websdk_root=root / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )
            output = Path(first.source_json)
            with patch(
                "download_worker.run_download",
                side_effect=RuntimeError("download failed"),
            ):
                second = materialize_source(
                    board,
                    LEGACY_EXP,
                    out_dir=root,
                    token="token-1",
                    websdk_root=root / "websdk",
                    allow_missing_assets=False,
                    exported={},
                )
            preserved = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(second.status, "export_failed")
        self.assertEqual(preserved, [{"id": "old", "type": "text"}])

    def test_recommendation_requires_merged_source_when_quality_ties(self) -> None:
        board = {
            "board_id": "uXjVRec=",
            "label": "Rec",
            "url": "https://miro.com/app/board/uXjVRec=/",
        }
        records = [
            {
                "board": board,
                "source_key": MERGED_REST_EXP_WEBSDK,
                "text_style_mode": "obsidian",
                "status": "ok",
                "missing_miro_items": {"actionable": 0},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_json": "merged.json",
                "source_assets": {"missing": 0},
                "export": {"complete": True},
                "completeness": union_complete(),
                "source": {"items": 2},
            },
            {
                "board": board,
                "source_key": REST_EXP,
                "text_style_mode": "obsidian",
                "status": "ok",
                "missing_miro_items": {"actionable": 0},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_json": "rest.json",
                "source_assets": {"missing": 0},
                "export": {"complete": True},
                "source": {"items": 1},
            },
        ]

        self.assertEqual(
            choose_best_records(records)[0]["source_key"], MERGED_REST_EXP_WEBSDK
        )

    def test_recommendation_has_no_rest_only_production_fallback(self) -> None:
        board = {
            "board_id": "uXjVRec=",
            "label": "Rec",
            "url": "https://miro.com/app/board/uXjVRec=/",
        }
        rest_record = {
            "board": board,
            "source_key": REST_EXP,
            "text_style_mode": "obsidian",
            "status": "ok",
            "missing_miro_items": {"actionable": 0},
            "mapping": {"actionable": 0},
            "overlaps": {"generated": 0},
            "canvas": {"missing_files": 0},
            "source_json": "rest.json",
            "source_assets": {"missing": 0},
            "export": {"complete": True},
            "source": {"items": 1},
        }

        self.assertEqual(choose_best_records([rest_record]), [])
        self.assertIn(
            "diagnostic_or_no_assets_source",
            production_ineligibility_reasons(rest_record),
        )

    def test_recommendation_chooses_merged_when_it_is_cleaner(self) -> None:
        board = {
            "board_id": "uXjVRec=",
            "label": "Rec",
            "url": "https://miro.com/app/board/uXjVRec=/",
        }
        records = [
            {
                "board": board,
                "source_key": REST_EXP,
                "text_style_mode": "obsidian",
                "status": "needs_review",
                "missing_miro_items": {"actionable": 1},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_json": "rest.json",
                "source_assets": {"missing": 0},
                "export": {"complete": True},
                "source": {"items": 1},
            },
            {
                "board": board,
                "source_key": MERGED_REST_EXP_WEBSDK,
                "text_style_mode": "obsidian",
                "status": "ok",
                "missing_miro_items": {"actionable": 0},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
                "canvas": {"missing_files": 0},
                "source_json": "merged.json",
                "source_assets": {"missing": 0},
                "export": {"complete": True},
                "completeness": union_complete(),
                "source": {"items": 2},
            },
        ]
        payload = {"summary": {}, "records": records}

        best = choose_best_records(records)[0]
        report = render_recommendations(payload)

        self.assertEqual(best["source_key"], MERGED_REST_EXP_WEBSDK)
        self.assertIn("Merged REST experimental + Web SDK", report)

    def test_production_rejects_actionable_defects_even_with_ok_status(self) -> None:
        reasons = production_ineligibility_reasons(
            {
                "source_key": REST_EXP,
                "source_json": "rest.json",
                "status": "ok",
                "export": {"complete": True},
                "source_assets": {"missing": 0},
                "canvas": {"missing_files": 0},
                "missing_miro_items": {"actionable": 1},
                "mapping": {"actionable": 0},
                "overlaps": {"generated": 0},
            }
        )

        self.assertIn("actionable_items_missing", reasons)

    def test_production_rejects_each_union_loss(self) -> None:
        expected_reasons = {
            "missing_item_ids": "union_items_missing",
            "missing_fields": "union_fields_missing",
            "missing_content_items": "union_content_missing",
            "missing_geometry_items": "union_geometry_missing",
            "missing_asset_items": "union_assets_missing",
            "missing_comment_ids": "union_comments_missing",
            "missing_comment_fields": "union_comment_fields_missing",
        }
        for metric, expected_reason in expected_reasons.items():
            with self.subTest(metric=metric):
                completeness = union_complete()
                completeness[metric] = 1
                record = {
                    "board": {"board_id": "board-1"},
                    "source_key": MERGED_REST_EXP_WEBSDK,
                    "text_style_mode": "obsidian",
                    "source_json": "merged.json",
                    "status": "ok",
                    "export": {"complete": True},
                    "completeness": completeness,
                    "source_assets": {"missing": 0},
                    "canvas": {"missing_files": 0},
                    "missing_miro_items": {"actionable": 0},
                    "mapping": {"actionable": 0},
                    "overlaps": {"generated": 0},
                }
                self.assertIn(expected_reason, production_ineligibility_reasons(record))
                self.assertEqual(choose_best_records([record]), [])

    def test_production_rejects_unmeasured_union_completeness(self) -> None:
        record = {
            "source_key": MERGED_REST_EXP_WEBSDK,
            "source_json": "merged.json",
            "status": "ok",
            "export": {"complete": True},
        }
        self.assertIn(
            "union_completeness_not_measured", production_ineligibility_reasons(record)
        )

    def test_production_result_includes_failed_only_board_modes(self) -> None:
        result = build_production_source_result(
            {
                "settings": {"text_modes": ["miro", "obsidian"]},
                "records": [
                    {
                        "board": {"board_id": "board-1"},
                        "source_key": MERGED_REST_EXP_WEBSDK,
                        "text_style_mode": None,
                        "status": "dependency_missing",
                        "source_json": None,
                        "export": {},
                    }
                ],
            }
        )

        self.assertFalse(result["complete"])
        self.assertEqual(
            result["summary"], {"expected": 2, "selected": 0, "missing": 2}
        )
        self.assertEqual(
            {item["text_style_mode"] for item in result["recommendations"]},
            {"miro", "obsidian"},
        )

    def test_source_keys_require_token_for_rest_and_legacy_sources(self) -> None:
        self.assertTrue(source_keys_require_token([REST_EXP]))
        self.assertFalse(source_keys_require_token([WEBSDK]))

    def test_required_runtime_token_is_enforced_without_oauth_flag(self) -> None:
        args = Namespace(oauth=False, token_env="NO_SUCH_MIRO_TOKEN_FOR_TEST")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(
                SystemExit, "NO_SUCH_MIRO_TOKEN_FOR_TEST is not set"
            ):
                resolve_runtime_token(args, required=True)

    def test_reset_outputs_refuses_unowned_nonempty_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_reset_guard_") as tmp:
            out_dir = Path(tmp) / "important"
            out_dir.mkdir()
            (out_dir / "keep.txt").write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "unowned output directory"):
                reset_outputs(out_dir)

            self.assertEqual((out_dir / "keep.txt").read_text(encoding="utf-8"), "keep")

    def test_reset_outputs_clears_only_sentinel_owned_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_reset_owned_") as tmp:
            out_dir = Path(tmp) / "owned"
            reset_outputs(out_dir)
            (out_dir / "old.txt").write_text("old", encoding="utf-8")

            reset_outputs(out_dir)

            self.assertFalse((out_dir / "old.txt").exists())
            self.assertTrue((out_dir / ".miro-export-source-compare").is_file())

    def test_comparison_failure_preserves_previous_generation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_compare_transaction_") as tmp:
            root = Path(tmp)
            out_dir = root / "out"
            out_dir.mkdir()
            (out_dir / ".miro-export-source-compare").write_text(
                "miro-export-source-compare-v1\n",
                encoding="utf-8",
            )
            marker = out_dir / "old.txt"
            marker.write_text("old-generation", encoding="utf-8")
            args = Namespace(
                sources=WEBSDK,
                preflight=False,
                refresh_board_list_only=False,
                refresh_board_list=False,
                board_list=root / "boards.md",
                limit=None,
                out_dir=out_dir,
                keep_out_dir=False,
            )
            board = BoardRef(
                board_id="board-1",
                label="Board",
                url="https://miro.com/app/board/board-1/",
            )

            with (
                patch("compare_miro_export_sources.parse_args", return_value=args),
                patch(
                    "compare_miro_export_sources.resolve_runtime_token", return_value=""
                ),
                patch(
                    "compare_miro_export_sources.load_board_refs", return_value=[board]
                ),
                patch(
                    "compare_miro_export_sources._run_comparison",
                    side_effect=RuntimeError("comparison failed"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "comparison failed"):
                    comparison_main()

            self.assertEqual(marker.read_text(encoding="utf-8"), "old-generation")

    def test_preflight_creates_runtime_dirs_and_masks_oauth_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_preflight_") as tmp:
            root = Path(tmp)
            args = Namespace(
                board_list=root / "lists" / "boards.json",
                websdk_root=root / "websdk",
                out_dir=root / "out",
                token_env="NO_SUCH_MIRO_TOKEN_FOR_TEST",
                oauth_client_id_env="MIRO_CLIENT_ID",
                oauth_client_secret_env="MIRO_CLIENT_SECRET",
                oauth_redirect_uri="http://localhost:8765/callback",
                oauth_scopes="boards:read team:read",
                oauth_authorize_url="https://miro.example/authorize",
                oauth_token_url="https://miro.example/token",
            )
            fake_config = SimpleNamespace(
                client_id="1234567890",
                client_secret="secret",
                redirect_uri=args.oauth_redirect_uri,
                scopes=args.oauth_scopes,
            )

            with (
                patch.dict(os.environ, {}, clear=False),
                patch(
                    "compare_miro_export_sources.config_from_env",
                    return_value=fake_config,
                ),
            ):
                payload = preflight_report(args, [REST_EXP, WEBSDK])
            lists_dir_exists = (root / "lists").is_dir()
            websdk_dir_exists = (root / "websdk").is_dir()
            out_dir_exists = (root / "out").is_dir()

        self.assertFalse(payload["ready"])
        self.assertEqual(payload["auth"]["oauth"]["client_id"], "******7890")
        self.assertTrue(payload["auth"]["oauth"]["client_secret_present"])
        self.assertTrue(lists_dir_exists)
        self.assertTrue(websdk_dir_exists)
        self.assertTrue(out_dir_exists)
        self.assertIn("Run with --refresh-board-list --oauth", payload["next_steps"][0])

    def test_refresh_board_list_writes_miro_board_payload(self) -> None:
        boards = [
            {"id": "uXjVOne=", "name": "One", "team": {"name": "Alpha"}},
            {"id": "uXjVTwo=", "name": "Two", "team": {"name": "Alpha"}},
        ]

        with tempfile.TemporaryDirectory(prefix="miro2obs_refresh_boards_") as tmp:
            output = Path(tmp) / "boards.json"
            with patch(
                "compare_miro_export_sources.get_boards", return_value=boards
            ) as get_boards:
                summary = refresh_board_list(output, token="token-1")
            payload = json.loads(output.read_text(encoding="utf-8"))

        get_boards.assert_called_once_with("token-1")
        self.assertEqual(summary, {"total": 2, "by_team": {"Alpha": 2}})
        self.assertEqual(payload["source"], "miro_rest_boards")
        self.assertEqual(
            [board["id"] for board in payload["boards"]], ["uXjVOne=", "uXjVTwo="]
        )


if __name__ == "__main__":
    unittest.main()
