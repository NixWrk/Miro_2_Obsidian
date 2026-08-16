from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))
sys.path.insert(0, str(SCRIPTS_DIR))

import miro_pipeline  # noqa: E402
from Scale_engine import ViewProfile  # noqa: E402
from miro_pipeline import (  # noqa: E402
    resolve_scale,
    run_existing_json_pipeline,
    run_rest_experimental_pipeline,
)


def complete_source_export(
    items: list[dict],
    comments: list[dict] | None = None,
    *,
    complete: bool = True,
    asset_stats: dict | None = None,
) -> tuple[dict, dict]:
    completeness = {
        "complete": complete,
        "items": {"complete": True},
        "comments": {"complete": True},
        "assets": {"complete": complete},
    }
    payload = {
        "items": items,
        "comments": comments or [],
        "completeness": completeness,
    }
    info = {
        "asset_stats": asset_stats
        or {
            "images": 0,
            "documents": 0,
            "doc_formats": 0,
            "embeds": 0,
            "failed": 0 if complete else 1,
            "optional_failed": 0,
        },
        "completeness": completeness,
    }
    return payload, info


def verified_existing_source(items: list[dict] | None = None) -> dict:
    items = items or []
    source_counts: dict[str, int] = {}
    for item in items:
        source = str(item.get("source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1
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
        "board": {"id": "board-1"},
        "items": items,
        "comments": [],
        "provenance": {
            "board_id": "board-1",
            "items": {
                "complete": True,
                "raw_count": len(items),
                "item_count": len(items),
                "sources": dict(sorted(source_counts.items())),
            },
            "comments": {"complete": True, "raw_count": 0, "comment_count": 0},
            "assets": {"strategy": "test"},
        },
        "completeness": {
            "complete": True,
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


class MiroPipelineTests(unittest.TestCase):
    def test_existing_source_rejects_nonfinite_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.json"
            source.write_text('{"items": [], "x": NaN}', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Existing JSON cannot be read"):
                miro_pipeline.inspect_existing_source(source)

    def test_canonical_existing_source_uses_canonical_completeness_sections(self) -> None:
        payload = {
            "source_surface": "canonical",
            "items": [],
            "completeness": {
                "complete": True,
                "capture_complete": True,
                "board_complete": False,
                "rest": {"complete": True},
                "web_sdk": {"complete": True},
                "comments": {"complete": True},
                "assets": {"complete": True, "checked": True},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "canonical.json"
            source.write_text(json.dumps(payload), encoding="utf-8")
            with patch("miro_pipeline.validate_canonical_export") as validate:
                loaded, completeness = miro_pipeline.inspect_existing_source(source)

        validate.assert_called_once_with(payload, max_age_hours=-1)
        self.assertEqual(loaded, payload)
        self.assertTrue(completeness["verified"])
        self.assertEqual(completeness["issues"], [])

    def test_rest_pipeline_exports_assets_and_calls_single_converter(self) -> None:
        items = [{"id": "text-1", "type": "text", "data": {"content": "<p>Hello</p>"}}]
        comments = [{"id": "comment-1", "type": "comment", "content": "Nice"}]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "source" / "board.json"
            target_dir = root / "vault" / "MIRO2OBSIDIAN" / "board"
            vault_root = root / "vault"
            attachment_dir = vault_root / "Files" / "Attachments"
            expected_canvas = target_dir / "board.canvas"
            with (
                patch(
                    "miro_pipeline.export_complete_board_source",
                    return_value=complete_source_export(items, comments),
                ) as export,
                patch(
                    "miro_pipeline.resolve_scale",
                    return_value=(0.5, {"scale_source": "auto"}),
                ) as scale,
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(expected_canvas),
                ) as convert,
            ):
                result = run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=source_json,
                    target_dir=target_dir,
                    vault_root=vault_root,
                    attachment_dir=attachment_dir,
                    text_style_mode="miro",
                )

        export.assert_called_once()
        self.assertEqual(export.call_args.kwargs["output_path"], source_json)
        self.assertTrue(export.call_args.kwargs["prefer_experimental"])
        self.assertTrue(export.call_args.kwargs["download_assets"])
        self.assertFalse(export.call_args.kwargs["allow_missing_assets"])
        scale.assert_called_once()
        convert.assert_called_once()
        self.assertEqual(
            convert.call_args.args[:3],
            (str(source_json), str(target_dir), str(vault_root)),
        )
        self.assertEqual(convert.call_args.kwargs["scale"], 0.5)
        self.assertEqual(convert.call_args.kwargs["text_style_mode"], "miro")
        self.assertEqual(
            convert.call_args.kwargs["attachment_dir"], str(attachment_dir)
        )
        self.assertEqual(result.canvas_path, expected_canvas)
        self.assertEqual(result.item_count, 1)
        self.assertTrue(result.completeness["complete"])

    def test_rest_pipeline_merges_websdk_export_before_conversion(self) -> None:
        rest_payload, rest_info = complete_source_export(
            [{"id": "rest-1", "type": "text"}]
        )
        merged = {"stage": "merged"}
        canonical_requirements = {
            "images": 0,
            "documents": 0,
            "doc_formats": 0,
            "embeds": 0,
            "failed": 0,
            "optional_failed": 0,
        }
        canonical = {
            "items": [
                {"id": "rest-1", "type": "text"},
                {"id": "sdk-1", "type": "mindmap_node"},
            ],
            "comments": [],
            "completeness": {
                "complete": True,
                "assets": {
                    "complete": True,
                    "requirements": canonical_requirements,
                },
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            websdk_json = root / "websdk.json"
            with (
                patch(
                    "miro_pipeline.export_complete_board_source",
                    return_value=(rest_payload, rest_info),
                ) as export,
                patch(
                    "miro_pipeline.load_json",
                    return_value={"source_surface": "web_sdk"},
                ) as load,
                patch("miro_pipeline.merge_sources", return_value=merged) as merge,
                patch(
                    "miro_pipeline.finalize_merged_export",
                    return_value=canonical,
                ) as finalize,
                patch(
                    "miro_pipeline.resolve_scale",
                    return_value=(1.0, {"scale_source": "auto"}),
                ),
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(root / "board.canvas"),
                ),
            ):
                result = run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=source_json,
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    websdk_json=websdk_json,
                )

        load.assert_called_once_with(websdk_json)
        merge.assert_called_once_with(
            rest_payload,
            {"source_surface": "web_sdk"},
            board_id="board-1",
        )
        staged_rest = export.call_args.kwargs["output_path"]
        self.assertNotEqual(staged_rest, source_json)
        self.assertEqual(staged_rest.name, source_json.name)
        finalize.assert_called_once_with(
            merged,
            source_json=staged_rest,
            output_json=source_json,
            token="token-1",
        )
        self.assertEqual(result.item_count, 2)
        self.assertEqual(result.asset_stats, canonical_requirements)

    def test_failed_websdk_merge_preserves_existing_source_bundle(self) -> None:
        rest_payload, rest_info = complete_source_export([])

        def export_to_stage(**kwargs):
            kwargs["output_path"].write_text("staged-rest", encoding="utf-8")
            return rest_payload, rest_info

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            source_json.write_text("previous-canonical", encoding="utf-8")
            with (
                patch(
                    "miro_pipeline.export_complete_board_source",
                    side_effect=export_to_stage,
                ),
                patch("miro_pipeline.load_json", return_value={}),
                patch(
                    "miro_pipeline.merge_sources",
                    side_effect=ValueError("Web SDK board mismatch"),
                ),
                patch("miro_pipeline.setup_obsidian_plugins") as plugins,
                patch("miro_pipeline.convert_miro_to_canvas") as convert,
            ):
                with self.assertRaisesRegex(ValueError, "board mismatch"):
                    run_rest_experimental_pipeline(
                        board_id="board-1",
                        token="token-1",
                        source_json=source_json,
                        target_dir=root / "target",
                        vault_root=root / "vault",
                        websdk_json=root / "websdk.json",
                        install_obsidian_plugins=True,
                    )

            self.assertEqual(
                source_json.read_text(encoding="utf-8"), "previous-canonical"
            )
            self.assertEqual(list(root.glob(".board-stage-*")), [])
            plugins.assert_not_called()
            convert.assert_not_called()

    def test_websdk_union_rejects_degraded_asset_mode_before_side_effects(self) -> None:
        with (
            patch("miro_pipeline.export_complete_board_source") as export,
            patch("miro_pipeline.setup_obsidian_plugins") as plugins,
        ):
            with self.assertRaisesRegex(ValueError, "diagnostic-only"):
                run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=Path("board.json"),
                    target_dir=Path("target"),
                    vault_root=Path("vault"),
                    websdk_json=Path("websdk.json"),
                    allow_missing_assets=True,
                    install_obsidian_plugins=True,
                )

        export.assert_not_called()
        plugins.assert_not_called()

    def test_allow_missing_assets_records_degraded_completeness(self) -> None:
        items = [{"id": "image-1", "type": "image", "data": {}}]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch(
                    "miro_pipeline.export_complete_board_source",
                    return_value=complete_source_export(items, complete=False),
                ) as export,
                patch(
                    "miro_pipeline.resolve_scale",
                    return_value=(1.0, {"scale_source": "auto"}),
                ),
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(root / "out.canvas"),
                ),
            ):
                result = run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=root / "board.json",
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    allow_missing_assets=True,
                    prefer_experimental=False,
                )

        self.assertTrue(export.call_args.kwargs["allow_missing_assets"])
        self.assertFalse(result.completeness["complete"])
        self.assertTrue(miro_pipeline.pipeline_result_is_degraded(result))

    def test_stable_items_switches_rest_items_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch(
                    "miro_pipeline.export_complete_board_source",
                    return_value=complete_source_export([]),
                ) as export,
                patch(
                    "miro_pipeline.resolve_scale",
                    return_value=(1.0, {"scale_source": "auto"}),
                ),
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(root / "out.canvas"),
                ),
            ):
                run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=root / "board.json",
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    prefer_experimental=False,
                )

        self.assertFalse(export.call_args.kwargs["prefer_experimental"])

    def test_pipeline_stops_before_conversion_when_export_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch(
                    "miro_pipeline.export_complete_board_source",
                    side_effect=RuntimeError("Asset validation incomplete"),
                ),
                patch("miro_pipeline.convert_miro_to_canvas") as convert,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Asset validation incomplete"
                ):
                    run_rest_experimental_pipeline(
                        board_id="board-1",
                        token="token-1",
                        source_json=root / "board.json",
                        target_dir=root / "target",
                        vault_root=root / "vault",
                        prefer_experimental=False,
                    )

        convert.assert_not_called()

    def test_pipeline_can_install_obsidian_plugins_before_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch("miro_pipeline.setup_obsidian_plugins") as plugins,
                patch(
                    "miro_pipeline.export_complete_board_source",
                    return_value=complete_source_export([]),
                ),
                patch(
                    "miro_pipeline.resolve_scale",
                    return_value=(1.0, {"scale_source": "auto"}),
                ),
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(root / "out.canvas"),
                ),
            ):
                run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=root / "board.json",
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    install_obsidian_plugins=True,
                )

        plugins.assert_called_once()
        self.assertEqual(plugins.call_args.args[0], root / "vault")

    def test_existing_json_pipeline_uses_the_same_converter_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            attachment_dir = root / "vault" / "Files" / "Attachments"
            expected_canvas = root / "target" / "board.canvas"
            source_json.write_text(
                json.dumps(verified_existing_source()), encoding="utf-8"
            )
            with (
                patch("miro_pipeline.setup_obsidian_plugins") as plugins,
                patch(
                    "miro_pipeline.resolve_scale",
                    return_value=(0.75, {"scale_source": "auto"}),
                ),
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(expected_canvas),
                ) as convert,
            ):
                result = run_existing_json_pipeline(
                    source_json=source_json,
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    install_obsidian_plugins=True,
                    attachment_dir=attachment_dir,
                    text_style_mode="obsidian",
                )

        plugins.assert_called_once()
        convert.assert_called_once()
        self.assertEqual(
            convert.call_args.args[:3],
            (str(source_json), str(root / "target"), str(root / "vault")),
        )
        self.assertEqual(convert.call_args.kwargs["scale"], 0.75)
        self.assertEqual(convert.call_args.kwargs["text_style_mode"], "obsidian")
        self.assertEqual(
            convert.call_args.kwargs["attachment_dir"], str(attachment_dir)
        )
        self.assertEqual(result.canvas_path, expected_canvas)
        self.assertTrue(result.completeness["verified"])

    def test_existing_json_rejects_incomplete_source_before_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            payload = verified_existing_source()
            payload["completeness"]["complete"] = False
            source_json.write_text(json.dumps(payload), encoding="utf-8")
            canvas = root / "target" / "board.canvas"
            canvas.parent.mkdir()
            canvas.write_bytes(b"existing-canvas")

            with (
                patch("miro_pipeline.setup_obsidian_plugins") as plugins,
                patch("miro_pipeline.convert_miro_to_canvas") as convert,
            ):
                with self.assertRaisesRegex(ValueError, "incomplete or unverified"):
                    run_existing_json_pipeline(
                        source_json=source_json,
                        target_dir=canvas.parent,
                        vault_root=root / "vault",
                        install_obsidian_plugins=True,
                    )

            self.assertEqual(canvas.read_bytes(), b"existing-canvas")
            plugins.assert_not_called()
            convert.assert_not_called()

    def test_existing_json_rejects_unverified_legacy_list_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            source_json.write_text("[]", encoding="utf-8")
            with patch("miro_pipeline.convert_miro_to_canvas") as convert:
                with self.assertRaisesRegex(ValueError, "verified REST or canonical"):
                    run_existing_json_pipeline(
                        source_json=source_json,
                        target_dir=root / "target",
                        vault_root=root / "vault",
                    )
            convert.assert_not_called()

    def test_existing_json_explicit_degraded_opt_in_converts_and_reports_degraded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            source_json.write_text("[]", encoding="utf-8")
            expected_canvas = root / "target" / "board.canvas"
            with (
                patch("miro_pipeline.resolve_scale", return_value=(1.0, {})),
                patch(
                    "miro_pipeline.convert_miro_to_canvas",
                    return_value=str(expected_canvas),
                ) as convert,
            ):
                result = run_existing_json_pipeline(
                    source_json=source_json,
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    allow_incomplete_source=True,
                )

            convert.assert_called_once()
            self.assertTrue(miro_pipeline.pipeline_result_is_degraded(result))
            self.assertFalse(result.completeness["verified"])
            self.assertTrue(any("WARNING" in message for message in result.messages))

    def test_cli_existing_json_skips_miro_auth_and_rest_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            target_dir = root / "target"
            vault_root = root / "vault"
            attachment_dir = vault_root / "Files" / "Attachments"
            expected = miro_pipeline.PipelineResult(
                source_json=source_json,
                canvas_path=target_dir / "board.canvas",
                item_count=0,
                asset_stats={},
                scale=1.0,
                scale_context={"scale_source": "explicit"},
                messages=[],
            )

            argv = [
                "miro_pipeline.py",
                "--existing-json",
                "--source-json",
                str(source_json),
                "--target-dir",
                str(target_dir),
                "--vault-root",
                str(vault_root),
                "--scale",
                "1",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch(
                    "miro_pipeline.resolve_attachment_dir", return_value=attachment_dir
                ),
                patch("miro_pipeline.resolve_token_from_args") as auth,
                patch("miro_pipeline.run_rest_experimental_pipeline") as rest,
                patch(
                    "miro_pipeline.run_existing_json_pipeline", return_value=expected
                ) as existing,
            ):
                result = miro_pipeline.main()

        self.assertEqual(result, 0)
        auth.assert_not_called()
        rest.assert_not_called()
        existing.assert_called_once()
        self.assertEqual(existing.call_args.kwargs["source_json"], source_json)
        self.assertEqual(existing.call_args.kwargs["attachment_dir"], attachment_dir)
        self.assertFalse(existing.call_args.kwargs["allow_incomplete_source"])

    def test_cli_stable_items_reaches_rest_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            target_dir = root / "target"
            vault_root = root / "vault"
            attachment_dir = vault_root / "Files" / "Attachments"
            expected = miro_pipeline.PipelineResult(
                source_json=source_json,
                canvas_path=target_dir / "board.canvas",
                item_count=1,
                asset_stats={},
                scale=1.0,
                scale_context={},
                messages=[],
            )

            argv = [
                "miro_pipeline.py",
                "--board-id",
                "board-1",
                "--source-json",
                str(source_json),
                "--target-dir",
                str(target_dir),
                "--vault-root",
                str(vault_root),
                "--stable-items",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch(
                    "miro_pipeline.resolve_attachment_dir", return_value=attachment_dir
                ),
                patch("miro_pipeline.resolve_token_from_args", return_value="token-1"),
                patch(
                    "miro_pipeline.run_rest_experimental_pipeline",
                    return_value=expected,
                ) as rest,
            ):
                result = miro_pipeline.main()

        self.assertEqual(result, 0)
        self.assertFalse(rest.call_args.kwargs["prefer_experimental"])

    def test_cli_forwards_websdk_json_to_rest_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "board.json"
            websdk_json = root / "websdk.json"
            expected = miro_pipeline.PipelineResult(
                source_json=source_json,
                canvas_path=root / "board.canvas",
                item_count=1,
                asset_stats={},
                scale=1.0,
                scale_context={},
                messages=[],
            )
            argv = [
                "miro_pipeline.py",
                "--board-id",
                "board-1",
                "--source-json",
                str(source_json),
                "--websdk-json",
                str(websdk_json),
                "--target-dir",
                str(root / "target"),
                "--vault-root",
                str(root / "vault"),
            ]
            with (
                patch.object(sys, "argv", argv),
                patch("miro_pipeline.resolve_attachment_dir", return_value=None),
                patch("miro_pipeline.resolve_token_from_args", return_value="token-1"),
                patch(
                    "miro_pipeline.run_rest_experimental_pipeline",
                    return_value=expected,
                ) as rest,
            ):
                result = miro_pipeline.main()

        self.assertEqual(result, 0)
        self.assertEqual(rest.call_args.kwargs["websdk_json"], websdk_json)

    def test_cli_returns_nonzero_for_explicitly_degraded_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = Namespace(
                attachment_dir=root / "attachments",
                vault_root=root / "vault",
                target_dir=root / "target",
                existing_json=False,
                board_id="board-1",
                source_json=root / "board.json",
                websdk_json=None,
                scale=None,
                min_font_px=8,
                theme="dark",
                text_style_mode="miro",
                allow_missing_assets=True,
                allow_incomplete_source=False,
                stable_items=False,
                install_obsidian_plugins=False,
                advanced_canvas_source_plugins_dir=None,
                advanced_canvas_version="6.0.1",
            )
            parser = Namespace(parse_args=lambda: args)
            degraded = miro_pipeline.PipelineResult(
                source_json=args.source_json,
                canvas_path=args.target_dir / "board.canvas",
                item_count=1,
                asset_stats={"failed": 1},
                scale=1.0,
                scale_context={},
                messages=[],
                completeness={"complete": False, "assets": {"complete": False}},
            )
            with (
                patch("miro_pipeline.build_parser", return_value=parser),
                patch(
                    "miro_pipeline.view_profile_from_args", return_value=ViewProfile()
                ),
                patch("miro_pipeline.resolve_token_from_args", return_value="token-1"),
                patch(
                    "miro_pipeline.run_rest_experimental_pipeline",
                    return_value=degraded,
                ),
            ):
                result = miro_pipeline.main()

        self.assertEqual(result, 2)

    def test_pipeline_result_without_export_completeness_is_not_degraded(self) -> None:
        existing = miro_pipeline.PipelineResult(
            source_json=Path("source.json"),
            canvas_path=Path("board.canvas"),
            item_count=0,
            asset_stats={},
            scale=1.0,
            scale_context={},
            messages=[],
        )

        self.assertFalse(miro_pipeline.pipeline_result_is_degraded(existing))

    def test_resolve_scale_uses_scale_engine_for_auto_scale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_json = Path(tmp) / "board.json"
            source_json.write_text("[]", encoding="utf-8")
            profile = ViewProfile(scale_mode="readable")

            with patch(
                "miro_pipeline.compute_scale_preview",
                return_value={"scale": 0.25, "context": {"scale_mode": "readable"}},
            ) as preview:
                scale, context = resolve_scale(
                    source_json, explicit_scale=None, profile=profile
                )

        self.assertEqual(scale, 0.25)
        self.assertEqual(context["scale_source"], "auto")
        preview.assert_called_once_with(str(source_json), profile, 18)

    def test_resolve_scale_accepts_explicit_scale_without_reading_json(self) -> None:
        with patch("miro_pipeline.compute_scale_preview") as preview:
            scale, context = resolve_scale(
                Path("missing.json"), explicit_scale=2.0, profile=ViewProfile()
            )

        self.assertEqual(scale, 2.0)
        self.assertEqual(context["scale_source"], "explicit")
        preview.assert_not_called()

    def test_resolve_scale_rejects_nonpositive_and_nonfinite_values(self) -> None:
        with patch("miro_pipeline.compute_scale_preview") as preview:
            for value in (0, -1, float("nan"), float("inf")):
                with self.subTest(scale=value):
                    with self.assertRaisesRegex(ValueError, "positive finite"):
                        resolve_scale(
                            Path("missing.json"),
                            explicit_scale=value,
                            profile=ViewProfile(),
                        )

        preview.assert_not_called()

    def test_invalid_scale_stops_rest_pipeline_before_export_or_plugin_setup(
        self,
    ) -> None:
        with (
            patch("miro_pipeline.export_complete_board_source") as export,
            patch("miro_pipeline.setup_obsidian_plugins") as plugins,
        ):
            with self.assertRaisesRegex(ValueError, "positive finite"):
                run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=Path("source.json"),
                    target_dir=Path("target"),
                    vault_root=Path("vault"),
                    scale=float("nan"),
                    install_obsidian_plugins=True,
                )

        export.assert_not_called()
        plugins.assert_not_called()


if __name__ == "__main__":
    unittest.main()
