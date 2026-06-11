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
    if "file_contains" in expected:
        testcase.assertIn(expected["file_contains"], node.get("file", ""))
    if "file_not_contains" in expected:
        testcase.assertNotIn(expected["file_not_contains"], node.get("file", ""))
    if "text_contains" in expected:
        testcase.assertIn(expected["text_contains"], node.get("text", ""))
    if "text_not_contains" in expected:
        testcase.assertNotIn(expected["text_not_contains"], node.get("text", ""))
    if "width" in expected:
        testcase.assertAlmostEqual(float(node["width"]), float(expected["width"]), places=4)
    if "min_width" in expected:
        testcase.assertGreaterEqual(float(node["width"]), float(expected["min_width"]))
    if "height" in expected:
        testcase.assertAlmostEqual(float(node["height"]), float(expected["height"]), places=4)
    if "min_height" in expected:
        testcase.assertGreaterEqual(float(node["height"]), float(expected["min_height"]))
    if "font_size" in expected:
        testcase.assertEqual((node.get("styleAttributes") or {}).get("fontSize"), expected["font_size"])
    if "shape" in expected:
        testcase.assertEqual((node.get("styleAttributes") or {}).get("shape"), expected["shape"])
    if "label" in expected:
        testcase.assertEqual(node.get("label"), expected["label"])
    if "group_nodes" in expected:
        testcase.assertEqual(node.get("nodes"), expected["group_nodes"])
    if "ratio" in expected:
        testcase.assertAlmostEqual(float(node.get("ratio")), float(expected["ratio"]), places=4)


def _assert_edge(testcase: unittest.TestCase, canvas: dict[str, Any], expected: dict[str, Any]) -> None:
    for edge in canvas["edges"]:
        if "id" in expected and str(edge.get("id")) != str(expected["id"]):
            continue
        if "fromNode" in expected and str(edge.get("fromNode")) != str(expected["fromNode"]):
            continue
        if "toNode" in expected and str(edge.get("toNode")) != str(expected["toNode"]):
            continue
        return
    testcase.fail(f"Expected edge was not found: {expected!r}")


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


def _rect_for_node(node: dict[str, Any]) -> tuple[float, float, float, float]:
    x = float(node["x"])
    y = float(node["y"])
    width = float(node["width"])
    height = float(node["height"])
    return x, y, x + width, y + height


def _overlap_size(left: dict[str, Any], right: dict[str, Any]) -> tuple[float, float]:
    lx0, ly0, lx1, ly1 = _rect_for_node(left)
    rx0, ry0, rx1, ry1 = _rect_for_node(right)
    return min(lx1, rx1) - max(lx0, rx0), min(ly1, ry1) - max(ly0, ry0)


def _assert_no_overlapping_nodes(testcase: unittest.TestCase, canvas: dict[str, Any], rule: dict[str, Any]) -> None:
    allowed_types = {str(t) for t in rule.get("types", ["text", "file", "link"])}
    excluded_ids = {str(node_id) for node_id in rule.get("exclude_node_ids", [])}
    min_overlap_width = float(rule.get("min_overlap_width", 0.0))
    min_overlap_height = float(rule.get("min_overlap_height", 0.0))

    nodes = [
        node for node in canvas["nodes"]
        if str(node.get("type")) in allowed_types and str(node.get("id")) not in excluded_ids
    ]
    overlaps: list[str] = []

    for idx, left in enumerate(nodes):
        for right in nodes[idx + 1:]:
            overlap_w, overlap_h = _overlap_size(left, right)
            if overlap_w > min_overlap_width and overlap_h > min_overlap_height:
                overlaps.append(
                    f"{left.get('id')}:{left.get('type')} <-> "
                    f"{right.get('id')}:{right.get('type')} "
                    f"overlap={overlap_w:.4f}x{overlap_h:.4f}"
                )

    testcase.assertFalse(
        overlaps,
        "Unexpected node overlaps:\n" + "\n".join(overlaps[:20]),
    )


def _assert_children_inside_group(testcase: unittest.TestCase, canvas: dict[str, Any], rule: dict[str, Any]) -> None:
    group = _node_by_id(canvas, str(rule["group_id"]))
    child_ids = [str(child_id) for child_id in rule.get("child_ids", group.get("nodes") or [])]
    tolerance = float(rule.get("tolerance", 0.0))

    gx0, gy0, gx1, gy1 = _rect_for_node(group)
    outside: list[str] = []
    for child_id in child_ids:
        child = _node_by_id(canvas, child_id)
        cx = float(child["x"]) + float(child["width"]) / 2.0
        cy = float(child["y"]) + float(child["height"]) / 2.0
        if not (
            gx0 - tolerance <= cx <= gx1 + tolerance
            and gy0 - tolerance <= cy <= gy1 + tolerance
        ):
            outside.append(
                f"{child_id} center=({cx:.4f},{cy:.4f}) outside "
                f"{group.get('id')} rect=({gx0:.4f},{gy0:.4f},{gx1:.4f},{gy1:.4f})"
            )

    testcase.assertFalse(
        outside,
        "Expected child centers to stay inside group:\n" + "\n".join(outside),
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
                if "metadata" in assertions:
                    metadata = canvas.get("metadata") or {}
                    for key, expected_value in assertions["metadata"].items():
                        self.assertEqual(metadata.get(key), expected_value)

                node_ids = {str(n.get("id")) for n in canvas["nodes"]}
                for node_id in assertions.get("absent_node_ids", []):
                    self.assertNotIn(str(node_id), node_ids)

                for expected_node in assertions.get("nodes", []):
                    _assert_node(self, canvas, expected_node)

                for expected_edge in assertions.get("edges", []):
                    _assert_edge(self, canvas, expected_edge)

                for pair in assertions.get("non_overlapping_pairs", []):
                    _assert_non_overlapping_pair(self, canvas, pair)

                for rule in assertions.get("no_overlapping_nodes", []):
                    _assert_no_overlapping_nodes(self, canvas, rule)

                for rule in assertions.get("children_inside_groups", []):
                    _assert_children_inside_group(self, canvas, rule)

    def test_fixture_conversion_is_deterministic(self) -> None:
        for fixture_dir in _fixture_dirs():
            with self.subTest(fixture=fixture_dir.name):
                first = _run_converter(fixture_dir)
                second = _run_converter(fixture_dir)
                self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
