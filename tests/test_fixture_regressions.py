from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import convert_miro_to_canvas  # noqa: E402


class CanvasValidationError(AssertionError):
    pass


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def _fixture_dirs() -> list[Path]:
    return sorted(
        p for p in FIXTURES_DIR.iterdir()
        if p.is_dir() and (p / "input.miro.json").exists()
    )


def _run_converter(fixture_dir: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix=f"miro2obs_{fixture_dir.name}_") as tmp:
        work_dir = Path(tmp)
        input_path = work_dir / "input.miro.json"
        shutil.copy2(fixture_dir / "input.miro.json", input_path)

        src_files = fixture_dir / "input.miro_files"
        if src_files.exists():
            shutil.copytree(src_files, work_dir / "input.miro_files")

        vault_root = work_dir / "vault"
        target_dir = vault_root / "MIRO2OBSIDIAN"
        target_dir.mkdir(parents=True)

        manifest = _load_json(fixture_dir / "case.json")
        converter_cfg = manifest.get("converter", {})

        canvas_path = convert_miro_to_canvas(
            str(input_path),
            str(target_dir),
            str(vault_root),
            scale=float(converter_cfg.get("scale", 1.0)),
            min_font_px=int(converter_cfg.get("min_font_px", 8)),
            theme=str(converter_cfg.get("theme", "dark")),
        )
        return _load_json(Path(canvas_path))


def _validate_jsoncanvas(canvas: dict[str, Any]) -> None:
    if not isinstance(canvas, dict):
        raise CanvasValidationError("Canvas root must be an object")

    nodes = canvas.get("nodes")
    edges = canvas.get("edges")
    if not isinstance(nodes, list):
        raise CanvasValidationError("Canvas must contain a nodes list")
    if not isinstance(edges, list):
        raise CanvasValidationError("Canvas must contain an edges list")

    node_ids: set[str] = set()
    for idx, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise CanvasValidationError(f"Node #{idx} must be an object")
        for key in ("id", "type", "x", "y", "width", "height"):
            if key not in node:
                raise CanvasValidationError(f"Node #{idx} is missing {key!r}")
        node_id = str(node["id"])
        if not node_id:
            raise CanvasValidationError(f"Node #{idx} has an empty id")
        if node_id in node_ids:
            raise CanvasValidationError(f"Duplicate node id: {node_id}")
        node_ids.add(node_id)

        width = float(node["width"])
        height = float(node["height"])
        if width <= 0 or height <= 0:
            raise CanvasValidationError(f"Node {node_id} has non-positive size")

    for idx, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise CanvasValidationError(f"Edge #{idx} must be an object")
        for key in ("id", "fromNode", "toNode"):
            if key not in edge:
                raise CanvasValidationError(f"Edge #{idx} is missing {key!r}")
        if str(edge["fromNode"]) not in node_ids:
            raise CanvasValidationError(f"Edge #{idx} points from missing node")
        if str(edge["toNode"]) not in node_ids:
            raise CanvasValidationError(f"Edge #{idx} points to missing node")


def _node_by_id(canvas: dict[str, Any], node_id: str) -> dict[str, Any]:
    for node in canvas["nodes"]:
        if str(node.get("id")) == node_id:
            return node
    raise AssertionError(f"Expected node {node_id!r} was not found")


def _assert_node(testcase: unittest.TestCase, canvas: dict[str, Any], expected: dict[str, Any]) -> None:
    node = _node_by_id(canvas, str(expected["id"]))

    if "type" in expected:
        testcase.assertEqual(node.get("type"), expected["type"])
    if "url" in expected:
        testcase.assertEqual(node.get("url"), expected["url"])
    if "text_contains" in expected:
        testcase.assertIn(expected["text_contains"], node.get("text", ""))
    if "width" in expected:
        testcase.assertAlmostEqual(float(node["width"]), float(expected["width"]), places=4)
    if "height" in expected:
        testcase.assertAlmostEqual(float(node["height"]), float(expected["height"]), places=4)
    if "min_height" in expected:
        testcase.assertGreaterEqual(float(node["height"]), float(expected["min_height"]))
    if "shape" in expected:
        testcase.assertEqual((node.get("styleAttributes") or {}).get("shape"), expected["shape"])


def _assert_non_overlapping_pair(testcase: unittest.TestCase, canvas: dict[str, Any], pair: list[str]) -> None:
    testcase.assertEqual(len(pair), 2)
    left = _node_by_id(canvas, str(pair[0]))
    right = _node_by_id(canvas, str(pair[1]))

    lx = float(left["x"])
    ly = float(left["y"])
    lw = float(left["width"])
    lh = float(left["height"])
    rx = float(right["x"])
    ry = float(right["y"])
    rw = float(right["width"])
    rh = float(right["height"])

    overlap_w = min(lx + lw, rx + rw) - max(lx, rx)
    overlap_h = min(ly + lh, ry + rh) - max(ly, ry)
    testcase.assertTrue(
        overlap_w <= 0 or overlap_h <= 0,
        f"Nodes {pair[0]!r} and {pair[1]!r} overlap by {overlap_w}x{overlap_h}",
    )


class FixtureRegressionTests(unittest.TestCase):
    maxDiff = None

    def test_all_fixtures_convert_to_valid_jsoncanvas(self) -> None:
        fixtures = _fixture_dirs()
        self.assertTrue(fixtures, "At least one fixture is required")

        for fixture_dir in fixtures:
            with self.subTest(fixture=fixture_dir.name):
                canvas = _run_converter(fixture_dir)
                _validate_jsoncanvas(canvas)

    def test_fixture_semantic_assertions(self) -> None:
        for fixture_dir in _fixture_dirs():
            with self.subTest(fixture=fixture_dir.name):
                manifest = _load_json(fixture_dir / "case.json")
                canvas = _run_converter(fixture_dir)
                assertions = manifest.get("assertions", {})

                if "node_count" in assertions:
                    self.assertEqual(len(canvas["nodes"]), int(assertions["node_count"]))
                if "edge_count" in assertions:
                    self.assertEqual(len(canvas["edges"]), int(assertions["edge_count"]))

                node_ids = {str(n.get("id")) for n in canvas["nodes"]}
                for node_id in assertions.get("absent_node_ids", []):
                    self.assertNotIn(str(node_id), node_ids)

                for expected_node in assertions.get("nodes", []):
                    _assert_node(self, canvas, expected_node)

                for pair in assertions.get("non_overlapping_pairs", []):
                    _assert_non_overlapping_pair(self, canvas, pair)

    def test_fixture_conversion_is_deterministic(self) -> None:
        for fixture_dir in _fixture_dirs():
            with self.subTest(fixture=fixture_dir.name):
                first = _run_converter(fixture_dir)
                second = _run_converter(fixture_dir)
                self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
