"""Phase 1a contract: miro2obsidian/schemas/v1/*.schema.json, its fixtures, and the CLI.

These tests check the schema files themselves (they must be valid draft
2020-12), that every fixture under schemas/v1/fixtures/ gets the result its
manifest entry promises, that boards the current converter actually produces
validate against board.schema.json, and the validation CLI's exit codes.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMAS_DIR = REPO_ROOT / "miro2obsidian" / "schemas" / "v1"
FIXTURES_DIR = SCHEMAS_DIR / "fixtures"
CONVERTER_FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

from Json_2_Canvas.Converter import convert_miro_to_canvas  # noqa: E402
from miro2obsidian import validate as validate_cli  # noqa: E402
from miro2obsidian.schema import (  # noqa: E402
    validate_board,
    validate_canvas_metadata,
    validate_source,
)

SCHEMA_FILE_NAMES = ("board.schema.json", "miro-source.schema.json", "miro-canvas.schema.json")


def _load_json(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _load_manifest() -> list[dict]:
    return _load_json(FIXTURES_DIR / "manifest.json")["fixtures"]


class SchemasAreValidDraft202012(unittest.TestCase):
    def test_every_schema_file_is_a_valid_draft_2020_12_schema(self) -> None:
        for name in SCHEMA_FILE_NAMES:
            schema = _load_json(SCHEMAS_DIR / name)
            with self.subTest(schema=name):
                Draft202012Validator.check_schema(schema)

    def test_every_schema_declares_a_stable_versioned_id(self) -> None:
        for name in SCHEMA_FILE_NAMES:
            schema = _load_json(SCHEMAS_DIR / name)
            with self.subTest(schema=name):
                self.assertIn("$id", schema)
                self.assertTrue(schema["$id"].endswith("/v1/" + name))


class FixturesMatchTheManifest(unittest.TestCase):
    def test_every_fixture_gets_the_result_its_manifest_entry_promises(self) -> None:
        manifest = _load_manifest()
        self.assertGreaterEqual(len(manifest), 13, "the manifest should list every fixture on disk")

        for entry in manifest:
            fixture_path = FIXTURES_DIR / entry["path"]
            with self.subTest(fixture=entry["id"]):
                self.assertTrue(fixture_path.is_file(), f"fixture file missing: {fixture_path}")
                document = _load_json(fixture_path)

                board_issues = validate_board(document)
                expected_board = entry["board_schema"]
                actual_board = "invalid" if board_issues else "valid"
                self.assertEqual(actual_board, expected_board, f"board.schema.json issues: {board_issues}")

                expected_source = entry["miro_source_schema"]
                if expected_source == "not_applicable":
                    self.assertNotIn("miroSource", document)
                else:
                    source_issues = validate_source(document["miroSource"])
                    actual_source = "invalid" if source_issues else "valid"
                    self.assertEqual(actual_source, expected_source, f"miro-source.schema.json issues: {source_issues}")

                expected_canvas = entry["miro_canvas_schema"]
                if expected_canvas == "not_applicable":
                    self.assertNotIn("miroCanvas", document)
                else:
                    canvas_issues = validate_canvas_metadata(document["miroCanvas"])
                    actual_canvas = "invalid" if canvas_issues else "valid"
                    self.assertEqual(actual_canvas, expected_canvas, f"miro-canvas.schema.json issues: {canvas_issues}")

    def test_every_fixture_file_on_disk_is_listed_in_the_manifest(self) -> None:
        manifest_paths = {entry["path"] for entry in _load_manifest()}
        on_disk = {
            str(path.relative_to(FIXTURES_DIR)).replace("\\", "/")
            for path in FIXTURES_DIR.glob("*/*.canvas")
        }
        self.assertEqual(on_disk, manifest_paths)


class ConverterOutputMatchesTheBoardSchema(unittest.TestCase):
    """Real converter output, not just hand-written fixtures, must validate."""

    def _convert(self, fixture_name: str) -> dict:
        fixture_dir = CONVERTER_FIXTURES_DIR / fixture_name
        with tempfile.TemporaryDirectory(prefix=f"schema_check_{fixture_name}_") as tmp:
            work_dir = Path(tmp)
            input_path = work_dir / "input.miro.json"
            shutil.copy2(fixture_dir / "input.miro.json", input_path)

            src_files = fixture_dir / "input.miro_files"
            if src_files.exists():
                shutil.copytree(src_files, work_dir / "input.miro_files")

            vault_root = work_dir / "vault"
            target_dir = vault_root / "MIRO2OBSIDIAN"
            target_dir.mkdir(parents=True)

            canvas_path = convert_miro_to_canvas(
                str(input_path),
                str(target_dir),
                str(vault_root),
                scale=1.0,
                min_font_px=8,
                theme="dark",
                text_style_mode="miro",
            )
            return _load_json(Path(canvas_path))

    def test_basic_text_board_validates(self) -> None:
        document = self._convert("basic_text")
        issues = validate_board(document)
        self.assertEqual(issues, [], f"issues: {[str(i) for i in issues]}")

    def test_mindmap_node_tree_board_validates(self) -> None:
        document = self._convert("mindmap_node_tree")
        issues = validate_board(document)
        self.assertEqual(issues, [], f"issues: {[str(i) for i in issues]}")


class ValidateCliExitCodes(unittest.TestCase):
    def test_exits_zero_for_a_valid_board(self) -> None:
        path = FIXTURES_DIR / "valid" / "plugin-authored-board.canvas"
        self.assertEqual(validate_cli.main([str(path)]), 0)

    def test_exits_non_zero_for_an_invalid_board(self) -> None:
        path = FIXTURES_DIR / "invalid" / "edge-bad-side.canvas"
        self.assertEqual(validate_cli.main([str(path)]), 1)

    def test_exits_non_zero_for_a_missing_file(self) -> None:
        self.assertEqual(validate_cli.main([str(FIXTURES_DIR / "no-such-file.canvas")]), 1)

    def test_exits_non_zero_with_no_arguments(self) -> None:
        self.assertEqual(validate_cli.main([]), 2)

    def test_validates_every_fixture_in_one_call(self) -> None:
        valid_paths = [str(p) for p in (FIXTURES_DIR / "valid").glob("*.canvas")]
        invalid_paths = [str(p) for p in (FIXTURES_DIR / "invalid").glob("*.canvas")]
        self.assertEqual(validate_cli.main(valid_paths), 0)
        self.assertEqual(validate_cli.main(invalid_paths), 1)


if __name__ == "__main__":
    unittest.main()
