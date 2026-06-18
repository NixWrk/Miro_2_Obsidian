from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
DEFAULT_LIMIT = 50
GENERATED_EDGE_PREFIXES = ("mindmap-", "slide-sequence-")
SOURCE_LIMITED_DROP_TYPES = {
    "dynamic_poll",
    "flip_card",
    "people",
    "prototyping_screen",
    "table",
    "widgets_stack",
}
META_TYPES = {"board", "board_member"}
CONTAINER_TYPES = {"group", "frame", "diagram", "slide_container"}


@dataclass(frozen=True)
class MappingIssue:
    item_id: str
    item_type: str
    reason: str
    detail: str = ""
    canvas_kind: str = ""
    canvas_type: str = ""
    actionable: bool = True


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def _iter_source_items(miro_root: Any) -> list[dict[str, Any]]:
    sys.path.insert(0, str(CONVERTER_DIR))
    from Converter import iter_objects  # noqa: PLC0415

    return [item for item in iter_objects(miro_root) if isinstance(item, dict) and item.get("id") is not None]


def _items_by_id(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        by_id.setdefault(str(item.get("id")), item)
    return by_id


def _multi_by_id(values: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for value in values:
        value_id = value.get("id")
        if value_id is not None:
            result[str(value_id)].append(value)
    return dict(result)


def _has_geometry(item: dict[str, Any]) -> bool:
    geom = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    return geom.get("width") is not None or geom.get("height") is not None


def _has_position(item: dict[str, Any]) -> bool:
    pos = item.get("position") if isinstance(item.get("position"), dict) else {}
    return pos.get("x") is not None and pos.get("y") is not None


def _connector_endpoints(item: dict[str, Any]) -> tuple[str, str]:
    start = item.get("startItem") if isinstance(item.get("startItem"), dict) else {}
    end = item.get("endItem") if isinstance(item.get("endItem"), dict) else {}
    return str(start.get("id") or ""), str(end.get("id") or "")


def expected_node_types(item: dict[str, Any]) -> set[str]:
    item_type = str(item.get("type") or "").lower()
    if item_type in CONTAINER_TYPES:
        return {"group"}
    if item_type in {"image", "document", "doc_format"}:
        return {"file", "link"}
    if item_type == "embed":
        return {"file", "link", "text"}
    if item_type == "text":
        return {"text", "link"}
    if item_type in {
        "shape",
        "sticky_note",
        "mindmap_node",
        "card",
        "preview",
        "app_card",
        "code",
        "table_text",
        "tag",
        "comment",
    }:
        return {"text"}
    if item_type in META_TYPES or item_type in SOURCE_LIMITED_DROP_TYPES:
        return set()
    if _has_geometry(item) or _has_position(item):
        return {"text"}
    return set()


def _is_generated_canvas_id(value: str, *, canvas_kind: str) -> bool:
    if canvas_kind == "edge":
        return value.startswith(GENERATED_EDGE_PREFIXES)
    return False


def _canvas_node_rect(node: dict[str, Any]) -> tuple[float, float, float, float] | None:
    try:
        x = float(node["x"])
        y = float(node["y"])
        width = float(node["width"])
        height = float(node["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return x, y, width, height


def _rects_overlap(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
    *,
    tolerance: float = 1.0,
) -> bool:
    left_x, left_y, left_w, left_h = left
    right_x, right_y, right_w, right_h = right
    overlap_w = min(left_x + left_w, right_x + right_w) - max(left_x, right_x)
    overlap_h = min(left_y + left_h, right_y + right_h) - max(left_y, right_y)
    return overlap_w > tolerance and overlap_h > tolerance


def _source_rect_tuple(source_rect: Any) -> tuple[float, float, float, float]:
    return float(source_rect.x), float(source_rect.y), float(source_rect.width), float(source_rect.height)


def _source_rect_overlaps_any(source_rects: dict[str, Any], node_id: str) -> bool:
    source_rect = source_rects.get(node_id)
    if not source_rect:
        return False
    left = _source_rect_tuple(source_rect)
    for other_id, other_rect in source_rects.items():
        if other_id == node_id:
            continue
        if _rects_overlap(left, _source_rect_tuple(other_rect)):
            return True
    return False


def _canvas_rect_overlaps_any(
    nodes_by_id: dict[str, list[dict[str, Any]]],
    node_id: str,
    canvas_rect: tuple[float, float, float, float],
) -> bool:
    for other_id, nodes in nodes_by_id.items():
        if other_id == node_id:
            continue
        for node in nodes:
            if node.get("type") not in {"text", "file", "link"}:
                continue
            other_rect = _canvas_node_rect(node)
            if other_rect and _rects_overlap(canvas_rect, other_rect):
                return True
    return False


def _position_drift_tolerance(source_width: float, source_height: float) -> float:
    basis = min(max(source_width, source_height), 800.0)
    return max(24.0, basis * 0.25)


def _distance(left_x: float, left_y: float, right_x: float, right_y: float) -> float:
    return math.hypot(left_x - right_x, left_y - right_y)


def _append_geometry_drift_issues(
    issues: list[MappingIssue],
    *,
    miro_root: Any,
    source_by_id: dict[str, dict[str, Any]],
    nodes_by_id: dict[str, list[dict[str, Any]]],
    scale: float,
) -> None:
    from audit_node_overlaps import build_miro_source_rects  # noqa: PLC0415

    source_rects, _source_missing = build_miro_source_rects(miro_root, scale=scale)
    candidates: list[tuple[str, dict[str, Any], dict[str, Any], Any, tuple[float, float, float, float]]] = []
    source_to_canvas_dx: list[float] = []
    source_to_canvas_dy: list[float] = []

    for node_id, nodes in sorted(nodes_by_id.items()):
        source_rect = source_rects.get(node_id)
        if not source_rect:
            continue
        item = source_by_id.get(node_id, {})
        for node in nodes:
            canvas_rect = _canvas_node_rect(node)
            if not canvas_rect:
                continue
            x, y, width, height = canvas_rect
            source_cx = source_rect.x + source_rect.width / 2.0
            source_cy = source_rect.y + source_rect.height / 2.0
            canvas_cx = x + width / 2.0
            canvas_cy = y + height / 2.0
            source_to_canvas_dx.append(canvas_cx - source_cx)
            source_to_canvas_dy.append(canvas_cy - source_cy)
            candidates.append((node_id, item, node, source_rect, canvas_rect))

    if not candidates:
        return

    board_dx = median(source_to_canvas_dx)
    board_dy = median(source_to_canvas_dy)
    for node_id, item, node, source_rect, canvas_rect in candidates:
        item_type = str(item.get("type") or "").lower()
        x, y, width, height = canvas_rect
        source_cx = source_rect.x + source_rect.width / 2.0
        source_cy = source_rect.y + source_rect.height / 2.0
        canvas_cx = x + width / 2.0
        canvas_cy = y + height / 2.0
        expected_cx = source_cx + board_dx
        expected_cy = source_cy + board_dy
        expected_x = source_rect.x + board_dx
        expected_y = source_rect.y + board_dy
        center_drift = _distance(canvas_cx, canvas_cy, expected_cx, expected_cy)
        top_left_drift = _distance(x, y, expected_x, expected_y)
        drift = min(center_drift, top_left_drift)
        tolerance = _position_drift_tolerance(source_rect.width, source_rect.height)
        if drift <= tolerance:
            continue
        source_overlap_repaired = (
            _source_rect_overlaps_any(source_rects, node_id)
            and not _canvas_rect_overlaps_any(nodes_by_id, node_id, canvas_rect)
        )
        reason = "node_layout_repaired_source_overlap" if source_overlap_repaired else "node_position_drift"
        issues.append(
            MappingIssue(
                node_id,
                item_type,
                reason,
                (
                    f"Canvas center ({canvas_cx:.2f}, {canvas_cy:.2f}) differs from "
                    f"source center after board translation ({expected_cx:.2f}, {expected_cy:.2f}) by "
                    f"{center_drift:.2f}px; top-left drift {top_left_drift:.2f}px; "
                    f"effective drift {drift:.2f}px; tolerance {tolerance:.2f}px; "
                    f"board translation ({board_dx:.2f}, {board_dy:.2f})."
                ),
                canvas_kind="node",
                canvas_type=str(node.get("type") or ""),
                actionable=not source_overlap_repaired,
            )
        )


def audit_mapping_issues(miro_root: Any, canvas_root: dict[str, Any], *, scale: float | None = None) -> list[MappingIssue]:
    source_items = _iter_source_items(miro_root)
    source_by_id = _items_by_id(source_items)
    source_counts = Counter(str(item.get("id")) for item in source_items)

    nodes = [node for node in canvas_root.get("nodes", []) if isinstance(node, dict)]
    edges = [edge for edge in canvas_root.get("edges", []) if isinstance(edge, dict)]
    nodes_by_id = _multi_by_id(nodes)
    edges_by_id = _multi_by_id(edges)
    node_ids = set(nodes_by_id)
    edge_ids = set(edges_by_id)

    issues: list[MappingIssue] = []

    for source_id, count in sorted(source_counts.items()):
        if count > 1:
            item = source_by_id[source_id]
            issues.append(
                MappingIssue(
                    source_id,
                    str(item.get("type") or ""),
                    "duplicate_source_id",
                    f"Source export contains {count} items with the same id.",
                )
            )

    for canvas_id, values in sorted(nodes_by_id.items()):
        if len(values) > 1:
            item = source_by_id.get(canvas_id, {})
            issues.append(
                MappingIssue(
                    canvas_id,
                    str(item.get("type") or ""),
                    "duplicate_canvas_node_id",
                    f"Canvas contains {len(values)} nodes with the same id.",
                    canvas_kind="node",
                )
            )

    for canvas_id, values in sorted(edges_by_id.items()):
        if len(values) > 1:
            item = source_by_id.get(canvas_id, {})
            issues.append(
                MappingIssue(
                    canvas_id,
                    str(item.get("type") or ""),
                    "duplicate_canvas_edge_id",
                    f"Canvas contains {len(values)} edges with the same id.",
                    canvas_kind="edge",
                )
            )

    for canvas_id in sorted(node_ids & edge_ids):
        item = source_by_id.get(canvas_id, {})
        issues.append(
            MappingIssue(
                canvas_id,
                str(item.get("type") or ""),
                "canvas_id_used_as_node_and_edge",
                "The same id is represented as both a Canvas node and edge.",
                canvas_kind="node+edge",
            )
        )

    for item in source_items:
        source_id = str(item.get("id"))
        item_type = str(item.get("type") or "").lower()
        source_nodes = nodes_by_id.get(source_id, [])
        source_edges = edges_by_id.get(source_id, [])

        if item_type == "connector":
            start_id, end_id = _connector_endpoints(item)
            if source_nodes:
                issues.append(
                    MappingIssue(
                        source_id,
                        item_type,
                        "connector_represented_as_node",
                        "Miro connector id appears as a Canvas node.",
                        canvas_kind="node",
                        canvas_type=str(source_nodes[0].get("type") or ""),
                    )
                )
            for edge in source_edges:
                from_node = str(edge.get("fromNode") or "")
                to_node = str(edge.get("toNode") or "")
                if start_id and end_id and (from_node != start_id or to_node != end_id):
                    issues.append(
                        MappingIssue(
                            source_id,
                            item_type,
                            "connector_endpoint_mismatch",
                            f"Miro endpoints {start_id}->{end_id}, Canvas endpoints {from_node}->{to_node}.",
                            canvas_kind="edge",
                            canvas_type="edge",
                        )
                    )
                for endpoint_role, endpoint_id in (("fromNode", from_node), ("toNode", to_node)):
                    if endpoint_id and endpoint_id not in node_ids:
                        issues.append(
                            MappingIssue(
                                source_id,
                                item_type,
                                "connector_endpoint_missing_canvas_node",
                                f"Canvas edge {endpoint_role}={endpoint_id} has no matching Canvas node.",
                                canvas_kind="edge",
                                canvas_type="edge",
                            )
                        )
            continue

        if source_edges:
            issues.append(
                MappingIssue(
                    source_id,
                    item_type,
                    "item_represented_as_edge",
                    "Non-connector Miro item id appears as a Canvas edge.",
                    canvas_kind="edge",
                    canvas_type="edge",
                )
            )

        expected_types = expected_node_types(item)
        for node in source_nodes:
            node_type = str(node.get("type") or "")
            if expected_types and node_type not in expected_types:
                issues.append(
                    MappingIssue(
                        source_id,
                        item_type,
                        "node_type_mismatch",
                        f"Expected Canvas node type in {sorted(expected_types)}, got {node_type}.",
                        canvas_kind="node",
                        canvas_type=node_type,
                    )
                )
            if not expected_types:
                issues.append(
                    MappingIssue(
                        source_id,
                        item_type,
                        "unexpected_node_for_source_limited_item",
                        "Source item is normally dropped, but Canvas contains a node with the same id.",
                        canvas_kind="node",
                        canvas_type=node_type,
                    )
                )

    for canvas_id, values in sorted(nodes_by_id.items()):
        if canvas_id in source_by_id:
            continue
        issues.append(
            MappingIssue(
                canvas_id,
                "",
                "orphan_canvas_node",
                "Canvas node id does not match any source Miro item id.",
                canvas_kind="node",
                canvas_type=str(values[0].get("type") or ""),
            )
        )

    for canvas_id, values in sorted(edges_by_id.items()):
        if canvas_id in source_by_id or _is_generated_canvas_id(canvas_id, canvas_kind="edge"):
            continue
        issues.append(
            MappingIssue(
                canvas_id,
                "",
                "orphan_canvas_edge",
                "Canvas edge id does not match any source Miro connector id or known generated edge id.",
                canvas_kind="edge",
                canvas_type="edge",
            )
        )

    if scale is not None:
        _append_geometry_drift_issues(
            issues,
            miro_root=miro_root,
            source_by_id=source_by_id,
            nodes_by_id=nodes_by_id,
            scale=scale,
        )

    return issues


def summarize_mapping(miro_root: Any, canvas_root: dict[str, Any], *, scale: float | None = None) -> dict[str, Any]:
    issues = audit_mapping_issues(miro_root, canvas_root, scale=scale)
    by_reason = Counter(issue.reason for issue in issues)
    actionable = [issue for issue in issues if issue.actionable]
    return {
        "total": len(issues),
        "actionable": len(actionable),
        "by_reason": dict(sorted(by_reason.items())),
        "examples": [asdict(issue) for issue in issues[:20]],
    }


def format_summary(summary: dict[str, Any], *, limit: int = DEFAULT_LIMIT) -> str:
    lines = [
        f"mapping_issues={summary['total']}",
        f"actionable={summary['actionable']}",
        "by_reason=" + ", ".join(f"{key}:{value}" for key, value in summary["by_reason"].items()),
    ]
    for issue in summary.get("examples", [])[:limit]:
        lines.append(
            f"- {issue['item_id']}:{issue['item_type']} reason={issue['reason']} "
            f"canvas={issue['canvas_kind']}:{issue['canvas_type']} {issue['detail']}"
        )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit source Miro item ids against Canvas node/edge identities.")
    parser.add_argument("miro_json", type=Path)
    parser.add_argument("canvas_json", type=Path)
    parser.add_argument("--scale", type=float)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary = summarize_mapping(load_json(args.miro_json), load_json(args.canvas_json), scale=args.scale)
    print(format_summary(summary, limit=args.limit))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
