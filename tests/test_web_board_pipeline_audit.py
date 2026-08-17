from __future__ import annotations

import json
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.audit_web_board_pipeline import (  # noqa: E402
    AUDIT_SENTINEL_CONTENT,
    AUDIT_SENTINEL_NAME,
    BoardRef,
    audit_one_board,
    audit_succeeded,
    board_artifact_key,
    build_summary,
    export_rest_board,
    expand_text_style_modes,
    find_local_export,
    main as audit_main,
    parse_board_markdown,
    stage_export_for_conversion,
    summarize_canvas,
    validate_output_target,
)


def strict_rest_source(
    board_id: str,
    items: list[dict],
    *,
    comments: list[dict] | None = None,
    exported_at: datetime | None = None,
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
        "exported_at": (exported_at or datetime.now(timezone.utc)).isoformat(),
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


class WebBoardPipelineAuditTests(unittest.TestCase):
    def test_parse_board_markdown_extracts_unique_miro_links(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_board_list_") as tmp:
            board_list = Path(tmp) / "boards.md"
            board_list.write_text(
                "\n".join(
                    [
                        "- [Miro: Alpha (uXjVAlpha)](https://miro.com/app/board/uXjVAlpha=/)",
                        "- [Miro: Alpha copy](https://miro.com/app/board/uXjVAlpha=/)",
                        "- [Miro: Beta](https://miro.com/app/board/uXjVBeta=/?share_link_id=1)",
                    ]
                ),
                encoding="utf-8",
            )

            refs = parse_board_markdown(board_list)

        self.assertEqual([ref.board_id for ref in refs], ["uXjVAlpha=", "uXjVBeta="])
        self.assertEqual(refs[0].label, "Miro: Alpha (uXjVAlpha)")

    def test_find_local_export_requires_verified_board_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_local_export_") as tmp:
            root = Path(tmp)
            expected = root / "РџСѓР±Р»РёС‡РЅР°СЏ_uXjVAlpha=.json"
            expected.write_text(
                json.dumps(strict_rest_source("uXjVAlpha=", [])),
                encoding="utf-8",
            )
            (root / "other.json").write_text("[]", encoding="utf-8")

            self.assertEqual(find_local_export("uXjVAlpha=", root), expected)
            self.assertIsNone(find_local_export("missing=", root))

    def test_find_local_export_rejects_html_error_json_and_legacy_payloads(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="miro2obs_local_export_invalid_"
        ) as tmp:
            root = Path(tmp)
            (root / "uXjVAlpha=_html.json").write_text(
                "<html>unauthorized</html>", encoding="utf-8"
            )
            (root / "uXjVAlpha=_error.json").write_text(
                '{"error":"unauthorized"}', encoding="utf-8"
            )
            (root / "uXjVAlpha=_legacy.json").write_text("[]", encoding="utf-8")
            rejected: list[dict[str, str]] = []

            selected = find_local_export("uXjVAlpha=", root, rejected=rejected)

        self.assertIsNone(selected)
        self.assertEqual(len(rejected), 3)
        self.assertTrue(
            any("strict source envelope missing" in item["reason"] for item in rejected)
        )
        self.assertTrue(any("Expecting value" in item["reason"] for item in rejected))

    def test_stage_export_copies_only_referenced_assets(self) -> None:
        payload = strict_rest_source(
            "uXjVAssets=",
            [{"id": "image-1", "type": "image", "local_name": "nested/keep.png"}],
        )
        with tempfile.TemporaryDirectory(prefix="miro2obs_stage_allowlist_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            source.write_text(json.dumps(payload), encoding="utf-8")
            source_files = root / "board_files"
            (source_files / "nested").mkdir(parents=True)
            (source_files / "nested" / "keep.png").write_bytes(b"keep")
            (source_files / "unreferenced.txt").write_text(
                "do not copy", encoding="utf-8"
            )
            work = root / "work"
            work.mkdir()

            staged = stage_export_for_conversion(payload, source, work)

            self.assertTrue((work / "board_files" / "nested" / "keep.png").is_file())
            self.assertFalse((work / "board_files" / "unreferenced.txt").exists())
            self.assertEqual(
                json.loads(staged.read_text(encoding="utf-8"))["board"]["id"],
                "uXjVAssets=",
            )

    def test_validate_output_target_rejects_unowned_nonempty_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_audit_output_") as tmp:
            output = Path(tmp) / "custom"
            output.mkdir()
            (output / "unrelated.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "unowned"):
                validate_output_target(output)

            (output / AUDIT_SENTINEL_NAME).write_text(
                AUDIT_SENTINEL_CONTENT, encoding="utf-8"
            )
            validate_output_target(output)

    def test_summarize_canvas_rejects_file_reference_outside_vault(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_canvas_escape_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            vault.mkdir()
            (root / "secret.txt").write_text("secret", encoding="utf-8")

            summary = summarize_canvas(
                {
                    "nodes": [
                        {"id": "file-1", "type": "file", "file": "../secret.txt"}
                    ],
                    "edges": [],
                },
                vault,
            )

        self.assertEqual(summary["missing_files"], 1)
        self.assertEqual(
            summary["missing_file_examples"][0]["reason"], "file ref escapes vault"
        )

    def test_expand_text_style_modes_supports_both_variants(self) -> None:
        self.assertEqual(expand_text_style_modes("miro"), ["miro"])
        self.assertEqual(expand_text_style_modes("obsidian"), ["obsidian"])
        self.assertEqual(expand_text_style_modes("both"), ["miro", "obsidian"])

    def test_board_artifact_key_stays_short_and_unique(self) -> None:
        board = BoardRef(
            board_id="uXjVLongBoard=",
            label="Очень длинное название доски, которое не должно попасть в путь артефактов",
            url="https://miro.com/app/board/uXjVLongBoard=/",
        )

        self.assertEqual(
            board_artifact_key(board, "obsidian"), "uXjVLongBoard=_obsidian"
        )

    def test_build_summary_counts_unique_boards_and_variant_records(self) -> None:
        board = {
            "board_id": "uXjVAlpha=",
            "label": "Alpha",
            "url": "https://miro.com/app/board/uXjVAlpha=/",
        }
        summary = build_summary(
            [
                {"board": board, "status": "ok"},
                {"board": board, "status": "needs_review"},
                {
                    "board": {
                        "board_id": "uXjVBeta=",
                        "label": "Beta",
                        "url": "https://miro.com/app/board/uXjVBeta=/",
                    },
                    "status": "no_json_export",
                },
            ]
        )

        self.assertEqual(summary["boards"], 2)
        self.assertEqual(summary["records"], 3)
        self.assertEqual(summary["ok"], 1)
        self.assertEqual(summary["needs_review"], 1)
        self.assertEqual(summary["missing_json"], 1)

    def test_audit_succeeds_only_when_every_record_is_ok(self) -> None:
        self.assertTrue(audit_succeeded({"records": 2, "ok": 2}))
        self.assertFalse(audit_succeeded({"records": 2, "ok": 1}))
        self.assertFalse(audit_succeeded({"records": 0, "ok": 0}))

    def test_export_rest_board_delegates_to_complete_exporter(self) -> None:
        board = BoardRef(
            board_id="uXjVAlpha=",
            label="Alpha",
            url="https://miro.com/app/board/uXjVAlpha=/",
        )
        payload = {
            "items": [{"id": "text-1", "type": "text"}],
            "comments": [{"id": "comment-1", "type": "comment"}],
        }
        info = {
            "path": "board.json",
            "items": 1,
            "comments": 1,
            "asset_stats": {
                "images": 0,
                "documents": 0,
                "doc_formats": 0,
                "embeds": 0,
                "failed": 0,
            },
            "complete": True,
            "completeness": {"complete": True},
        }

        with tempfile.TemporaryDirectory(prefix="miro2obs_web_export_") as tmp:
            output_json = Path(tmp) / "board.json"
            with patch(
                "scripts.audit_web_board_pipeline.export_complete_board_source",
                return_value=(payload, info),
            ) as export:
                result = export_rest_board(
                    board, output_json, token="token-1", allow_missing_assets=False
                )

        export.assert_called_once()
        self.assertEqual(export.call_args.kwargs["board_id"], board.board_id)
        self.assertEqual(export.call_args.kwargs["output_path"], output_json)
        self.assertEqual(export.call_args.kwargs["board_name"], board.label)
        self.assertEqual(export.call_args.kwargs["board_url"], board.url)
        self.assertFalse(export.call_args.kwargs["allow_missing_assets"])
        self.assertEqual(result["items"], 1)
        self.assertEqual(result["comments"], 1)
        self.assertEqual(result["download_stats"], info["asset_stats"])
        self.assertTrue(result["complete"])

    def test_audit_one_board_converts_verified_minimal_export(self) -> None:
        item = {
            "id": "text-1",
            "type": "text",
            "position": {
                "x": 100,
                "y": 50,
                "origin": "center",
                "relativeTo": "canvas_center",
            },
            "geometry": {"width": 240, "height": 80},
            "style": {"fontSize": "18"},
            "data": {"content": "<p>Hello</p>"},
        }
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_pipeline_") as tmp:
            root = Path(tmp)
            source_json = root / "РџСѓР±Р»РёС‡РЅР°СЏ_uXjVAlpha=.json"
            source_json.write_text(
                json.dumps(strict_rest_source("uXjVAlpha=", [item])),
                encoding="utf-8",
            )

            record = audit_one_board(
                BoardRef(
                    board_id="uXjVAlpha=",
                    label="Alpha",
                    url="https://miro.com/app/board/uXjVAlpha=/",
                ),
                source_json=source_json,
                out_dir=root / "out",
                scale_mode="readable",
                min_zoom=2**-12,
                text_style_mode="obsidian",
                min_font_px=8,
            )

            self.assertTrue(Path(record["canvas_path"]).is_file())

        self.assertEqual(record["status"], "ok")
        self.assertTrue(record["source_validation"]["verified"])
        self.assertEqual(record["text_style_mode"], "obsidian")
        self.assertEqual(record["source"]["items"], 1)
        self.assertEqual(record["source"]["comments"], 0)
        self.assertEqual(record["canvas"]["nodes"], 2)
        self.assertEqual(record["missing_miro_items"]["total"], 1)
        self.assertEqual(record["missing_miro_items"]["actionable"], 0)
        self.assertEqual(
            record["missing_miro_items"]["by_reason"], {"source_coverage_limited": 1}
        )
        self.assertEqual(record["mapping"]["total"], 0)
        self.assertEqual(record["overlaps"]["generated"], 0)

    def test_audit_one_board_rejects_legacy_source_before_side_effects(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_legacy_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVLegacy=.json"
            source_json.write_text("[]", encoding="utf-8")
            out_dir = root / "out"
            with patch("scripts.audit_web_board_pipeline.convert_miro_to_canvas") as convert:
                record = audit_one_board(
                    BoardRef(
                        board_id="uXjVLegacy=",
                        label="Legacy",
                        url="https://miro.com/app/board/uXjVLegacy=/",
                    ),
                    source_json=source_json,
                    out_dir=out_dir,
                    scale_mode="readable",
                    min_zoom=2**-12,
                    text_style_mode="obsidian",
                    min_font_px=8,
                )

            self.assertFalse(out_dir.exists())

        self.assertEqual(record["status"], "source_invalid")
        self.assertIn("strict source envelope missing", record["error"])
        convert.assert_not_called()

    def test_failed_conversion_preserves_previous_board_artifact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_publish_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVKeep=.json"
            source_json.write_text(
                json.dumps(
                    strict_rest_source("uXjVKeep=", [{"id": "text-1", "type": "text"}])
                ),
                encoding="utf-8",
            )
            board = BoardRef(
                board_id="uXjVKeep=",
                label="Keep",
                url="https://miro.com/app/board/uXjVKeep=/",
            )
            existing = (
                root / "out" / "converted" / board_artifact_key(board, "obsidian")
            )
            existing.mkdir(parents=True)
            marker = existing / "marker.txt"
            marker.write_text("old", encoding="utf-8")

            with patch(
                "scripts.audit_web_board_pipeline.convert_miro_to_canvas",
                side_effect=RuntimeError("boom"),
            ):
                with self.assertRaisesRegex(RuntimeError, "boom"):
                    audit_one_board(
                        board,
                        source_json=source_json,
                        out_dir=root / "out",
                        scale_mode="readable",
                        min_zoom=2**-12,
                        text_style_mode="obsidian",
                        min_font_px=8,
                    )

            self.assertEqual(marker.read_text(encoding="utf-8"), "old")

    def test_audit_one_board_rejects_mismatched_strict_source_before_conversion(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_source_identity_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVExpected=.json"
            source_json.write_text(
                json.dumps(strict_rest_source("uXjVOther=", [])),
                encoding="utf-8",
            )
            with patch("scripts.audit_web_board_pipeline.convert_miro_to_canvas") as convert:
                record = audit_one_board(
                    BoardRef(
                        board_id="uXjVExpected=",
                        label="Expected",
                        url="https://miro.com/app/board/uXjVExpected=/",
                    ),
                    source_json=source_json,
                    out_dir=root / "out",
                    scale_mode="readable",
                    min_zoom=2**-12,
                    text_style_mode="obsidian",
                    min_font_px=8,
                )

        self.assertEqual(record["status"], "source_invalid")
        self.assertIn("board mismatch", record["error"])
        convert.assert_not_called()

    def test_audit_one_board_rejects_stale_strict_source_before_conversion(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="miro2obs_web_source_freshness_"
        ) as tmp:
            root = Path(tmp)
            source_json = root / "uXjVStale=.json"
            source_json.write_text(
                json.dumps(
                    strict_rest_source(
                        "uXjVStale=",
                        [],
                        exported_at=datetime.now(timezone.utc) - timedelta(hours=2),
                    )
                ),
                encoding="utf-8",
            )
            with patch("scripts.audit_web_board_pipeline.convert_miro_to_canvas") as convert:
                record = audit_one_board(
                    BoardRef(
                        board_id="uXjVStale=",
                        label="Stale",
                        url="https://miro.com/app/board/uXjVStale=/",
                    ),
                    source_json=source_json,
                    out_dir=root / "out",
                    scale_mode="readable",
                    min_zoom=2**-12,
                    text_style_mode="obsidian",
                    min_font_px=8,
                    max_source_age_hours=1,
                )

        self.assertEqual(record["status"], "source_invalid")
        self.assertIn("stale", record["error"])
        convert.assert_not_called()

    def test_audit_one_board_reports_source_missing_assets_without_conversion(
        self,
    ) -> None:
        item = {
            "id": "image-1",
            "type": "image",
            "local_name": "rest_uXjVAssets=_image-1.svg",
            "position": {
                "x": 0,
                "y": 0,
                "origin": "center",
                "relativeTo": "canvas_center",
            },
            "geometry": {"width": 80, "height": 60},
            "data": {
                "imageUrl": "https://api.miro.test/images/1?format=preview&redirect=false"
            },
        }
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_pipeline_assets_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVAssets=.json"
            source_json.write_text(
                json.dumps(strict_rest_source("uXjVAssets=", [item])),
                encoding="utf-8",
            )
            with patch("scripts.audit_web_board_pipeline.convert_miro_to_canvas") as convert:
                record = audit_one_board(
                    BoardRef(
                        board_id="uXjVAssets=",
                        label="Assets",
                        url="https://miro.com/app/board/uXjVAssets=/",
                    ),
                    source_json=source_json,
                    out_dir=root / "out",
                    scale_mode="readable",
                    min_zoom=2**-12,
                    text_style_mode="obsidian",
                    min_font_px=8,
                )

        self.assertEqual(record["status"], "source_missing_assets")
        self.assertEqual(record["source_assets"]["local_refs"], 1)
        self.assertEqual(record["source_assets"]["missing"], 1)
        self.assertFalse(record["source_assets"]["sidecar_exists"])
        self.assertEqual(
            record["source_assets"]["missing_examples"][0]["id"], "image-1"
        )
        self.assertNotIn("canvas", record)
        convert.assert_not_called()

    def test_audit_one_board_reports_required_image_without_local_name(self) -> None:
        item = {
            "id": "image-without-local-name",
            "type": "image",
            "position": {
                "x": 0,
                "y": 0,
                "origin": "center",
                "relativeTo": "canvas_center",
            },
            "geometry": {"width": 80, "height": 60},
            "data": {
                "imageUrl": "https://api.miro.test/images/1?format=preview&redirect=false"
            },
        }
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_pipeline_assets_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVAssets=.json"
            source_json.write_text(
                json.dumps(strict_rest_source("uXjVAssets=", [item])),
                encoding="utf-8",
            )
            with patch("scripts.audit_web_board_pipeline.convert_miro_to_canvas") as convert:
                record = audit_one_board(
                    BoardRef(
                        board_id="uXjVAssets=",
                        label="Assets",
                        url="https://miro.com/app/board/uXjVAssets=/",
                    ),
                    source_json=source_json,
                    out_dir=root / "out",
                    scale_mode="readable",
                    min_zoom=2**-12,
                    text_style_mode="obsidian",
                    min_font_px=8,
                )

        self.assertEqual(record["status"], "source_missing_assets")
        self.assertEqual(record["source_assets"]["local_refs"], 1)
        self.assertEqual(record["source_assets"]["missing"], 1)
        self.assertEqual(
            record["source_assets"]["missing_examples"][0]["reason"],
            "missing local_name",
        )
        self.assertNotIn("canvas", record)
        convert.assert_not_called()

    def test_main_report_failure_preserves_previous_generation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_audit_transaction_") as tmp:
            out_dir = Path(tmp) / "out"
            out_dir.mkdir()
            (out_dir / AUDIT_SENTINEL_NAME).write_text(
                AUDIT_SENTINEL_CONTENT,
                encoding="utf-8",
            )
            marker = out_dir / "old.txt"
            marker.write_text("old-generation", encoding="utf-8")

            with (
                patch(
                    "scripts.audit_web_board_pipeline.parse_args",
                    return_value=Namespace(out_dir=out_dir),
                ),
                patch(
                    "scripts.audit_web_board_pipeline.run_audit",
                    return_value={"summary": {"boards": 1}},
                ),
                patch(
                    "scripts.audit_web_board_pipeline.write_json",
                    side_effect=RuntimeError("report write failed"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "report write failed"):
                    audit_main()

            self.assertEqual(marker.read_text(encoding="utf-8"), "old-generation")


if __name__ == "__main__":
    unittest.main()
