from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))
sys.path.insert(0, str(SCRIPTS_DIR))

import miro_pipeline  # noqa: E402
from Scale_engine import ViewProfile  # noqa: E402
from miro_pipeline import resolve_scale, run_existing_json_pipeline, run_rest_experimental_pipeline  # noqa: E402


class MiroPipelineTests(unittest.TestCase):
    def test_rest_pipeline_exports_assets_and_calls_single_converter(self) -> None:
        items = [{"id": "text-1", "type": "text", "data": {"content": "<p>Hello</p>"}}]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_json = root / "source" / "board.json"
            target_dir = root / "vault" / "MIRO2OBSIDIAN" / "board"
            vault_root = root / "vault"
            attachment_dir = vault_root / "Files" / "Attachments"
            expected_canvas = target_dir / "board.canvas"
            comments = [{"id": "comment-1", "type": "comment", "content": "Nice"}]

            with (
                patch("miro_pipeline.export_board_items", return_value=items) as export_items,
                patch("miro_pipeline.export_board_comments", return_value=comments) as export_comments,
                patch("miro_pipeline.download_export_assets", return_value={"images": 0, "documents": 0, "doc_formats": 0, "embeds": 0, "failed": 0}) as assets,
                patch("miro_pipeline.write_json") as write_json,
                patch("miro_pipeline.resolve_scale", return_value=(0.5, {"scale_source": "auto"})) as scale,
                patch("miro_pipeline.convert_miro_to_canvas", return_value=str(expected_canvas)) as convert,
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

        export_items.assert_called_once()
        self.assertTrue(export_items.call_args.kwargs["prefer_experimental"])
        export_comments.assert_called_once()
        assets.assert_called_once()
        self.assertTrue(assets.call_args.kwargs["strict"])
        write_json.assert_called_once_with(source_json, {"items": items, "comments": comments})
        scale.assert_called_once()
        convert.assert_called_once()
        self.assertEqual(convert.call_args.args[:3], (str(source_json), str(target_dir), str(vault_root)))
        self.assertEqual(convert.call_args.kwargs["scale"], 0.5)
        self.assertEqual(convert.call_args.kwargs["text_style_mode"], "miro")
        self.assertEqual(convert.call_args.kwargs["attachment_dir"], str(attachment_dir))
        self.assertEqual(result.canvas_path, expected_canvas)
        self.assertEqual(result.item_count, 1)

    def test_allow_missing_assets_switches_asset_strictness_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch("miro_pipeline.export_board_items", return_value=[]),
                patch("miro_pipeline.export_board_comments", return_value=[]),
                patch("miro_pipeline.download_export_assets", return_value={"images": 0, "documents": 0, "doc_formats": 0, "embeds": 0, "failed": 1}) as assets,
                patch("miro_pipeline.write_json"),
                patch("miro_pipeline.resolve_scale", return_value=(1.0, {"scale_source": "auto"})),
                patch("miro_pipeline.convert_miro_to_canvas", return_value=str(root / "out.canvas")),
            ):
                run_rest_experimental_pipeline(
                    board_id="board-1",
                    token="token-1",
                    source_json=root / "board.json",
                    target_dir=root / "target",
                    vault_root=root / "vault",
                    allow_missing_assets=True,
                )

        self.assertFalse(assets.call_args.kwargs["strict"])

    def test_pipeline_can_install_obsidian_plugins_before_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch("miro_pipeline.setup_obsidian_plugins") as plugins,
                patch("miro_pipeline.export_board_items", return_value=[]),
                patch("miro_pipeline.export_board_comments", return_value=[]),
                patch("miro_pipeline.download_export_assets", return_value={}),
                patch("miro_pipeline.write_json"),
                patch("miro_pipeline.resolve_scale", return_value=(1.0, {"scale_source": "auto"})),
                patch("miro_pipeline.convert_miro_to_canvas", return_value=str(root / "out.canvas")),
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
            with (
                patch("miro_pipeline.setup_obsidian_plugins") as plugins,
                patch("miro_pipeline.resolve_scale", return_value=(0.75, {"scale_source": "auto"})),
                patch("miro_pipeline.convert_miro_to_canvas", return_value=str(expected_canvas)) as convert,
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
        self.assertEqual(convert.call_args.args[:3], (str(source_json), str(root / "target"), str(root / "vault")))
        self.assertEqual(convert.call_args.kwargs["scale"], 0.75)
        self.assertEqual(convert.call_args.kwargs["text_style_mode"], "obsidian")
        self.assertEqual(convert.call_args.kwargs["attachment_dir"], str(attachment_dir))
        self.assertEqual(result.canvas_path, expected_canvas)

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
                patch("miro_pipeline.resolve_attachment_dir", return_value=attachment_dir),
                patch("miro_pipeline.resolve_token_from_args") as auth,
                patch("miro_pipeline.run_rest_experimental_pipeline") as rest,
                patch("miro_pipeline.run_existing_json_pipeline", return_value=expected) as existing,
            ):
                result = miro_pipeline.main()

        self.assertEqual(result, 0)
        auth.assert_not_called()
        rest.assert_not_called()
        existing.assert_called_once()
        self.assertEqual(existing.call_args.kwargs["source_json"], source_json)
        self.assertEqual(existing.call_args.kwargs["attachment_dir"], attachment_dir)

    def test_resolve_scale_uses_scale_engine_for_auto_scale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_json = Path(tmp) / "board.json"
            source_json.write_text("[]", encoding="utf-8")
            profile = ViewProfile(scale_mode="readable")

            with patch(
                "miro_pipeline.compute_scale_preview",
                return_value={"scale": 0.25, "context": {"scale_mode": "readable"}},
            ) as preview:
                scale, context = resolve_scale(source_json, explicit_scale=None, profile=profile)

        self.assertEqual(scale, 0.25)
        self.assertEqual(context["scale_source"], "auto")
        preview.assert_called_once_with(str(source_json), profile, 18)

    def test_resolve_scale_accepts_explicit_scale_without_reading_json(self) -> None:
        with patch("miro_pipeline.compute_scale_preview") as preview:
            scale, context = resolve_scale(Path("missing.json"), explicit_scale=2.0, profile=ViewProfile())

        self.assertEqual(scale, 2.0)
        self.assertEqual(context["scale_source"], "explicit")
        preview.assert_not_called()


if __name__ == "__main__":
    unittest.main()
