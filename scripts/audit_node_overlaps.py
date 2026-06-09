from __future__ import annotations

import argparse
import copy
import html
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
DEFAULT_NODE_TYPES = ("text", "file", "link")
DEFAULT_MIN_OVERLAP_PX = 1.0
DEFAULT_LIMIT = 50


@dataclass(frozen=True)
class NodeRect:
    node_id: str
    node_type: str
    x: float
    y: float
    width: float
    height: float
    label: str = ""

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height


@dataclass(frozen=True)
class NodeOverlap:
    left: NodeRect
    right: NodeRect
    width: float
    height: float
    source_status: str | None = None
    source_width: float | None = None
    source_height: float | None = None
    source_reason: str = ""

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def source_area(self) -> float | None:
        if self.source_width is None or self.source_height is None:
            return None
        return self.source_width * self.source_height


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def split_csv(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        result.extend(part.strip() for part in value.split(",") if part.strip())
    return result


def text_snippet(node: dict[str, Any], *, max_len: int = 90) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    raw = str(
        node.get("text")
        or node.get("file")
        or node.get("url")
        or data.get("content")
        or data.get("title")
        or data.get("url")
        or ""
    )
    plain = re.sub(r"<[^>]+>", " ", raw)
    plain = html.unescape(re.sub(r"\s+", " ", plain)).strip()
    if len(plain) <= max_len:
        return plain
    return plain[: max_len - 1].rstrip() + "..."


def node_rect(node: dict[str, Any]) -> NodeRect | None:
    try:
        x = float(node["x"])
        y = float(node["y"])
        width = float(node["width"])
        height = float(node["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return NodeRect(
        node_id=str(node.get("id") or ""),
        node_type=str(node.get("type") or ""),
        x=x,
        y=y,
        width=width,
        height=height,
        label=text_snippet(node),
    )


def miro_source_rect_for_item(item: dict[str, Any], *, scale: float) -> tuple[NodeRect | None, str]:
    item_id = str(item.get("id") or "")
    geom = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    pos = item.get("position") if isinstance(item.get("position"), dict) else {}
    missing: list[str] = []

    try:
        width = float(geom.get("width"))
    except (TypeError, ValueError):
        width = 0.0
    try:
        height = float(geom.get("height"))
    except (TypeError, ValueError):
        height = 0.0
    try:
        center_x = float(pos.get("x"))
    except (TypeError, ValueError):
        center_x = 0.0
        missing.append("position.x")
    try:
        center_y = float(pos.get("y"))
    except (TypeError, ValueError):
        center_y = 0.0
        missing.append("position.y")

    if width <= 0:
        missing.append("geometry.width")
    if height <= 0:
        missing.append("geometry.height")
    if missing:
        return None, "missing_" + ",".join(missing)

    return (
        NodeRect(
            node_id=item_id,
            node_type=str(item.get("type") or ""),
            x=(center_x - width / 2.0) * scale,
            y=(center_y - height / 2.0) * scale,
            width=width * scale,
            height=height * scale,
            label=text_snippet(item),
        ),
        "",
    )


def build_miro_source_rects(miro_root: Any, *, scale: float) -> tuple[dict[str, NodeRect], dict[str, str]]:
    sys.path.insert(0, str(CONVERTER_DIR))
    from Converter import (  # noqa: WPS433
        CONTAINER_TYPES,
        FRAME_LIKE_TYPES,
        _frame_rect_unscaled,
        _normalize_child_pos_to_canvas,
        _rebase_from_diagram_local,
        _resolve_relative_positions_to_canvas_center,
        iter_objects,
    )

    all_items = [copy.deepcopy(item) for item in iter_objects(miro_root)]
    by_id: dict[str, dict[str, Any]] = {}
    containers: list[dict[str, Any]] = []
    container_rects_unscaled: dict[str, dict[str, float]] = {}
    diagram_rects_unscaled: dict[str, dict[str, float]] = {}

    for item in all_items:
        item_id = str(item.get("id") or "")
        if item_id:
            by_id[item_id] = item

        item_type = str(item.get("type") or "").lower()
        if item_type in CONTAINER_TYPES:
            containers.append(item)
            if item_type in FRAME_LIKE_TYPES:
                frame_rect = _frame_rect_unscaled(item)
                if frame_rect:
                    container_rects_unscaled[item_id] = frame_rect
                    if item_type == "diagram":
                        diagram_rects_unscaled[item_id] = frame_rect

    _resolve_relative_positions_to_canvas_center(by_id)

    for item in containers:
        item_id = str(item.get("id") or "")
        if item_id not in container_rects_unscaled:
            continue
        pos = item.get("position") or {}
        rel = str(pos.get("relativeTo") or "").lower()
        if rel not in ("parent_top_left", "parent_center"):
            continue
        parent = item.get("parent")
        if not isinstance(parent, dict) or parent.get("id") is None:
            continue
        parent_id = str(parent.get("id"))
        parent_rect = container_rects_unscaled.get(parent_id)
        if not parent_rect:
            parent_item = by_id.get(parent_id)
            if not parent_item:
                continue
            parent_pos = parent_item.get("position") or {}
            try:
                parent_cx = float(parent_pos.get("x") or 0.0)
                parent_cy = float(parent_pos.get("y") or 0.0)
            except Exception:
                continue
            parent_rect = {"x": parent_cx, "y": parent_cy, "width": 0.0, "height": 0.0}

        normalized = _normalize_child_pos_to_canvas(item, parent_rect)
        npos = normalized.get("position") or {}
        geom = item.get("geometry") or {}
        try:
            center_x = float(npos.get("x") or 0.0)
            center_y = float(npos.get("y") or 0.0)
            width = float(geom.get("width") or 0.0)
            height = float(geom.get("height") or 0.0)
        except Exception:
            continue
        if width > 0 and height > 0:
            container_rects_unscaled[item_id] = {
                "x": center_x - width / 2.0,
                "y": center_y - height / 2.0,
                "width": width,
                "height": height,
            }

    rects: dict[str, NodeRect] = {}
    missing: dict[str, str] = {}

    for original in all_items:
        item = original
        item_id = str(item.get("id") or "")
        item_type = str(item.get("type") or "").lower()
        if not item_id or item_type in CONTAINER_TYPES:
            continue

        parent = item.get("parent") or {}
        parent_id = str(parent.get("id") or "") if isinstance(parent, dict) else ""
        if parent_id and parent_id in container_rects_unscaled:
            pos = item.get("position") or {}
            rel = str(pos.get("relativeTo") or "").lower()
            if rel in ("parent_top_left", "parent_center"):
                item = _normalize_child_pos_to_canvas(item, container_rects_unscaled[parent_id])
        else:
            pos = item.get("position") or {}
            rel = str(pos.get("relativeTo") or "").lower()
            if rel == "canvas_center" and diagram_rects_unscaled:
                rebased = None
                best_overflow = None
                for diagram_rect in diagram_rects_unscaled.values():
                    candidate = _rebase_from_diagram_local(item, diagram_rect)
                    if not candidate:
                        continue
                    geom = candidate.get("geometry") or {}
                    try:
                        width = float(geom.get("width") or 0.0)
                        height = float(geom.get("height") or 0.0)
                        center_x = float((candidate.get("position") or {}).get("x") or 0.0)
                        center_y = float((candidate.get("position") or {}).get("y") or 0.0)
                    except Exception:
                        continue
                    left = center_x - width / 2.0
                    top = center_y - height / 2.0
                    overflow = 0.0
                    if left < diagram_rect["x"]:
                        overflow += diagram_rect["x"] - left
                    if left + width > diagram_rect["x"] + diagram_rect["width"]:
                        overflow += (left + width) - (diagram_rect["x"] + diagram_rect["width"])
                    if top < diagram_rect["y"]:
                        overflow += diagram_rect["y"] - top
                    if top + height > diagram_rect["y"] + diagram_rect["height"]:
                        overflow += (top + height) - (diagram_rect["y"] + diagram_rect["height"])
                    if best_overflow is None or overflow < best_overflow:
                        best_overflow = overflow
                        rebased = candidate
                if rebased is not None:
                    item = rebased

        rect, reason = miro_source_rect_for_item(item, scale=scale)
        if rect:
            rects[item_id] = rect
        elif reason:
            missing[item_id] = reason

    return rects, missing


def classify_source_overlap(
    left: NodeRect,
    right: NodeRect,
    *,
    source_rects: dict[str, NodeRect] | None,
    source_missing: dict[str, str] | None,
    min_overlap_width: float,
    min_overlap_height: float,
) -> tuple[str | None, float | None, float | None, str]:
    if source_rects is None:
        return None, None, None, ""

    left_source = source_rects.get(left.node_id)
    right_source = source_rects.get(right.node_id)
    if not left_source or not right_source:
        reasons = []
        for node in (left, right):
            reason = (source_missing or {}).get(node.node_id)
            if reason:
                reasons.append(f"{node.node_id}:{reason}")
            elif node.node_id not in source_rects:
                reasons.append(f"{node.node_id}:missing_source_item")
        return "source_geometry_unknown", None, None, "; ".join(reasons)

    source_w = min(left_source.right, right_source.right) - max(left_source.x, right_source.x)
    source_h = min(left_source.bottom, right_source.bottom) - max(left_source.y, right_source.y)
    if source_w > min_overlap_width and source_h > min_overlap_height:
        return "source_overlap", source_w, source_h, ""
    return "generated_overlap", max(source_w, 0.0), max(source_h, 0.0), ""


def audit_nodes(
    canvas: dict[str, Any],
    *,
    node_types: Iterable[str] = DEFAULT_NODE_TYPES,
    exclude_node_ids: Iterable[str] = (),
    min_overlap_width: float = DEFAULT_MIN_OVERLAP_PX,
    min_overlap_height: float = DEFAULT_MIN_OVERLAP_PX,
    min_overlap_area: float = 0.0,
    source_rects: dict[str, NodeRect] | None = None,
    source_missing: dict[str, str] | None = None,
) -> list[NodeOverlap]:
    allowed_types = {str(t) for t in node_types}
    excluded_ids = {str(node_id) for node_id in exclude_node_ids}
    rects: list[NodeRect] = []
    for node in canvas.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if str(node.get("type") or "") not in allowed_types:
            continue
        if str(node.get("id") or "") in excluded_ids:
            continue
        rect = node_rect(node)
        if rect:
            rects.append(rect)

    overlaps: list[NodeOverlap] = []
    for idx, left in enumerate(rects):
        for right in rects[idx + 1:]:
            overlap_w = min(left.right, right.right) - max(left.x, right.x)
            overlap_h = min(left.bottom, right.bottom) - max(left.y, right.y)
            if overlap_w <= min_overlap_width or overlap_h <= min_overlap_height:
                continue
            source_status, source_w, source_h, source_reason = classify_source_overlap(
                left,
                right,
                source_rects=source_rects,
                source_missing=source_missing,
                min_overlap_width=min_overlap_width,
                min_overlap_height=min_overlap_height,
            )
            overlap = NodeOverlap(
                left=left,
                right=right,
                width=overlap_w,
                height=overlap_h,
                source_status=source_status,
                source_width=source_w,
                source_height=source_h,
                source_reason=source_reason,
            )
            if overlap.area <= min_overlap_area:
                continue
            overlaps.append(overlap)

    return sorted(overlaps, key=lambda o: o.area, reverse=True)


def overlap_to_dict(overlap: NodeOverlap) -> dict[str, Any]:
    return {
        "left": {
            "id": overlap.left.node_id,
            "type": overlap.left.node_type,
            "x": overlap.left.x,
            "y": overlap.left.y,
            "width": overlap.left.width,
            "height": overlap.left.height,
            "label": overlap.left.label,
        },
        "right": {
            "id": overlap.right.node_id,
            "type": overlap.right.node_type,
            "x": overlap.right.x,
            "y": overlap.right.y,
            "width": overlap.right.width,
            "height": overlap.right.height,
            "label": overlap.right.label,
        },
        "overlap_width": overlap.width,
        "overlap_height": overlap.height,
        "overlap_area": overlap.area,
        "source_status": overlap.source_status,
        "source_overlap_width": overlap.source_width,
        "source_overlap_height": overlap.source_height,
        "source_overlap_area": overlap.source_area,
        "source_reason": overlap.source_reason,
    }


def format_overlap(index: int, overlap: NodeOverlap) -> str:
    left = overlap.left
    right = overlap.right
    source = ""
    if overlap.source_status:
        if overlap.source_width is None or overlap.source_height is None:
            source = f" source={overlap.source_status}"
        else:
            source = (
                f" source={overlap.source_status}"
                f" source_overlap={overlap.source_width:.2f}x{overlap.source_height:.2f}"
            )
        if overlap.source_reason:
            source += f" reason={overlap.source_reason}"
    return (
        f"{index}. {left.node_id}:{left.node_type} <-> {right.node_id}:{right.node_type} "
        f"overlap={overlap.width:.2f}x{overlap.height:.2f} area={overlap.area:.2f}{source}\n"
        f"   left=({left.x:.2f},{left.y:.2f},{left.width:.2f},{left.height:.2f}) {left.label!r}\n"
        f"   right=({right.x:.2f},{right.y:.2f},{right.width:.2f},{right.height:.2f}) {right.label!r}"
    )


def audit_canvas_path(
    canvas_path: Path,
    *,
    node_types: Iterable[str],
    exclude_node_ids: Iterable[str],
    min_overlap_width: float,
    min_overlap_height: float,
    min_overlap_area: float,
    source_rects: dict[str, NodeRect] | None = None,
    source_missing: dict[str, str] | None = None,
) -> list[NodeOverlap]:
    canvas = load_json(canvas_path)
    if not isinstance(canvas, dict):
        raise ValueError(f"{canvas_path} is not a JSON object")
    return audit_nodes(
        canvas,
        node_types=node_types,
        exclude_node_ids=exclude_node_ids,
        min_overlap_width=min_overlap_width,
        min_overlap_height=min_overlap_height,
        min_overlap_area=min_overlap_area,
        source_rects=source_rects,
        source_missing=source_missing,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit JSONCanvas node rectangle overlaps.")
    parser.add_argument("canvas", nargs="+", type=Path, help="One or more .canvas files to audit.")
    parser.add_argument("--miro-json", type=Path, help="Optional source Miro JSON for source/generated classification.")
    parser.add_argument("--scale", type=float, default=1.0, help="Scale used to convert the source Miro JSON.")
    parser.add_argument(
        "--types",
        nargs="+",
        default=list(DEFAULT_NODE_TYPES),
        help="Node types to compare. Accepts space- or comma-separated values. Default: text file link.",
    )
    parser.add_argument("--exclude-node", action="append", default=[], help="Node id to exclude. Repeatable.")
    parser.add_argument("--min-overlap-width", type=float, default=DEFAULT_MIN_OVERLAP_PX)
    parser.add_argument("--min-overlap-height", type=float, default=DEFAULT_MIN_OVERLAP_PX)
    parser.add_argument("--min-overlap-area", type=float, default=0.0)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Maximum overlaps to print per canvas.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--warn-only", action="store_true", help="Return exit code 0 even if overlaps are found.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    node_types = split_csv(args.types)
    exclude_node_ids = split_csv(args.exclude_node)
    source_rects = None
    source_missing = None
    if args.miro_json:
        source_rects, source_missing = build_miro_source_rects(load_json(args.miro_json), scale=args.scale)

    all_results: list[dict[str, Any]] = []
    found_any = False
    status_totals: dict[str, int] = {}

    for canvas_path in args.canvas:
        overlaps = audit_canvas_path(
            canvas_path,
            node_types=node_types,
            exclude_node_ids=exclude_node_ids,
            min_overlap_width=args.min_overlap_width,
            min_overlap_height=args.min_overlap_height,
            min_overlap_area=args.min_overlap_area,
            source_rects=source_rects,
            source_missing=source_missing,
        )
        found_any = found_any or bool(overlaps)
        shown = overlaps[: max(args.limit, 0)]
        status_counts: dict[str, int] = {}
        for overlap in overlaps:
            if overlap.source_status:
                status_counts[overlap.source_status] = status_counts.get(overlap.source_status, 0) + 1
                status_totals[overlap.source_status] = status_totals.get(overlap.source_status, 0) + 1

        if args.json:
            all_results.append(
                {
                    "canvas": str(canvas_path),
                    "total_overlaps": len(overlaps),
                    "reported_overlaps": len(shown),
                    "node_types": node_types,
                    "source": {
                        "miro_json": str(args.miro_json) if args.miro_json else None,
                        "scale": args.scale if args.miro_json else None,
                        "status_counts": status_counts,
                    },
                    "thresholds": {
                        "min_overlap_width": args.min_overlap_width,
                        "min_overlap_height": args.min_overlap_height,
                        "min_overlap_area": args.min_overlap_area,
                    },
                    "overlaps": [overlap_to_dict(overlap) for overlap in shown],
                }
            )
            continue

        if overlaps:
            source_summary = ""
            if status_counts:
                source_summary = "; " + ", ".join(f"{key}:{value}" for key, value in sorted(status_counts.items()))
            print(f"FAIL {canvas_path}: {len(overlaps)} overlap(s), showing {len(shown)}{source_summary}")
            for idx, overlap in enumerate(shown, start=1):
                print(format_overlap(idx, overlap))
        else:
            print(f"OK {canvas_path}: no overlaps for types={','.join(node_types)}")

    if args.json:
        print(json.dumps({"results": all_results}, ensure_ascii=False, indent=2))

    return 0 if args.warn_only or not found_any else 1


if __name__ == "__main__":
    raise SystemExit(main())
