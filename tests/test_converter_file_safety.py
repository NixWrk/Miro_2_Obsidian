from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "Json_2_Canvas"))

from Converter import (  # noqa: E402
    cleanup_sources,
    convert_miro_to_canvas,
    ensure_move_attachments,
    relpath_from_vault,
)


class ConverterFileSafetyTests(unittest.TestCase):
    def test_invalid_scale_is_rejected_before_side_effects(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_scale_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            sidecar = source.with_name("board_files")
            vault = root / "vault"
            target = vault / "out"
            source.parent.mkdir()
            sidecar.mkdir()
            vault.mkdir()
            source.write_text(json.dumps({"items": []}), encoding="utf-8")
            (sidecar / "asset.bin").write_bytes(b"asset")

            for value in (0, -1, float("nan"), float("inf")):
                with self.subTest(scale=value):
                    with self.assertRaisesRegex(ValueError, "positive finite"):
                        convert_miro_to_canvas(
                            str(source), str(target), str(vault), scale=value
                        )

                    self.assertFalse(target.exists())
                    self.assertEqual((sidecar / "asset.bin").read_bytes(), b"asset")

    def test_target_and_attachment_directories_must_stay_inside_vault(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_vault_boundary_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            vault = root / "vault"
            outside = root / "outside"
            source.write_text(json.dumps({"items": []}), encoding="utf-8")
            vault.mkdir()

            with self.assertRaisesRegex(ValueError, "Canvas target.*inside"):
                convert_miro_to_canvas(str(source), str(outside), str(vault))

            with self.assertRaisesRegex(ValueError, "Attachment directory.*inside"):
                convert_miro_to_canvas(
                    str(source),
                    str(vault / "out"),
                    str(vault),
                    attachment_dir=str(outside),
                )

            self.assertFalse(outside.exists())
            self.assertFalse((vault / "out").exists())

    def test_relpath_rejects_files_outside_vault(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_relpath_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            outside = root / "outside.bin"
            vault.mkdir()
            outside.write_bytes(b"outside")

            with self.assertRaisesRegex(ValueError, "inside the Obsidian vault"):
                relpath_from_vault(outside, vault)

    def test_nonfinite_json_is_rejected_before_attachment_copy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_nonfinite_json_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            sidecar = source.with_name("board_files")
            vault = root / "vault"
            target = vault / "out"
            source.parent.mkdir()
            sidecar.mkdir()
            vault.mkdir()
            source.write_text('{"items":[{"position":{"x":NaN}}]}', encoding="utf-8")
            (sidecar / "asset.bin").write_bytes(b"asset")

            with self.assertRaisesRegex(ValueError, "non-JSON numeric constant"):
                convert_miro_to_canvas(str(source), str(target), str(vault))

            self.assertFalse(target.exists())
            self.assertEqual((sidecar / "asset.bin").read_bytes(), b"asset")

    def test_conversion_failure_rolls_back_copied_attachments_and_keeps_canvas(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_rollback_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            sidecar = source.with_name("board_files")
            vault = root / "vault"
            target = vault / "out"
            source.parent.mkdir()
            sidecar.mkdir()
            target.mkdir(parents=True)
            (sidecar / "asset.bin").write_bytes(b"asset")
            source.write_text(
                json.dumps(
                    {
                        "items": [
                            {
                                "id": "bad",
                                "type": "text",
                                "data": {"content": "x"},
                                "geometry": {"width": "bad", "height": 40},
                                "position": {"x": 0, "y": 0},
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            canvas = target / "board.canvas"
            canvas.write_text("previous canvas", encoding="utf-8")

            with self.assertRaises(ValueError):
                convert_miro_to_canvas(str(source), str(target), str(vault))

            self.assertEqual(canvas.read_text(encoding="utf-8"), "previous canvas")
            self.assertFalse((target / "board_files").exists())
            self.assertEqual((sidecar / "asset.bin").read_bytes(), b"asset")

    def test_predictable_temp_hardlink_cannot_overwrite_another_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_hardlink_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            vault = root / "vault"
            target = vault / "out"
            victim = root / "victim.txt"
            source.write_text(json.dumps({"items": []}), encoding="utf-8")
            target.mkdir(parents=True)
            victim.write_text("do not overwrite", encoding="utf-8")
            predictable_temp = target / "board.canvas.tmp"
            try:
                os.link(victim, predictable_temp)
            except OSError as exc:
                self.skipTest(f"Hardlinks are unavailable: {exc}")

            canvas_path = Path(
                convert_miro_to_canvas(str(source), str(target), str(vault))
            )

            self.assertEqual(victim.read_text(encoding="utf-8"), "do not overwrite")
            self.assertEqual(
                predictable_temp.read_text(encoding="utf-8"), "do not overwrite"
            )
            self.assertEqual(
                json.loads(canvas_path.read_text(encoding="utf-8"))["nodes"], []
            )

    def test_cleanup_rejects_unexpected_sidecar_before_deleting_json(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_cleanup_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            unexpected = root / "unrelated"
            source.write_text("{}", encoding="utf-8")
            unexpected.mkdir()

            with self.assertRaisesRegex(ValueError, "unexpected attachment directory"):
                cleanup_sources(str(source), str(unexpected), True, True)

            self.assertTrue(source.is_file())
            self.assertTrue(unexpected.is_dir())

    def test_conversion_refuses_to_delete_in_place_attachment_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_in_place_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            sidecar = root / "board_files"
            source.write_text(json.dumps({"items": []}), encoding="utf-8")
            sidecar.mkdir()
            (sidecar / "asset.bin").write_bytes(b"asset")

            with self.assertRaisesRegex(ValueError, "used by the output Canvas"):
                convert_miro_to_canvas(
                    str(source),
                    str(root),
                    str(root),
                    delete_src_files=True,
                )

            self.assertEqual((sidecar / "asset.bin").read_bytes(), b"asset")
            self.assertFalse((root / "board.canvas").exists())

    def test_attachment_destination_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_symlink_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            sidecar = source.with_name("board_files")
            destination = root / "target" / "board_files"
            outside = root / "outside"
            source.parent.mkdir()
            source.write_text("{}", encoding="utf-8")
            sidecar.mkdir()
            (sidecar / "asset.bin").write_bytes(b"asset")
            destination.parent.mkdir()
            outside.mkdir()
            try:
                destination.symlink_to(outside, target_is_directory=True)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"Directory symlinks are unavailable: {exc}")

            with self.assertRaisesRegex(
                ValueError, "destination must be a real directory"
            ):
                ensure_move_attachments(str(source), str(destination.parent))

            self.assertFalse((outside / "asset.bin").exists())

    def test_converter_rejects_traversal_local_name(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_traversal_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            target = root / "out"
            source.write_text(
                json.dumps(
                    {
                        "items": [
                            {
                                "id": "img-1",
                                "type": "image",
                                "local_name": "../../outside.png",
                                "geometry": {"width": 100, "height": 100},
                                "position": {"x": 0, "y": 0},
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "Invalid attachment local_name"):
                convert_miro_to_canvas(str(source), str(target), str(root))

            self.assertFalse((root.parent / "outside.png").exists())
            self.assertFalse((target / "board.canvas").exists())

    def test_converter_rejects_nonportable_local_names(self) -> None:
        for local_name in (
            "asset.png:secret",
            "CON",
            "nested/NUL.txt",
            "trailing-dot.",
            "trailing-space ",
        ):
            with self.subTest(local_name=local_name):
                with tempfile.TemporaryDirectory(prefix="miro2obs_portable_") as tmp:
                    root = Path(tmp)
                    source = root / "board.json"
                    source.write_text(
                        json.dumps(
                            {
                                "items": [
                                    {
                                        "id": "img-1",
                                        "type": "image",
                                        "local_name": local_name,
                                        "geometry": {"width": 100, "height": 100},
                                        "position": {"x": 0, "y": 0},
                                    }
                                ]
                            }
                        ),
                        encoding="utf-8",
                    )

                    with self.assertRaisesRegex(
                        ValueError, "Invalid attachment local_name"
                    ):
                        convert_miro_to_canvas(
                            str(source), str(root / "out"), str(root)
                        )

    def test_attachment_conflict_is_detected_before_any_copy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attachment_conflict_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            source.parent.mkdir()
            source.write_text("{}", encoding="utf-8")
            sidecar = source.with_name("board_files")
            sidecar.mkdir()
            (sidecar / "new.bin").write_bytes(b"new")
            (sidecar / "conflict.bin").write_bytes(b"source")
            destination = root / "target" / "board_files"
            destination.mkdir(parents=True)
            (destination / "conflict.bin").write_bytes(b"existing")

            with self.assertRaisesRegex(ValueError, "Conflicting attachment file"):
                ensure_move_attachments(str(source), str(destination.parent))

            self.assertFalse((destination / "new.bin").exists())
            self.assertEqual((destination / "conflict.bin").read_bytes(), b"existing")

    def test_conversion_refreshes_its_existing_attachment_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attachment_refresh_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            sidecar = source.with_name("board_files")
            vault = root / "vault"
            target = vault / "out"
            source.parent.mkdir()
            sidecar.mkdir()
            vault.mkdir()
            source.write_text(json.dumps({"items": []}), encoding="utf-8")
            (sidecar / "asset.bin").write_bytes(b"old")
            (sidecar / "removed.bin").write_bytes(b"removed")

            convert_miro_to_canvas(str(source), str(target), str(vault))
            (sidecar / "asset.bin").write_bytes(b"new")
            (sidecar / "removed.bin").unlink()
            (sidecar / "added.bin").write_bytes(b"added")

            convert_miro_to_canvas(str(source), str(target), str(vault))

            destination = target / "board_files"
            self.assertEqual((destination / "asset.bin").read_bytes(), b"new")
            self.assertEqual((destination / "added.bin").read_bytes(), b"added")
            self.assertFalse((destination / "removed.bin").exists())

    def test_attachment_refresh_restores_previous_output_on_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attachment_restore_") as tmp:
            root = Path(tmp)
            source = root / "source" / "board.json"
            sidecar = source.with_name("board_files")
            vault = root / "vault"
            target = vault / "out"
            source.parent.mkdir()
            sidecar.mkdir()
            vault.mkdir()
            source.write_text(json.dumps({"items": []}), encoding="utf-8")
            (sidecar / "asset.bin").write_bytes(b"old")
            canvas = Path(convert_miro_to_canvas(str(source), str(target), str(vault)))
            previous_canvas = canvas.read_bytes()
            (sidecar / "asset.bin").write_bytes(b"new")

            with patch(
                "Converter._convert_miro_to_canvas_impl",
                side_effect=RuntimeError("simulated conversion failure"),
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated"):
                    convert_miro_to_canvas(str(source), str(target), str(vault))

            destination = target / "board_files"
            self.assertEqual((destination / "asset.bin").read_bytes(), b"old")
            self.assertEqual(canvas.read_bytes(), previous_canvas)
            self.assertEqual((sidecar / "asset.bin").read_bytes(), b"new")
            self.assertEqual(list(target.glob(".board_files.backup-*")), [])

    def test_declared_complete_missing_asset_fails_before_copy_or_canvas(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_strict_asset_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            target = root / "out"
            source.write_text(
                json.dumps(
                    {
                        "items": [
                            {
                                "id": "image-1",
                                "type": "image",
                                "local_name": "missing.png",
                                "data": {
                                    "imageUrl": "https://example.test/missing.png"
                                },
                                "geometry": {"width": 100, "height": 100},
                                "position": {"x": 0, "y": 0},
                            }
                        ],
                        "comments": [],
                        "completeness": {
                            "complete": True,
                            "items": {"complete": True},
                            "comments": {"complete": True},
                            "assets": {"complete": True, "checked": True},
                        },
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "required asset is missing"):
                convert_miro_to_canvas(str(source), str(target), str(root))

            self.assertFalse((target / "board_files").exists())
            self.assertFalse((target / "board.canvas").exists())

    def test_shared_attachment_dir_isolates_same_named_sources(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_collision_") as tmp:
            root = Path(tmp)
            attachment_root = root / "attachments"
            sources = []
            for folder, content in (("one", b"first"), ("two", b"second")):
                source = root / folder / "board.json"
                source.parent.mkdir()
                source.write_text("{}", encoding="utf-8")
                sidecar = source.with_name("board_files")
                sidecar.mkdir()
                (sidecar / "asset.bin").write_bytes(content)
                sources.append(source)

            destinations = [
                Path(
                    ensure_move_attachments(
                        str(source), str(root / "out"), str(attachment_root)
                    )
                )
                for source in sources
            ]

            self.assertNotEqual(destinations[0], destinations[1])
            self.assertEqual((destinations[0] / "asset.bin").read_bytes(), b"first")
            self.assertEqual((destinations[1] / "asset.bin").read_bytes(), b"second")

    def test_cleanup_rolls_back_if_staging_second_source_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_cleanup_rollback_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            sidecar = root / "board_files"
            source.write_text("{}", encoding="utf-8")
            sidecar.mkdir()
            (sidecar / "asset.bin").write_bytes(b"asset")
            original_replace = Path.replace

            def fail_sidecar_move(path: Path, target: Path) -> Path:
                if path == sidecar:
                    raise OSError("simulated staging failure")
                return original_replace(path, target)

            with patch("pathlib.Path.replace", new=fail_sidecar_move):
                with self.assertRaisesRegex(OSError, "simulated staging failure"):
                    cleanup_sources(str(source), str(sidecar), True, True)

            self.assertTrue(source.is_file())
            self.assertEqual((sidecar / "asset.bin").read_bytes(), b"asset")

    def test_full_source_is_preserved_when_json_is_deleted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_full_provenance_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            target = root / "out"
            payload = {
                "schema_version": 1,
                "exporter_version": "unique-exporter",
                "source_surface": "canonical",
                "source_metadata": {"rest": {"unique_marker": "root-metadata"}},
                "items": [
                    {
                        "id": "text-1",
                        "type": "text",
                        "data": {"content": "<p>Hello</p>"},
                        "source_provenance": {"unique_marker": "item-provenance"},
                        "geometry": {"width": 100, "height": 40},
                        "position": {"x": 0, "y": 0},
                    }
                ],
                "comments": [
                    {"id": "comment-1", "type": "comment", "unique_marker": "comment"}
                ],
                "custom_root": {"unique_marker": "root"},
            }
            source.write_text(json.dumps(payload), encoding="utf-8")

            canvas_path = Path(
                convert_miro_to_canvas(
                    str(source),
                    str(target),
                    str(root),
                    delete_json=True,
                )
            )
            canvas = json.loads(canvas_path.read_text(encoding="utf-8"))

            self.assertFalse(source.exists())
            self.assertEqual(canvas["miroSource"], payload)

    def test_incomplete_source_is_visible_in_canvas_and_metadata(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_incomplete_") as tmp:
            root = Path(tmp)
            source = root / "board.json"
            target = root / "out"
            completeness = {
                "complete": False,
                "items": {"complete": True},
                "comments": {"complete": False},
                "assets": {"complete": False, "checked": False},
            }
            source.write_text(
                json.dumps(
                    {
                        "items": [],
                        "comments": [],
                        "completeness": completeness,
                    }
                ),
                encoding="utf-8",
            )

            canvas_path = Path(
                convert_miro_to_canvas(str(source), str(target), str(root))
            )
            canvas = json.loads(canvas_path.read_text(encoding="utf-8"))

            self.assertEqual(canvas["miroSource"]["completeness"], completeness)
            diagnostics = [
                node
                for node in canvas["nodes"]
                if node.get("miroDiagnostic") == "source_incomplete"
            ]
            self.assertEqual(len(diagnostics), 1)
            self.assertIn("comments.complete is not true", diagnostics[0]["text"])


if __name__ == "__main__":
    unittest.main()
