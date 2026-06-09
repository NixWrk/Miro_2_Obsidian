from __future__ import annotations

import argparse
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


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

    @property
    def area(self) -> float:
        return self.width * self.height


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def split_csv(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        result.extend(part.strip() for part in value.split(",") if part.strip())
    return result


def text_snippet(node: dict[str, Any], *, max_len: int = 90) -> str:
    raw = str(node.get("text") or node.get("file") or node.get("url") or "")
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


def audit_nodes(
    canvas: dict[str, Any],
    *,
    node_types: Iterable[str] = DEFAULT_NODE_TYPES,
    exclude_node_ids: Iterable[str] = (),
    min_overlap_width: float = DEFAULT_MIN_OVERLAP_PX,
    min_overlap_height: float = DEFAULT_MIN_OVERLAP_PX,
    min_overlap_area: float = 0.0,
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
            overlap = NodeOverlap(left=left, right=right, width=overlap_w, height=overlap_h)
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
    }


def format_overlap(index: int, overlap: NodeOverlap) -> str:
    left = overlap.left
    right = overlap.right
    return (
        f"{index}. {left.node_id}:{left.node_type} <-> {right.node_id}:{right.node_type} "
        f"overlap={overlap.width:.2f}x{overlap.height:.2f} area={overlap.area:.2f}\n"
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
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit JSONCanvas node rectangle overlaps.")
    parser.add_argument("canvas", nargs="+", type=Path, help="One or more .canvas files to audit.")
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
    all_results: list[dict[str, Any]] = []
    found_any = False

    for canvas_path in args.canvas:
        overlaps = audit_canvas_path(
            canvas_path,
            node_types=node_types,
            exclude_node_ids=exclude_node_ids,
            min_overlap_width=args.min_overlap_width,
            min_overlap_height=args.min_overlap_height,
            min_overlap_area=args.min_overlap_area,
        )
        found_any = found_any or bool(overlaps)
        shown = overlaps[: max(args.limit, 0)]

        if args.json:
            all_results.append(
                {
                    "canvas": str(canvas_path),
                    "total_overlaps": len(overlaps),
                    "reported_overlaps": len(shown),
                    "node_types": node_types,
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
            print(f"FAIL {canvas_path}: {len(overlaps)} overlap(s), showing {len(shown)}")
            for idx, overlap in enumerate(shown, start=1):
                print(format_overlap(idx, overlap))
        else:
            print(f"OK {canvas_path}: no overlaps for types={','.join(node_types)}")

    if args.json:
        print(json.dumps({"results": all_results}, ensure_ascii=False, indent=2))

    return 0 if args.warn_only or not found_any else 1


if __name__ == "__main__":
    raise SystemExit(main())
